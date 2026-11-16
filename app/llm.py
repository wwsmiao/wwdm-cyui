# -*- coding: utf-8 -*-
"""本地 Qwen3-VL 文本工作流（ComfyUI TextGenerateV2）

用途：
- 提示词润色：纯文本进 → 润色后的提示词出
- 提示词反推：单张参考图进 → 画面描述提示词出

节点链（对应 app/presets/qwen3vl_text_gen.json）：
    CLIPLoader(qwen3vl_4b_fp8_scaled · type=ideogram4)
      → TextGenerateV2（system_prompt + 采样参数）
      → PreviewAny（OUTPUT_NODE，把文本带进 history）

两个容易踩的坑（已在本模块处理）：
1. TextGenerateV2 的 system_prompt 只在 use_default_template=True 时生效，
   预设里是 false（节点源码会把 system_prompt 置空），这里强制改回 True。
2. 单图输入是 AUTOGROW 动态输入，API 键名是 images.image1（无下划线）。
"""
import copy
import json
import os
import random
import re
import time

from . import comfy, config

_PRESET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets", "qwen3vl_text_gen.json")

with open(_PRESET_FILE, "r", encoding="utf-8") as _f:
    PRESET = json.load(_f)

DEFAULT_MODEL = PRESET["5"]["inputs"]["clip_name"]
DEFAULT_CLIP_TYPE = PRESET["5"]["inputs"]["type"]
DEFAULT_POLISH_SYSTEM = PRESET["12"]["inputs"]["value"]

# 反推：单图 → 一段可直接用的画面提示词（默认中文，符合本应用的中文工作流）
DEFAULT_REVERSE_SYSTEM = """# 角色
你是图像反推提示词 Agent。用户会给你一张图片，你要输出一段可以直接用于 Qwen-Image 生成的高质量画面提示词。

# 观察顺序
主体与数量 → 动作/表情 → 服装/材质/配饰 → 环境与背景 → 构图与视角 → 镜头与焦段 → 光线 → 色彩 → 风格 → 画质细节 → 画面中的文字。

# 规则
- 只描述画面中真实存在的内容，不臆造人物身份、品牌、logo 或文字。
- 画面里出现文字时，用引号原样写出。
- 不写负面提示词，不写参数（如 --ar、steps），不做解释。
- 画面信息稀疏时就写得简洁，不要堆砌空泛的质量词。

# 输出
只输出一段最终提示词：中文为主，逗号分隔短语，约 80~200 字，不要标题、不要分点、不要 Markdown、不要“这张图片”之类的引导语。"""

DEFAULT_MAX_LENGTH = 512

# 多模态润色：带参考图的模式在用户模板之后追加的任务说明（不改用户自定义模板）
MODE_APPENDIX = {
    "img2img": """

# 本次任务附加说明（图生图润色）
用户消息已附带参考图（图1）。请先理解参考图的主体、构图、光影与风格，再润色用户的修改描述：
- 润色结果必须明确保持图1的主体、构图与镜头角度，只改变用户要求修改的部分；
- 涉及未提及的细节时，按参考图的实际内容补全，不要凭空臆造。""",
    "edit": """

# 本次任务附加说明（图片编辑润色）
用户消息已附带参考图（按上传顺序为 图1、图2…）。润色结果应是一段指令式编辑描述：
- 正确引用 图1、图2… 编号，说明对哪张图做什么改动；
- 输出以图1的构图与尺寸为准；涉及多图时说明各图的角色与合成方式。""",
    "inpaint": """

# 本次任务附加说明（局部重绘润色）
用户已用遮罩标出重绘区域，并附上原图（图1）。润色结果只需描述遮罩区域内要变成的内容：
- 描述新内容的光影、材质与透视，使其与周围未遮罩区域无缝衔接；
- 明确未遮罩区域保持像素级不变。""",
}

# 多模态润色最多附带的参考图数（4B 模型上下文有限，太多图会拖慢且质量下降）
MAX_POLISH_IMAGES = 4

TIMEOUT = 420   # 首次加载 4B 权重约 1 分钟；长文本（max_length 4096）也可能跑到 3~5 分钟


def default_settings():
    return {
        "model": DEFAULT_MODEL,
        "max_length": DEFAULT_MAX_LENGTH,
        "thinking": False,
        "temperature": 0.7,
        "top_k": 64,
        "top_p": 0.95,
        "min_p": 0.05,
        "repetition_penalty": 1.05,
        "presence_penalty": 0.0,
        "systems": {
            "polish": DEFAULT_POLISH_SYSTEM,
            "reverse": DEFAULT_REVERSE_SYSTEM,
        },
    }


def settings():
    """默认值 ← data/config.json 里用户改过的部分"""
    out = default_settings()
    saved = config.get("llm") or {}
    if not isinstance(saved, dict):
        return out
    for k in ("model", "max_length", "thinking", "temperature", "top_k", "top_p",
              "min_p", "repetition_penalty", "presence_penalty"):
        if saved.get(k) is not None:
            out[k] = saved[k]
    systems = saved.get("systems")
    if isinstance(systems, dict):
        if isinstance(systems.get("polish"), str) and systems["polish"].strip():
            out["systems"]["polish"] = systems["polish"]
        if isinstance(systems.get("reverse"), str) and systems["reverse"].strip():
            out["systems"]["reverse"] = systems["reverse"]
    return out


def save_settings(patch):
    """保存用户改过的 LLM 设置（只认白名单字段），返回最新设置"""
    cur = settings()
    if not isinstance(patch, dict):
        return cur
    for k in ("model", "thinking"):
        if k in patch and patch[k] is not None:
            cur[k] = str(patch[k]) if k == "model" else bool(patch[k])
    for k in ("max_length", "top_k"):
        if k in patch:
            try:
                cur[k] = max(1, min(4096 if k == "max_length" else 1000, int(patch[k])))
            except Exception:
                pass
    for k in ("temperature", "top_p", "min_p", "repetition_penalty", "presence_penalty"):
        if k in patch:
            try:
                cur[k] = max(0.0, min(5.0, float(patch[k])))
            except Exception:
                pass
    systems = patch.get("systems")
    if isinstance(systems, dict):
        for key in ("polish", "reverse"):
            v = systems.get(key)
            if isinstance(v, str) and v.strip():
                cur["systems"][key] = v.strip()[:8000]
    config.set_many({"llm": cur})
    return settings()


def _fill_placeholders(system, prompt):
    """把润色模板里的 {{变量}} 换成具体值：用户提示词统一从用户消息读取，避免重复塞两份"""
    s = system or ""
    s = s.replace("{{user_prompt}}", "（见用户消息，请直接处理）")
    s = re.sub(r"\{\{model[^}]*\}\}", "ComfyUI / Qwen-Image", s)
    s = re.sub(r"\{\{aspect_ratio[^}]*\}\}", "未指定", s)
    s = re.sub(r"\{\{style[^}]*\}\}", "未指定", s)
    s = re.sub(r"\{\{must_keep[^}]*\}\}", "无", s)
    s = re.sub(r"\{\{avoid[^}]*\}\}", "无", s)
    s = re.sub(r"\{\{language[^}]*\}\}", "与用户输入语言一致", s)
    s = re.sub(r"\{\{[^}]*\}\}", "", s)
    return s.strip() or DEFAULT_POLISH_SYSTEM


def _merge_cfg(cfg):
    """当前设置 + 本次请求临时覆盖（systems 做浅合并，避免只传一半就丢默认）"""
    s = settings()
    for k, v in (cfg or {}).items():
        if k == "systems" and isinstance(v, dict):
            for kk, vv in v.items():
                if isinstance(vv, str) and vv.strip():
                    s["systems"][kk] = vv
        elif v is not None:
            s[k] = v
    return s


def build(system, prompt, images=None, cfg=None):
    """在当前预设的基础上生成 API prompt（只改文本 / 系统提示词 / 单图 / 采样参数）"""
    cfg = _merge_cfg(cfg)
    wf = copy.deepcopy(PRESET)

    wf["5"]["inputs"]["clip_name"] = cfg.get("model") or DEFAULT_MODEL
    wf["5"]["inputs"]["type"] = DEFAULT_CLIP_TYPE
    wf["12"]["inputs"]["value"] = system or ""

    node = wf["10"]["inputs"]
    node["prompt"] = prompt or ""
    node["max_length"] = int(cfg.get("max_length") or DEFAULT_MAX_LENGTH)
    node["thinking"] = bool(cfg.get("thinking"))
    # 系统提示词只有在启用默认模板时才生效（节点 tooltip 明确写了这一点）
    node["use_default_template"] = True
    node["mtp"] = "auto"
    node["system_prompt"] = ["12", 0]
    node["sampling_mode"] = "on"
    node["sampling_mode.temperature"] = float(cfg.get("temperature") or 0.7)
    node["sampling_mode.top_k"] = int(cfg.get("top_k") or 64)
    node["sampling_mode.top_p"] = float(cfg.get("top_p") or 0.95)
    node["sampling_mode.min_p"] = float(cfg.get("min_p") or 0.05)
    node["sampling_mode.repetition_penalty"] = float(cfg.get("repetition_penalty") or 1.05)
    node["sampling_mode.presence_penalty"] = float(cfg.get("presence_penalty") or 0.0)
    node["sampling_mode.seed"] = random.randint(1, 2 ** 31 - 1)

    # 参考图：TextGenerateV2 的 AUTOGROW 输入名为 images.image1..N（无下划线），
    # 多模态润色（图生图 / 编辑 / 局部重绘）与反推共用同一通道
    for i, img in enumerate((images or [])[:MAX_POLISH_IMAGES], 1):
        if img:
            wf["loadimg_%d" % i] = {"class_type": "LoadImage", "inputs": {"image": img}}
            node["images.image%d" % i] = ["loadimg_%d" % i, 0]

    wf["7"] = {"class_type": "PreviewAny", "inputs": {"source": ["10", 0]}}
    return wf


def _extract_text(outputs):
    """history.outputs 里取生成文本：优先 PreviewAny(节点 7)，否则取最长字符串"""
    chunks = []

    def walk(v):
        if isinstance(v, str):
            if v.strip() and v.strip() not in ("None", "none"):
                chunks.append(v.strip())
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    walk((outputs or {}).get("7"))
    if not chunks:
        walk(outputs)
    return max(chunks, key=len) if chunks else ""


def _clean(text):
    """去掉模型偶发的引导语、Markdown 围栏与包裹引号"""
    t = (text or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    for prefix in ("最终提示词：", "最终提示词:", "提示词：", "提示词:", "Output:", "output:"):
        if t.startswith(prefix):
            t = t[len(prefix):].strip()
    t = t.replace("**", "").strip()
    if len(t) > 1 and t[0] in "“\"'" and t[-1] in "”\"'":
        t = t[1:-1].strip()
    return t


def _run(wf, label):
    t0 = time.time()
    res = comfy.queue_prompt(wf)
    pid = res.get("prompt_id")
    if not pid:
        raise comfy.ComfyError("ComfyUI 未返回 prompt_id：%s" % json.dumps(res, ensure_ascii=False)[:200])
    if res.get("node_errors"):
        detail = json.dumps(res["node_errors"], ensure_ascii=False)[:400]
        raise comfy.ComfyError("节点校验失败：%s" % detail)
    comfy.log("%s任务提交 %s" % (label, pid[:8]), "INFO")

    deadline = time.time() + TIMEOUT
    while time.time() < deadline:
        time.sleep(1)
        try:
            hist = comfy.history(pid)
        except Exception:
            continue
        rec = (hist or {}).get(pid)
        if not rec:
            continue
        st = rec.get("status") or {}
        if st.get("status_str") == "error" or st.get("completed") is False:
            detail = ""
            for m in st.get("messages") or []:
                if isinstance(m, list) and len(m) > 1 and isinstance(m[1], dict):
                    detail = m[1].get("exception_message") or detail
            raise comfy.ComfyError(detail or "本地文本工作流执行失败")
        if st.get("completed"):
            text = _clean(_extract_text(rec.get("outputs") or {}))
            if not text:
                raise comfy.ComfyError("工作流完成但没有取到文本（检查 PreviewAny 节点）")
            cost = round(time.time() - t0, 1)
            comfy.log("%s完成 · %d 字 · %.1fs" % (label, len(text), cost), "OK")
            return text, cost
    raise comfy.ComfyError("本地文本工作流超时（%d 秒）" % TIMEOUT)


def polish_system(prompt, cfg=None, mode=None):
    """润色用的系统提示词（占位符已替换），DeepSeek 远程润色也复用同一份。
    mode 为 img2img / edit / inpaint 时在用户模板之后追加多模态任务说明。"""
    cfg = _merge_cfg(cfg)
    base = _fill_placeholders(cfg["systems"].get("polish"), prompt)
    appendix = MODE_APPENDIX.get(mode) if mode else None
    if appendix:
        base = base.rstrip() + appendix
    return base


def polish(prompt, cfg=None, images=None, mode=None):
    """提示词润色：文生图为纯文本；带参考图（图生图 / 编辑 / 局部重绘）时
    把参考图一起传给 Qwen3-VL，模型看着图润色，结果与参考图对齐。"""
    cfg = _merge_cfg(cfg)
    imgs = [x for x in (images or []) if x][:MAX_POLISH_IMAGES]
    label = "AI 润色" + ("（多模态 %d 图）" % len(imgs) if imgs else "")
    return _run(build(polish_system(prompt, cfg, mode), (prompt or "").strip(), imgs, cfg), label)


def reverse(image, hint="", cfg=None):
    """提示词反推：单张参考图（ComfyUI input 目录里的文件名）"""
    if not image:
        raise comfy.ComfyError("请先上传一张参考图，再进行反推")
    cfg = _merge_cfg(cfg)
    system = cfg["systems"].get("reverse") or DEFAULT_REVERSE_SYSTEM
    text = (hint or "").strip() or "请反推这张图片的画面提示词。"
    return _run(build(system, text, [image], cfg), "AI 反推")
