# -*- coding: utf-8 -*-
"""DeepSeek 图片助手：工具调用（生成 / 放大 / 提示词 / 批量）+ 技能清单

前端把 DeepSeek Key 与模型一起传进来（Key 只存在浏览器），
这里只负责组 prompt、调工具、返回结果。
生成类工具会走和 /api/generate 相同的消息 + comfy.track 流程，
所以结果会自动出现在应用的对话与图库里。
"""
import io
import json
import math
import os
import re
import threading
import time
import uuid
import concurrent.futures
from urllib.parse import parse_qs, urlparse

import requests
from PIL import Image, ImageOps

from . import RESULTS_DIR, comfy, store, upscale, llm, workflows

# ---------------------------------------------------------------- 技能清单
# mode 只有两种真实语义（对齐 Qwen-Image 2.1 的官方模板）：
#   text2img = 不接输入图，从零生成（EmptyLatentImage + 提示词）
#   edit     = 接输入图到 image_1..N，靠参考图 latent 锁住主体/构图，指令式改写
# 已取消 img2img：那是「把原图编码后重新采样」的老路子，Qwen 2.1 的编辑能力
# 本身依赖参考图 latent，走 img2img 会重画细节、丢身份。
# 另外 upscale（SeedVR2 外部放大）/ prompt（纯文本）不经过图像采样。
SKILLS = [
    {"id": "ecom_white", "name": "电商白底图", "cat": "电商", "mode": "edit", "images": 1,
     "desc": "商品去背景换纯白摄影棚，保留细节与柔和投影",
     "prompt": "去掉背景，把商品放到纯白摄影棚背景上，柔和接触阴影，保留商品细节、颜色与材质，电商主图质感"},
    {"id": "ecom_scene", "name": "商品场景图", "cat": "电商", "mode": "edit", "images": 1,
     "desc": "把商品放进指定场景，商业摄影光影",
     "prompt": "把图1的商品放进{text}的场景中，商业摄影布光，接触阴影自然，保留商品细节与颜色"},
    {"id": "model_outfit", "name": "模特换装", "cat": "电商", "mode": "edit", "images": 2,
     "desc": "图1 人物换上图2 的服装，保持姿势与背景",
     "prompt": "把图1中人物的服装替换为图2展示的服装，保持图1的人物身份、姿势、背景与光影不变，衣料褶皱贴合身体"},
    {"id": "hair_color", "name": "换发色 / 发型", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "改发色或发型，保留五官与光线",
     "prompt": "把图1人物的发型/发色改为{text}，保留五官、妆容与光线方向，发丝边缘自然"},
    {"id": "face_swap", "name": "换脸", "cat": "图片处理", "mode": "edit", "images": 2,
     "desc": "图2 的脸替换到图1（原生模型易漂移，建议配换脸 LoRA）",
     "prompt": "把图1人物的面部替换为图2人物的面部特征，保持图1的姿态、发型、服装、背景与光影，肤色自然过渡"},
    {"id": "cutout", "name": "抠图 / 透明底", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "主体抠出，透明背景，边缘干净",
     "prompt": "Remove the background, and output a PNG image. 输出透明背景，边缘干净，保留头发与半透明细节"},
    {"id": "bg_replace", "name": "换背景", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "保留主体，背景换成指定内容",
     "prompt": "保留图1的主体与光影，把背景替换为{text}，人物与背景的接触阴影自然"},
    {"id": "outpaint", "name": "扩图 / 画面延展", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "把画面向四周延展或换成更宽/更高的画幅，补齐缺失区域",
     "prompt": "把图1的画面向外延展到目标画幅，补齐延展区域，保持原有主体、透视、光影、色调与画风完全一致，接缝自然无痕"},
    {"id": "watermark_remove", "name": "去水印 / 去杂物", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "去掉水印、文字、路人等干扰元素（要只动涂抹区域用界面「局部重绘」更稳）",
     "prompt": "去掉画面中的水印、文字与多余杂物，补齐背景纹理，保持其余内容不变"},
    {"id": "old_photo_fix", "name": "老照片修复", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "修复划痕噪点、增强清晰度，保留人物（建议配 Restore LoRA）",
     "prompt": "修复老照片的划痕、噪点与褪色，提升清晰度与细节，严格保留原人物五官、身份与构图，色彩自然还原"},
    {"id": "portrait_retouch", "name": "人像精修", "cat": "图片处理", "mode": "edit", "images": 1,
     "desc": "磨皮但保留皮肤质感，微调光影",
     "prompt": "人像精修：保留皮肤纹理的自然磨皮，柔化阴影，提亮眼神光，保持五官与身份不变"},
    {"id": "film_grade", "name": "电影感调色", "cat": "影视", "mode": "edit", "images": 1,
     "desc": "青橙色调、柔和对比、胶片颗粒",
     "prompt": "电影感调色：青橙对比色调，柔和的高光滚降，细腻胶片颗粒，保持构图、主体与身份不变"},
    {"id": "storyboard", "name": "电影分镜", "cat": "影视", "mode": "text2img", "images": 0,
     "desc": "按描述生成宽银幕分镜；有上一帧时可接图做镜头延展",
     "prompt": "{text}，电影分镜画面，2.39:1 宽银幕构图，叙事性布光，胶片质感"},
    {"id": "ecom_poster", "name": "电商海报", "cat": "电商", "mode": "text2img", "images": 0,
     "desc": "带中文标题的商业海报（真正从零创作的 T2I）",
     "prompt": "{text}，电商海报设计，中文主标题清晰可读，留白排版，高级商业质感"},
    {"id": "style_transfer", "name": "风格迁移", "cat": "生图", "mode": "edit", "images": 1,
     "desc": "保留构图与主体，换成指定画风",
     "prompt": "保留图1的构图、主体位置与画面结构，把整体风格改为{text}，色彩与笔触统一"},
    {"id": "upscale_4k", "name": "高清放大", "cat": "生图", "mode": "upscale", "images": 1,
     "desc": "SeedVR2 放大，默认 2 倍，可指定长边像素",
     "prompt": ""},
    {"id": "prompt_polish", "name": "提示词润色", "cat": "提示词", "mode": "prompt", "images": 0,
     "desc": "把口语描述扩写成高质量提示词",
     "prompt": ""},
    {"id": "prompt_reverse", "name": "图片反推", "cat": "提示词", "mode": "prompt", "images": 1,
     "desc": "看图反推出可复用的画面提示词",
     "prompt": ""},
    {"id": "batch_cutout", "name": "批量抠图", "cat": "批量", "mode": "edit", "images": 1,
     "desc": "整个文件夹批量抠图透明底",
     "prompt": "Remove the background, and output a PNG image. 输出透明背景，边缘干净，保留头发与半透明细节"},
    {"id": "batch_style", "name": "批量风格化", "cat": "批量", "mode": "edit", "images": 1,
     "desc": "整个文件夹批量换风格",
     "prompt": "保留原图构图与主体，把整体风格改为{text}，色彩统一"},
]

SKILL_MAP = {s["id"]: s for s in SKILLS}
BATCHES = {}
_BATCH_LOCK = threading.Lock()


# ---------------------------------------------------------------- 尺寸解析
# 用户说「竖版 / 16:9 / 1360x768」都要能落到画布上。以前只有一个 size 字段
# 且只认 "宽x高"，模型于是干脆不传，所有请求都退化成 1024×1024。
_SIZE_ALIASES = {
    "正方形": (1, 1), "方形": (1, 1), "方图": (1, 1), "头像": (1, 1), "square": (1, 1),
    "竖版": (2, 3), "竖图": (2, 3), "竖屏": (9, 16), "手机竖": (9, 16), "portrait": (2, 3),
    "横版": (3, 2), "横图": (3, 2), "横屏": (16, 9), "壁纸": (16, 9), "landscape": (3, 2),
    "宽银幕": (239, 100), "电影分镜": (239, 100), "cinematic": (239, 100),
    "海报": (2, 3),
}

# 提示词里出现「16:9 / 2.39:1 / 竖版」时兜底取尺寸；数字两侧禁止紧邻小数点，
# 否则 storyboard 模板里的 "2.39:1" 会被误读成 "39:1"。
_TEXT_RATIO = re.compile(r"(?<![\d.])(\d{1,2})\s*[:：]\s*(\d{1,2})(?![\d.])")
_TEXT_PIXEL = re.compile(r"(?<![\d.])(\d{3,4})\s*[x×*]\s*(\d{3,4})(?![\d.])")


def _align_px(v):
    """对齐到 8 的倍数（Qwen latent 步长就是 8）并夹进 256~2048（12G 显存的稳妥区间）。"""
    n = int(round(float(v) / 8.0)) * 8
    return max(256, min(2048, n))


def _ratio_to_px(aw, ah, budget=1024):
    try:
        aw, ah = float(aw), float(ah)
    except Exception:
        return None
    if aw <= 0 or ah <= 0:
        return None
    r = aw / ah
    if r <= 0.05 or r >= 20:
        return None
    w = math.sqrt(float(budget) * budget * r)
    return _align_px(w), _align_px(w / r)


def parse_size(spec, budget=1024):
    """把尺寸描述解析成 (w, h)；识别不了返回 None。

    支持：1024x1024 · 1024×1536 · 1920*1080 · 16:9 · 3:2 · 竖版 · 横版 · 方形 · 海报
    """
    s = str(spec or "").strip().lower()
    if not s:
        return None
    s = s.replace("×", "x").replace("*", "x").replace("：", ":").replace(" ", "")
    m = re.search(r"(\d{2,4})x(\d{2,4})", s)
    if m:
        return _align_px(m.group(1)), _align_px(m.group(2))
    m = re.search(r"(\d{1,2}(?:\.\d+)?):(\d{1,2}(?:\.\d+)?)", s)
    if m:
        hit = _ratio_to_px(m.group(1), m.group(2), budget)
        if hit:
            return hit
    for k, (aw, ah) in _SIZE_ALIASES.items():
        if k in s:
            hit = _ratio_to_px(aw, ah, budget)
            if hit:
                return hit
    return None


def size_from_text(text, budget=1024):
    """模型没传 size 时，从提示词里捞一次尺寸线索（最后一道兜底）。"""
    t = str(text or "")
    if not t:
        return None
    m = _TEXT_PIXEL.search(t)
    if m:
        return _align_px(m.group(1)), _align_px(m.group(2))
    m = _TEXT_RATIO.search(t)
    if m:
        hit = _ratio_to_px(m.group(1), m.group(2), budget)
        if hit:
            return hit
    low = t.lower()
    for k, (aw, ah) in _SIZE_ALIASES.items():
        if k in low:
            hit = _ratio_to_px(aw, ah, budget)
            if hit:
                return hit
    return None


# ---------------------------------------------------------------- 模式判定
# Qwen-Image 2.1 是「生成与编辑合一」：同一套权重，靠「有没有接输入图」区分任务，
# 官方模板只有 文生图 / 图像编辑（含背景移除）。所以这里只保留两条真实路径。
_MODE_ALIAS = {
    "img2img": "edit", "i2i": "edit", "image2image": "edit", "image_edit": "edit",
    "inpaint": "edit", "edit": "edit",
    "t2i": "text2img", "txt2img": "text2img", "text2img": "text2img",
}


def resolve_mode(mode, images, text):
    """决定真正的生成模式：有输入图 = edit，没有 = text2img。

    以前助手让模型在三四个模式里自己挑，于是「扩图 / 老照片修复 / 风格迁移」
    这类「保留原图 + 改内容」的任务经常被错判成 img2img。img2img 是把原图
    编码后重新采样，会重画细节、丢人物身份；Qwen 2.1 正解是把原图接到
    image_1 走编辑链路。这里直接把 img2img/inpaint 一律收敛成 edit。
    """
    n = len(images or [])
    m = (mode or "").strip().lower()
    if m in ("", "auto", "smart", "智能"):
        m = workflows.auto_route(text or "", n)
    m = _MODE_ALIAS.get(m, "text2img")
    if n == 0:
        return "text2img"      # 没有输入图：唯一的从零生成路径
    return "edit"              # 有输入图：一律走官方图像编辑链路


# 用户这句话里到底有没有「要好几张」的意思：没有就强制 count=1
_MULTI_RE = re.compile(r"(?:两|二|三|四|五|六|七|八|九|[2-9])\s*(?:张|幅|版|个版本)|多张|多来几|各来一|各生成")
_CTX_ALLOW_MULTI = False
# 用户在这轮对话里「手选锁定」的 LoRA：每轮都会带上，AI 不能取消
_CTX_USER_LORAS = []
# 用户在参数抽屉里选的采样方案（turbo / viggle / standard）：
# 助手生成时继承它，否则在界面切到 Viggle 也没用，加速 LoRA 永远挂不上
_CTX_SAMPLING = ""
# 前端上报的整份工作台状态：技能 / 尺寸 / 参数 / LoRA / 润色开关 / 当前视图。
# 助手据此「按用户已有的设置」生成，并可以把改动写回界面。
_CTX_WORKSPACE = {}
LORA_LIMIT = 5


def _norm_loras(raw):
    """把前端提交 / 模型填的 LoRA 统一成 [{name, strength}]。

    接受三种写法：
      ["a.safetensors", "b.safetensors"]
      [{"name": "a.safetensors", "strength": 0.8}]
      "a.safetensors, b.safetensors"
    按名字去重、保持先后顺序（顺序影响叠加效果）、最多 5 个。
    """
    if not raw:
        return []
    if isinstance(raw, str):
        raw = [x.strip() for x in re.split(r"[,，;；\n]", raw) if x.strip()]
    out, seen = [], set()
    for it in (raw or []):
        if isinstance(it, dict):
            name = str(it.get("name") or it.get("lora") or it.get("file") or "").strip()
            try:
                strength = float(it.get("strength", it.get("weight", 1.0)))
            except Exception:
                strength = 1.0
        else:
            name, strength = str(it or "").strip(), 1.0
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "strength": max(-2.0, min(2.0, strength))})
        if len(out) >= LORA_LIMIT:
            break
    return out


def lora_inventory():
    """ComfyUI 当前注册的 LoRA 清单（来自 catalog，不读文件）"""
    try:
        return [str(x) for x in ((comfy.catalog() or {}).get("loras") or [])]
    except Exception:
        return []


def is_accel_lora(name):
    """加速（蒸馏）LoRA：只能在 Viggle 方案下叠加，其它方案会忽略"""
    return any(h in str(name).lower() for h in workflows.VIGGLE_HINTS)


# 用户口头说方案时的识别规则（顺序即优先级：先 viggle 再其它，避免「5 步」被 turbo 抢走）
_SAMPLING_HINTS = (
    ("viggle", re.compile(r"viggle|5\s*步加速|五步加速|加速\s*lora", re.I)),
    ("standard", re.compile(r"\bstandard\b|标准采样|标准\s*ksampler", re.I)),
    ("turbo", re.compile(r"\bturbo\b|8\s*步蒸馏|高速模式", re.I)),
)


def sampling_from_text(text):
    """从用户一句话里推断想要的采样方案；没提到返回空串。

    「用 viggle 5 步加速出一张」这类说法如果只靠界面状态，助手会沿用旧的 turbo，
    结果既没串加速 LoRA 也没换标准底模。这里把话里的意图识别出来。
    注意「标准底模」不算选 Standard —— 那是 viggle 的配套条件，不是方案。
    """
    t = str(text or "")
    if not t:
        return ""
    for key, rx in _SAMPLING_HINTS:
        if rx.search(t):
            return key
    return ""


def search_loras(query="", limit=12):
    """按关键词搜 LoRA。

    文件名是唯一线索（不读 safetensors 元数据），所以做成「多关键词任一命中」：
    用户说「小恩雅」→ 命中含「恩雅」的文件；说「动漫」→ 命中含「anime/二次元」的。
    全部 LoRA 数量不多（几十个），直接遍历即可。
    """
    pool = lora_inventory()
    q = str(query or "").strip()
    # 同时按空格 / 逗号 / 中文标点切词，任一命中就算相关
    words = [w.lower() for w in re.split(r"[\s,，、;；+/]+", q) if w.strip()] if q else []
    hits = []
    for n in pool:
        low = n.lower()
        if not words:
            hits.append(n)
            continue
        score = 0
        for w in words:
            if w in low:
                score += 3 if low.startswith(w) else 1
        if score:
            hits.append(n)
    hits.sort(key=lambda n: (not any(w in n.lower() for w in words) if words else False, len(n)))
    try:
        limit = max(1, min(50, int(limit or 12)))
    except Exception:
        limit = 12
    return [{"name": n, "hint": lora_hint(n)} for n in hits[:limit]]


def lora_hint(name):
    """从文件名给一句用途提示，帮模型判断该不该选（纯启发式，不猜具体效果）"""
    low = str(name).lower()
    tags = []
    if is_accel_lora(name):
        tags.append("加速蒸馏 LoRA，只能配 Viggle 方案")
    for k, t in (("face", "换脸"), ("swap", "换脸"), ("restore", "修复增强"),
                 ("upscale", "放大细节"), ("detail", "细节"),
                 ("anime", "二次元画风"), ("cartoon", "卡通"),
                 ("real", "写实"), ("photo", "摄影质感"),
                 ("style", "风格"), ("light", "光影"), ("film", "胶片"),
                 ("scene", "分镜/场景"), ("next-scene", "分镜")):
        if k in low and t not in tags:
            tags.append(t)
    return "、".join(tags) if tags else ""


# ---------------------------------------------------------------- 工作台参数
# 让 DeepSeek 真的能「按我的设置出图、帮我改设置」。
# 三层叠加（后面覆盖前面）：
#   ① 用户当前界面参数（前端每次请求上报 _CTX_WORKSPACE）
#   ② 技能自带的 params
#   ③ 本轮 AI 显式传的 params
# 改参数走 set_workspace：校验收敛后的值放在 tool result 的 ui 字段里回传前端落地，
# 所以「帮我把步数改成 30」是真的改界面，下次生成就用 30。

PARAM_SPEC = {
    # 键: (类型, 下界或枚举, 上界, 中文名)
    "steps": ("int", 1, 200, "步数"),
    "cfg": ("float", 0.0, 30.0, "CFG"),
    "sampler": ("str", None, None, "采样器"),
    "scheduler": ("str", None, None, "调度器"),
    "denoise": ("float", 0.05, 1.0, "重绘幅度"),
    "seed": ("int", -1, 2 ** 48, "种子"),
    "batch": ("int", 1, 8, "每次张数"),
    "max_images": ("int", 1, 16, "参考图上限"),
    "resolution": ("int", 0, 4096, "参考图总像素预算"),
    "width": ("int", 64, 4096, "画布宽"),
    "height": ("int", 64, 4096, "画布高"),
    "negative": ("str", None, None, "负向提示词"),
    "sampling": ("enum", ("turbo", "standard", "viggle"), None, "采样方案"),
    "size_mode": ("enum", ("auto", "fixed", "native"), None, "尺寸来源"),
    "cache_device": ("enum", ("auto", "gpu", "cpu", "off"), None, "缓存设备"),
    "cache_dtype": ("enum", ("default", "int8", "int4"), None, "缓存精度"),
    "unet": ("str", None, None, "底模"),
    "clip": ("str", None, None, "文本编码器"),
    "vae": ("str", None, None, "VAE"),
    "polish": ("bool", None, None, "生成前润色"),
    "ratio": ("str", None, None, "画布比例"),
    "res_level": ("str", None, None, "分辨率档位"),
}

# 与前端 RATIOS / RES_LONG 一一对应：长边 = 档位，短边按比例缩，再对齐 8
_RATIO_PX = {"1:1": (1, 1), "16:9": (16, 9), "9:16": (9, 16), "3:4": (3, 4),
             "4:3": (4, 3), "3:2": (3, 2), "2:3": (2, 3), "21:9": (21, 9)}
_RES_LONG = {"1K": 1024, "1.5K": 1536, "2K": 2048}


def size_from_ratio_res(ratio, res):
    """比例 + 档位 → 像素（口径与前端 sizeFrom 完全一致）"""
    r = _RATIO_PX.get(str(ratio or "").strip())
    if not r:
        return None
    long = _RES_LONG.get(str(res or "").strip())
    if not long:
        return None
    aw, ah = r
    w, h = (long, long * ah / aw) if aw >= ah else (long * aw / ah, long)
    return max(64, int(round(w / 8.0)) * 8), max(64, int(round(h / 8.0)) * 8)


def _truthy(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on", "是", "开")


def _clean_param_patch(patch, catalog=None):
    """把一批参数收敛成界面能接受的值。

    返回 (applied, rejected, notes)：
      applied  校验/收敛后要落地的值
      rejected 不能用的键 → 原因（原样回给模型，避免它以为改成功了）
      notes    给人看的一句话说明（比如 Viggle 锁定、数值被夹紧）
    数值超界不是直接拒绝，而是夹到边界并写在 notes 里——「30 步」被夹成 200 步
    比整条指令失败有用得多；枚举写错、模型文件不存在才拒绝（没有合理收敛方向）。
    """
    if not isinstance(patch, dict):
        return {}, {"params": "必须是 JSON 对象"}, []
    cat = catalog if isinstance(catalog, dict) else None
    applied, rejected, notes = {}, {}, []
    for raw_k, v in patch.items():
        k = str(raw_k or "").strip()
        if k not in PARAM_SPEC:
            continue  # 未知键交给上层统一提示，不逐条报错占上下文
        kind, lo, hi, label = PARAM_SPEC[k]
        if v is None:
            continue
        if kind == "int":
            try:
                val = int(round(float(v)))
            except Exception:
                rejected[k] = "%s 需要整数，收到 %r" % (label, v)
                continue
            if val < lo or val > hi:
                notes.append("%s %s 超出 %s~%s，已收到边界 %s" % (label, val, lo, hi, max(lo, min(hi, val))))
                val = max(lo, min(hi, val))
            applied[k] = val
        elif kind == "float":
            try:
                val = round(float(v), 2)
            except Exception:
                rejected[k] = "%s 需要数字，收到 %r" % (label, v)
                continue
            if val < lo or val > hi:
                notes.append("%s %s 超出 %s~%s，已收到边界 %s" % (label, val, lo, hi, max(lo, min(hi, val))))
                val = max(lo, min(hi, val))
            applied[k] = val
        elif kind == "bool":
            applied[k] = _truthy(v)
        elif kind == "enum":
            val = str(v).strip().lower()
            if val not in lo:
                rejected[k] = "%s 只能是 %s，收到 %r" % (label, " / ".join(lo), v)
                continue
            applied[k] = val
        else:
            applied[k] = str(v).strip()

    # 模型 / 采样器 / 调度器：对着 ComfyUI 的真实清单校验，拼错名字直接拒绝
    if cat:
        for key, list_key in (("unet", "unets"), ("clip", "clips"), ("vae", "vaes"),
                              ("sampler", "samplers"), ("scheduler", "schedulers")):
            if key not in applied:
                continue
            pool = list(cat.get(list_key) or [])
            if key in ("unet", "clip"):
                pool = pool + list(cat.get(list_key + "_gguf") or [])
            if not pool or applied[key] in pool:
                continue
            want = applied[key].lower()
            hit = next((x for x in pool if x.lower() == want), "") or \
                next((x for x in pool if want in x.lower()), "")
            if hit:
                notes.append("%s 改成清单里的「%s」" % (PARAM_SPEC[key][3], hit))
                applied[key] = hit
            else:
                rejected[key] = "本地没有「%s」，可选：%s" % (
                    applied[key], "、".join(pool[:8]) + ("…" if len(pool) > 8 else ""))
                applied.pop(key, None)

    # 比例 / 档位 → 像素（和前端点比例按钮等价，会自动切到「按比例」）
    ratio = applied.get("ratio", "")
    res = applied.get("res_level", "")
    if ratio or res:
        base = _CTX_WORKSPACE.get("params") if isinstance(_CTX_WORKSPACE.get("params"), dict) else {}
        wh = size_from_ratio_res(ratio or base.get("ratio"), res or base.get("res_level"))
        if wh:
            applied["width"], applied["height"] = wh
            applied.setdefault("size_mode", "fixed")
            notes.append("画布 %d×%d" % wh)
        else:
            rejected.setdefault("ratio", "比例 / 档位要成对出现，可选：%s + %s"
                                % (" / ".join(_RATIO_PX), " / ".join(_RES_LONG)))
    if ("width" in applied or "height" in applied) and "size_mode" not in applied:
        applied["size_mode"] = "fixed"   # 直接给像素 = 明确要固定画布

    # 采样方案一变，配套参数必须跟着变（和前端 syncSampling / applyViggleParams 一致）
    s = applied.get("sampling") or (_CTX_WORKSPACE.get("params") or {}).get("sampling") or ""
    if s == "viggle":
        if applied.get("steps") not in (None, workflows.VIGGLE_STEPS) or applied.get("cfg") not in (None, 1.0):
            notes.append("Viggle 方案固定 %d 步 / CFG 1.0，你给的步数与 CFG 已被方案覆盖" % workflows.VIGGLE_STEPS)
        applied["steps"] = workflows.VIGGLE_STEPS
        applied["cfg"] = 1.0
        applied["negative"] = ""
    elif applied.get("sampling") == "turbo":
        applied.setdefault("steps", 8)
        applied.setdefault("cfg", 1.0)
    elif applied.get("sampling") == "standard":
        applied.setdefault("steps", 30)
        applied.setdefault("cfg", 4.0)
    return applied, rejected, notes


def workspace_params():
    """用户界面里当前那套参数（只取白名单键）"""
    ws = _CTX_WORKSPACE if isinstance(_CTX_WORKSPACE, dict) else {}
    raw = ws.get("params") if isinstance(ws.get("params"), dict) else {}
    return {k: v for k, v in raw.items() if k in PARAM_SPEC and v is not None}


def _catalog_or_empty():
    """ComfyUI 是不是离线都不该让参数校验直接崩：拿不到就只做范围校验"""
    try:
        return comfy.catalog() or {}
    except Exception:
        return {}


def _ui_skills():
    """界面上那 4 张技能卡（和助手自己的业务技能列表不是一回事）

    注意：workflows.SKILLS 里没有 mode 字段，id 本身就是模式
    （text2img / img2img / edit / inpaint），前端 state.mode 用的也是它。
    """
    out = []
    for s in workflows.SKILLS:
        out.append({
            "id": s["id"], "name": s["name"], "mode": s["id"],
            "needs_images": s.get("min_images", 0), "max_images": s.get("max_images", 0),
            "denoise": s.get("denoise", 1.0), "tip": s.get("tip", ""),
        })
    return out


def _tool_get_workspace(include_options=True, **kw):
    """读用户当前的工作台状态（技能 / 尺寸 / 参数 / LoRA / 润色）+ 可选项。"""
    ws = _CTX_WORKSPACE if isinstance(_CTX_WORKSPACE, dict) else {}
    out = {
        "current": {
            "view": ws.get("view") or "",
            "ui_skill": ws.get("skill") or "",
            "ui_skill_name": ws.get("skill_name") or "",
            "draft": str(ws.get("draft") or "")[:200],
            "images": ws.get("images") or [],
            "loras": ws.get("loras") or [],
            "params": workspace_params(),
        },
        "limits": {k: [v[1], v[2]] for k, v in PARAM_SPEC.items() if v[0] in ("int", "float")},
        "readme": ("current.params 就是用户现在界面上的设置；generate_images 会以它为底座，"
                   "你只在 params 里写要改的那几项。set_workspace 会把改动同步到界面。"),
    }
    if not _CTX_WORKSPACE:
        out["current"]["note"] = "前端没有上报工作台状态（可能是旧版页面），只能按默认参数生成"
    if include_options:
        cat = _catalog_or_empty()
        out["options"] = {
            "ui_skills": _ui_skills(),
            "samplings": [{k: s.get(k) for k in ("key", "name", "steps", "steps_fixed", "cfg", "desc")}
                          for s in workflows.SAMPLINGS],
            "ratios": list(_RATIO_PX), "res_levels": list(_RES_LONG),
            "samplers": (cat.get("samplers") or [])[:30],
            "schedulers": (cat.get("schedulers") or [])[:12],
            "unets": ((cat.get("unets") or []) + (cat.get("unets_gguf") or []))[:20],
            "clips": ((cat.get("clips") or []) + (cat.get("clips_gguf") or []))[:12],
            "vaes": (cat.get("vaes") or [])[:12],
        }
    return out


def _tool_set_workspace(**kw):
    """改用户工作台的参数 / 技能（会同步到界面并保存）。"""
    patch = dict(kw or {})
    nested = patch.pop("params", None)
    if isinstance(nested, dict):
        patch.update(nested)
    # 这几个不是参数，是界面动作
    ui_skill = str(patch.pop("ui_skill", "") or "").strip()
    view = str(patch.pop("view", "") or "").strip()
    reason = str(patch.pop("reason", "") or "").strip()

    if ui_skill and ui_skill not in [s["id"] for s in workflows.SKILLS]:
        return {"error": "界面技能只有：%s" % " / ".join("%s(%s)" % (s["id"], s["name"])
                                                     for s in workflows.SKILLS)}
    if view and view not in ("home", "chat", "canvas", "gallery", "settings"):
        return {"error": "view 只能是 home / chat / canvas / gallery / settings"}

    try:
        cat = _catalog_or_empty()
    except Exception:
        cat = {}
    applied, rejected, notes = _clean_param_patch(patch, cat)
    unknown = [k for k in patch if k not in PARAM_SPEC]
    if unknown:
        rejected["_unknown"] = "不认识：%s（可用：%s）" % ("、".join(unknown[:8]), "、".join(sorted(PARAM_SPEC)))

    # 切到 Viggle 时把界面的底模一起换对：否则界面上是「turbo 底模 + viggle 方案」，
    # 下次手动出图还得靠提交时兜底，用户看到的状态也是错的。
    if applied.get("sampling") == "viggle":
        cur_unet = applied.get("unet") or (workspace_params() or {}).get("unet") or ""
        q_v = {"sampling": "viggle", "unet": cur_unet}
        ok_v, err_v, notes_v = workflows.prepare_sampling(q_v, cat)
        if not ok_v:
            return {"error": err_v, "rejected": {"sampling": err_v}}
        if q_v.get("unet") and q_v["unet"] != cur_unet:
            applied["unet"] = q_v["unet"]      # 界面底模同步换成标准权重
        if notes_v:
            notes = list(notes) + notes_v

    if not applied and not rejected and not ui_skill and not view:
        return {"error": "没有任何可执行的改动。参数名要按 get_workspace 的 current.params 来写"}

    bits = []
    for k, v in applied.items():
        label = PARAM_SPEC[k][3] if k in PARAM_SPEC else k
        bits.append("%s=%s" % (label, ("关闭" if v is False else "开启") if isinstance(v, bool) else v))
    if ui_skill:
        nm = next((s["name"] for s in workflows.SKILLS if s["id"] == ui_skill), ui_skill)
        bits.insert(0, "技能切到「%s」" % nm)
    if view:
        bits.append("切到%s" % {"home": "首页", "chat": "对话", "canvas": "自由画布",
                               "gallery": "作品库", "settings": "设置"}.get(view, view))
    note = "已更新界面：" + "、".join(bits) if bits else "没有实际改动"
    if notes:
        note += "（" + "；".join(notes) + "）"
    if reason:
        note += " · " + reason
    return {
        "applied": applied,
        "rejected": rejected,
        "note": note,
        "ui": {"action": "apply_params", "params": applied, "skill_id": ui_skill,
               "view": view, "note": note},
    }


SYSTEM_PROMPT = """你是 CYUI 的 AI 图片助手，运行在用户本地的 ComfyUI 工作站上。

工作方式：
- 用中文交流，回答简短直接。需要执行操作时直接调用工具，不要只给建议。
- 用户不需要费力写提示词：用户的创作描述往往很简短甚至口语化（如“画一只猫”“把这张图改好看”），你负责在调用 generate_images 之前把提示词自主扩写成完整的画面提示词（主体 + 动作/表情 + 环境/场景 + 光影 + 风格 + 构图/视角 + 画质），贴合用户原意与参考图内容，不要偏离意图，也不要把口语短句直接提交。
- 一条指令只交一批活：把这一轮该做的工具按顺序调完再一次性总结，不要每步都停下来问用户。

【张数：默认 1 张，这是硬规则】
- generate_images 的 count 保持 1。只有用户明确说「两张 / 3 张 / 多来几张 / 各来一张 / 两个版本」时才填更大值。
- 提交成功（拿到 job_id）就是这一批已经做完，不要为了“更保险”再提交一次同样的任务；重复调用会被系统直接忽略并原样返回上一次的 job_id，只会白耽误时间。
- 需要连续做不同的事（例如先生成再放大）就接着调对应工具，而不是重复调 generate_images。

【模式：Qwen-Image 2.1 只有两件事——文生图、图像编辑】
这套模型是「生成与编辑合一」的：同一份权重，靠「有没有接输入图」+「提示词意图」区分任务。
所以不要把它理解成「文生图 / 图生图」两套流程，更不要用「是否保留原图」来选模式。

- **没有输入图 → text2img**：只有真正从零创作才走它（纯想象画面、电商海报、分镜首帧）。
- **有输入图 → edit**：这是绝大多数情况。换背景、抠图、去水印、扩图、换装、换脸、
  换发色、人像精修、电影感调色、风格迁移、老照片修复，全部都是 edit。
  做法都是「把原图接到 image_1，用一句话说清要改什么」，主体与构图由参考图 latent 锁住，
  不需要靠低重绘幅度去「硬留原像素」。
- **工具里已经没有 img2img 了**。如果你写了它，系统会自动改成 edit。原因：img2img
  是把原图编码后重新采样，会重画细节、丢人物身份，正好是最容易翻车的那条路。
- **你没有局部重绘能力**（工具里没有 mask 参数，也不该自己造一个遮罩）。用户要求
  「只改涂抹的这一块／别动其他地方」时，明确告诉他：界面左侧技能卡切到「局部重绘」，
  用画笔涂出区域后再提交，那才是像素级的保图方式。你这边可以先用 edit 按指令做
  （例如「去掉这块区域的水印，补齐背景纹理」），但不要说成「只改了那一块」。
- 换脸、老照片修复、链式分镜要效果更稳需要专用 LoRA（换脸 / Restore / Next-Scene）。
  当前环境未装时，直接用原生编辑尽力做，并如实告诉用户「装对应 LoRA 会更稳」，不要拒绝执行。

【尺寸：用户提到就必须传 size】
- 说像素：直接传 "1360x768"。
- 说比例：传 "16:9" / "3:2" / "9:16" / "2.39:1"。
- 说版式：「竖版」→ "9:16"；「横版 / 壁纸」→ "16:9"；「方图 / 头像」→ "1:1"；「海报」→ "2:3"；「宽银幕 / 电影分镜」→ "2.39:1"。
- 用户完全没提尺寸时才省略 size（这时默认 1024×1024 方图）。
- 尺寸是画布参数，不要把它混进提示词文字里。

【采样方案：三种方案各是一套组合，不是只改步数】
`generate_images.params.sampling` 只有三个值，每个都绑定「底模 + LoRA + 步数/CFG」三件事：

| 方案 | 底模要求 | 额外 LoRA | 步数 / CFG |
|---|---|---|---|
| `turbo`（默认） | turbo 蒸馏权重 | 无 | 固定 8 步 · CFG 1.0 |
| `standard` | 标准（非 turbo）权重 | 无 | 25~40 步 · CFG 可以 >1，负向提示词这时才生效 |
| `viggle` | 标准（非 turbo）权重 | **5 步加速蒸馏 LoRA（必需）** | 固定 5 步 · CFG 1.0 · 负向无效 |

关键规则：
- 用户说「viggle / 5 步加速 / 五步加速 / 加速出图」→ 传 `sampling="viggle"`。
  **加速 LoRA 和标准底模由系统自动处理**：会自己找 viggle 加速 LoRA 挂上、
  底模是 turbo 时自动换成同目录标准版。你**不要**手动往 `loras` 里加加速 LoRA，
  也不要手动改 steps / cfg（会被锁成 5 / 1.0）。做完在回复里说明「已自动换标准底模 + 挂加速 LoRA」。
- 用户说「standard / 标准采样 / 慢慢跑 30 步」→ 传 `sampling="standard"`，步数 25~40，
  想加强负向效果就把 cfg 调到 1.5~4（`turbo`/`viggle` 改 cfg 没意义）。
- 用户说「turbo / 快点 / 8 步」→ 传 `sampling="turbo"`（或省略，默认就是它）。
- 环境里没装加速 LoRA 时，`sampling="viggle"` 会明确报错并给出下载地址：
  如实转告用户去放文件、刷新清单，**不要自己编一个 LoRA 名字糊过去**，也不要偷偷降级成 turbo 硬跑。
- 用户没提方案时沿用界面当前值（提示词里已有摘要），不要多嘴改它。

【LoRA：会搜、会选、别乱加】
LoRA 是叠在底模上的风格 / 人物补丁，能显著改变画面，但**加错会比不加更差**。

什么时候该用：
- 用户点名了某个 LoRA、某个角色名、某个画风包（「用 XX 的模型」「加上小恩雅的 LoRA」）→ 必须先用 list_loras 搜一遍。
- 用户没说，但提示词明显指向某个本地已有的角色 / 画风 LoRA（搜一下看有没有高度同名的）→ 可以主动用，并在回复里说明用了哪个。
- 只是普通创作、搜不到对口的 → **不要硬加**，纯提示词就行。

怎么传：
- `loras` 是文件名数组，最多 5 个，**直接用 list_loras 返回的 name 原值**，不要自己编文件名、不要带路径。
- 只传文件名就行，强度默认 1.0。用户要「弱一点 / 强一点」时，告诉他可以点输入框左侧的 ⭐ LoRA 面板手动调数值（那里改完每轮都生效）。
- 顺序有意义（前面的影响更大），用户点名过的排最前面。

两个硬约束：
- 名字里带 viggle / 5step 的是**加速蒸馏 LoRA**，只能在采样方案 Viggle 下叠加；其它方案里系统会自动忽略它，你也就别去选。
- 用户在手选面板里锁定的 LoRA 每轮都会自动带上。你**不要重复添加**，也不要把 LoRA 名字写进提示词正文。

搜不到时如实说「本地没有对口的 LoRA，我先用提示词做」，不要拒绝执行，也不要编造一个不存在的文件名。

【工作台参数：你也能读、也能改】
用户的「技能 / 尺寸 / 参数抽屉 / 润色 / 反推」这套设置你都能碰，分三条路：

1. **只影响这一次** → 写进 `generate_images.params`（字段名同下），不改界面。
   用户说「这次用 40 步试试」「这张要竖版」就用这条。
2. **改界面（长期生效）** → `set_workspace`。用户说「把步数改成 30」「以后都 16:9」
   「切到 Standard」「负向提示词加上水印」「打开润色」时用它，改完界面上的数字真的会变。
   想看清当前值用 `get_workspace`（提示词里已有摘要，不必每轮都调）。
3. **改不了就直说**：`rejected` 里的键是名字写错 / 超出范围 / 本地没这个模型，
   按它给的候选改一次再试；不要假装改成功。

**两套「技能」不要混**：
- `generate_images(skill_id=...)` 里的 skill_id 是**业务技能**（电商白底图 / 模特换装 / 去水印…），用 `list_skills` 查。
- `set_workspace(ui_skill=...)` 里的是**界面技能卡**（text2img / img2img / edit；inpaint 需手动涂遮罩，不要替用户选），
  它决定输入框下面那张卡片和 denoise 预设，两者可以同时用。

参数怎么配（三套采样方案见上面「采样方案」那张表，这里只说其余参数）：
- **CFG=1 时负向提示词不参与计算**，这是数学结果，不是没生效。想要负向生效就把 CFG 调上去（standard）。
- **samplers / schedulers**：euler + simple 是稳的默认；要更细腻可用 dpmpp_2m + karras（standard 下）。
  只能填 `options.samplers` / `options.schedulers` 里有的值。
- **seed**：-1 每次随机；想复现某张图就填它的种子（结果消息里带 seed）。
- **batch**（界面「每次张数」）与 generate_images 的 `count` 是同一件事，以 count 为准。

尺寸怎么定（三层，别互相打架）：
- `size_mode`：auto=跟随图1（有参考图时保比例只缩不放）；fixed=按比例/手填像素；native=参考图原始像素。
- 说比例就用 `ratio` + `res_level`（1K/1.5K/2K 是长边像素），系统会算好宽高，你不用自己乘。
- 说具体像素就用 `width` + `height`（64~4096，内部按 8 对齐）。12G 显存建议长边别超 2048。
- 用户没提尺寸 → 不要动，沿用他当前的画布。

润色 / 反推：
- 用户说「润色一下再画 / 优化提示词」→ `generate_images(polish=true)`，或在改稿阶段先 `polish_prompt`。
- 你自己扩写过的提示词**不要再润色**，会重复改写、偏离原意。
- 看到图想复刻 → `reverse_prompt(image_name)` 拿到提示词，再按需 `generate_images`。
- 用户界面开着润色（工作台摘要里有「生成前润色 开」）只说明手动生成会润色，不会影响你。

【其余约定】
- 技能列表用 list_skills 查询（含 id、模式、需要的图片数、分类）。用户说“白底图 / 换装 / 抠图 / 去水印 / 电影感 / 分镜 / 海报”等，优先匹配技能；技能自带模式与参考图要求，选了技能就不要另指定相矛盾的 mode。
- 单张或少量生成用 generate_images；文件夹批量用 batch_process。
- 提交批量任务后用 wait_batch 等它跑完（会阻塞直到完成或超时），再汇总结果；中途想看进度用 batch_status。
- 文生图不需要图片；图生图 / 编辑需要用户先在对话里上传图片。用户消息中会出现 [图片:文件名] 标记，把这些文件名放进 image_names（统一用 image_names 这个参数名）。
- 上一步生成的结果图可以直接继续用：把结果里的 /results/xxx.png 地址或 input_name 填进 image_names / image_name，系统会自动回灌到 ComfyUI input，不要让用户手动搬文件。
- 每次最多 2 张参考图；批量最多 50 张。
- 提交任务后，告诉用户“已提交”，结果会自动出现在应用的对话与图库里，不要编造图片内容。
- 用户要求批量处理时，必须先确认本地文件夹绝对路径，再调用 batch_process。
- 提示词相关的需求用 polish_prompt / reverse_prompt；可以先生成 → reverse_prompt 看效果 → 再调整，形成工作闭环。
- 用户明确要 4K / 放大时用 upscale_image，target 可填 1536 / 2048 / 4096 或 default。
- 如果缺少 DeepSeek Key、ComfyUI 离线、模型缺失等，直接说明并给出下一步操作。"""

TOOLS = [
    {"type": "function", "function": {
        "name": "list_skills",
        "description": "列出所有可用的图片技能（id/名称/分类/模式/需要的图片数/说明）",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_workspace",
        "description": "读取用户当前的工作台状态：界面技能、画布尺寸（模式/比例/像素）、采样方案、步数 CFG 采样器调度器、种子、张数、负向提示词、底模三件套、LoRA、润色开关，以及可选的技能/比例/档位/模型清单。用户说「按我现在的设置」「用我刚才调的参数」「现在设的是多少」时先读它",
        "parameters": {"type": "object", "properties": {
            "include_options": {"type": "boolean",
                                "description": "是否连可选清单一起返回（技能/比例档位/采样器/底模）。只想看当前值时传 false 省上下文"},
        }},
    }},
    {"type": "function", "function": {
        "name": "set_workspace",
        "description": "直接修改用户界面的参数（会真的改界面并保存，下次生成就生效）。用户说「把步数改成 30」「换成 16:9」「切到 Standard 方案」「用图生图」「负向提示词加…」时用。只传要改的项，没传的保持不变",
        "parameters": {"type": "object", "properties": {
            "sampling": {"type": "string", "enum": ["turbo", "standard", "viggle"],
                         "description": "采样方案：turbo=8 步蒸馏（最快最稳，配 turbo 底模）；standard=标准 KSampler 25~40 步（细节更好，配标准底模）；viggle=5 步加速（配标准底模 + 5 步加速 LoRA）。选 viggle 时系统会自动挂加速 LoRA、必要时换标准底模，你不用手动处理 LoRA 与底模"},
            "steps": {"type": "integer", "description": "步数：turbo 建议 8，standard 建议 25~40，viggle 固定 5（会被自动锁定）"},
            "cfg": {"type": "number", "description": "CFG：turbo / viggle 锁 1.0（此时负向提示词不生效）；standard 常用 3~7"},
            "sampler": {"type": "string", "description": "采样器，如 euler / dpmpp_2m，取值见 get_workspace 的 options.samplers"},
            "scheduler": {"type": "string", "description": "调度器，如 simple / karras / beta"},
            "denoise": {"type": "number", "description": "重绘幅度 0.05~1。注意：本项目的编辑链路会强制 1.0，改这项一般无效"},
            "seed": {"type": "integer", "description": "固定种子：-1 每次随机；想复现某张图就填它的种子"},
            "batch": {"type": "integer", "description": "每次生成张数 1~8"},
            "resolution": {"type": "integer", "description": "参考图缩放的总像素预算（0 = 保持原图）"},
            "width": {"type": "integer", "description": "画布宽 64~4096（会自动切到「按比例 / 固定画布」）"},
            "height": {"type": "integer", "description": "画布高 64~4096"},
            "ratio": {"type": "string", "description": "画布比例：1:1 / 16:9 / 9:16 / 3:4 / 4:3 / 3:2 / 2:3 / 21:9"},
            "res_level": {"type": "string", "description": "分辨率档位：1K / 1.5K / 2K（长边像素）"},
            "size_mode": {"type": "string", "enum": ["auto", "fixed", "native"],
                          "description": "尺寸来源：auto=跟随图1；fixed=用比例/手填像素；native=参考图原始像素"},
            "negative": {"type": "string", "description": "负向提示词（只有 CFG>1 才真正参与计算）"},
            "unet": {"type": "string", "description": "底模文件名，取值见 options.unets"},
            "clip": {"type": "string", "description": "文本编码器文件名，取值见 options.clips"},
            "vae": {"type": "string", "description": "VAE 文件名，取值见 options.vaes"},
            "cache_device": {"type": "string", "enum": ["auto", "gpu", "cpu", "off"]},
            "cache_dtype": {"type": "string", "enum": ["default", "int8", "int4"]},
            "polish": {"type": "boolean", "description": "生成前是否自动润色提示词"},
            "max_images": {"type": "integer", "description": "参考图数量上限 1~16"},
            "ui_skill": {"type": "string", "enum": ["text2img", "img2img", "edit", "inpaint"],
                         "description": "界面上的技能卡片：text2img 文生图 / img2img 图生图 / edit 图片编辑 / inpaint 局部重绘。注意：inpaint 需要用户手动涂遮罩，你没有这个能力，不要把 ui_skill 设成 inpaint"},
            "view": {"type": "string", "enum": ["home", "chat", "canvas", "gallery", "settings"],
                     "description": "顺便切到哪个界面：canvas=自由画布，gallery=作品库"},
            "reason": {"type": "string", "description": "一句话说明为什么这么改，会显示在界面提示里"},
        }},
    }},
    {"type": "function", "function": {
        "name": "generate_images",
        "description": "按技能或描述生成/编辑图片，提交到 ComfyUI。返回任务 id，结果会自动进对话与图库。一条指令只调用一次。",
        "parameters": {"type": "object", "properties": {
            "skill_id": {"type": "string", "description": "技能 id，可先 list_skills。选了技能就不要再指定矛盾的 mode"},
            "prompt": {"type": "string", "description": "用户需求，或你扩写后的完整画面提示词；技能有模板时会拼接"},
            "mode": {"type": "string", "enum": ["auto", "text2img", "edit"],
                     "description": "基本不用填：留空/auto 时系统按「有没有输入图」自动判定——有图=图像编辑(edit)，无图=文生图(text2img)。只有确实要从零创作（无输入图）时才需要显式写 text2img"},
            "image_names": {"type": "array", "items": {"type": "string"},
                            "description": "参考图：ComfyUI input 文件名，或上一步结果的 /results/xxx.png 地址 / input_name，最多 2 张，会自动回灌 input"},
            "size": {"type": "string",
                     "description": "输出画布。用户提到尺寸/比例/版式就必须传：像素 \"1360x768\"；比例 \"16:9\" / \"9:16\" / \"2.39:1\"；版式「竖版」「横版」「方图」「海报」。完全没提才省略（默认 1024x1024）"},
            "count": {"type": "integer",
                      "description": "一次生成几张，1-8，默认 1。只有用户明确要多张时才填大于 1"},
            "loras": {"type": "array", "items": {"type": "string"},
                      "description": "要叠加的 LoRA 文件名，最多 5 个，直接用 list_loras 返回的 name 原值（不要带路径、不要自己编）。顺序影响叠加效果，用户点名的排前面。用户没点名又搜不到对口 LoRA 时留空，不要硬加。只传文件名即可，强度默认 1.0"},
            "params": {"type": "object",
                       "description": "只影响这一次生成、不改界面的参数覆盖。字段名与 set_workspace 相同（steps/cfg/sampler/scheduler/seed/sampling/negative/width/height/ratio/res_level/unet/clip/vae…）。不传就用用户界面当前那套"},
            "polish": {"type": "boolean",
                       "description": "提交前先用本地模型润色一遍提示词。只有用户明确说「润色一下 / 优化提示词再画」时才传 true；你扩写过的提示词不要再润色"},
        }, "required": ["prompt"]},
    }},
    {"type": "function", "function": {
        "name": "list_loras",
        "description": "搜索本地已安装的 LoRA（按文件名关键词匹配）。用户提到具体角色/画风/效果名、或你想给画面加强某个特征时先搜一遍再决定用不用",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "关键词，如「小恩雅」「动漫」「换脸」「胶片」。留空则列出全部（按文件名排序）"},
            "limit": {"type": "integer", "description": "最多返回几个，默认 12，最大 50"},
        }},
    }},
    {"type": "function", "function": {
        "name": "upscale_image",
        "description": "用 SeedVR2 高清放大一张已上传的图片",
        "parameters": {"type": "object", "properties": {
            "image_name": {"type": "string", "description": "图片：ComfyUI input 文件名，或上一步结果的 /results/xxx.png 地址 / input_name"},
            "target": {"type": "string", "description": "default / 1536 / 2048 / 4096"},
        }, "required": ["image_name"]},
    }},
    {"type": "function", "function": {
        "name": "polish_prompt",
        "description": "把用户的口语描述润色成高质量提示词（本地 Qwen3-VL）",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string", "description": "原始描述"},
        }, "required": ["text"]},
    }},
    {"type": "function", "function": {
        "name": "reverse_prompt",
        "description": "看一张图片反推出画面提示词（可传结果图地址）",
        "parameters": {"type": "object", "properties": {
            "image_name": {"type": "string", "description": "图片：ComfyUI input 文件名，或上一步结果的 /results/xxx.png 地址"},
        }, "required": ["image_name"]},
    }},
    {"type": "function", "function": {
        "name": "batch_process",
        "description": "批量处理本地文件夹里的所有图片（抠图、换风格、白底图等），后台逐张执行",
        "parameters": {"type": "object", "properties": {
            "folder": {"type": "string", "description": "本地文件夹绝对路径，如 D:\\\\素材\\\\待处理"},
            "skill_id": {"type": "string", "description": "批量技能 id，如 batch_cutout / batch_style / ecom_white"},
            "prompt": {"type": "string", "description": "补充描述或风格，可空"},
            "limit": {"type": "integer", "description": "最多处理张数，默认 20，最大 50"},
        }, "required": ["folder", "skill_id"]},
    }},
    {"type": "function", "function": {
        "name": "batch_status",
        "description": "查询批量任务进度",
        "parameters": {"type": "object", "properties": {
            "batch_id": {"type": "string", "description": "batch_process 返回的 id"},
        }, "required": ["batch_id"]},
    }},
    {"type": "function", "function": {
        "name": "wait_batch",
        "description": "阻塞等待批量任务完成（内部每 2 秒查一次进度，最多等 timeout 秒），适合提交批量后连续工作直到出结果",
        "parameters": {"type": "object", "properties": {
            "batch_id": {"type": "string", "description": "batch_process 返回的 id"},
            "timeout": {"type": "integer", "description": "最长等待秒数，默认 120，最大 600"},
        }, "required": ["batch_id"]},
    }},
    {"type": "function", "function": {
        "name": "list_gallery",
        "description": "查看最近生成的作品（名称、尺寸、提示词、链接）",
        "parameters": {"type": "object", "properties": {
            "limit": {"type": "integer", "description": "默认 6"},
        }},
    }},
]


class AssistantError(comfy.ComfyError):
    """直接复用 ComfyError，路由层会转成干净的中文错误"""
    pass


def public_skills():
    return [{"id": s["id"], "name": s["name"], "cat": s["cat"], "mode": s["mode"],
             "images": s["images"], "desc": s["desc"]} for s in SKILLS]


def _enrich(cfg):
    """读首图尺寸并决定编码画布。

    这里原先自己抄了一份「只看 resolution」的旧逻辑，漏掉了用户显式选的画布，
    结果助手发起的 img2img / 局部重绘会退化成 resolution×resolution 的方形
    画布（遮罩直接错位）。现在统一走 workflows.resolve_canvas。
    """
    p = cfg["params"]
    orig = None
    if cfg["mode"] in ("img2img", "inpaint") and cfg["images"]:
        try:
            raw = comfy.view(cfg["images"][0], "", "input")
            with Image.open(io.BytesIO(raw)) as im:
                im = ImageOps.exif_transpose(im)
                orig = im.size
        except Exception:
            orig = None
    size, label = workflows.resolve_canvas(cfg["mode"], p, cfg["images"], orig)
    if size:
        cfg["target_size"] = (int(size[0]), int(size[1]))
        cfg["size_label"] = label
    return cfg


def submit_generation(prompt, mode="text2img", images=None, params=None, title=None, session_id=None,
                      loras=None):
    """提交一次生成，复用应用的消息 / 图库 / 任务跟踪链路。

    session_id 优先取前端当前人工对话，其次取本次 chat() 的上下文，
    这样助手做事不会在「最近对话」里反复新建会话。
    loras 与前端手动生成同格式：[{"name": ..., "strength": 1.0}]，
    normalize 之后统一由 workflows.build 串进 LoraLoaderModelOnly 链。
    注意：AI 助手不提供局部重绘（遮罩由用户在界面手动涂抹后走 /api/generate），
    这里一律不带 mask，inpaint 相关需求由界面手动完成。
    """
    raw = {"mode": mode, "prompt": prompt, "images": images or [], "params": params or {},
           "loras": loras or []}
    cfg = workflows.normalize(raw)
    errs = workflows.validate(cfg)
    if errs:
        raise AssistantError("；".join(errs))
    s = workflows.skill(cfg["mode"])
    sid = store.ensure_session(session_id or _CTX_SESSION or None,
                               title or (prompt[:24] if prompt else s["name"]))
    cfg = _enrich(cfg)
    used_loras = [l["name"] for l in (cfg.get("loras") or [])]
    wf, meta = workflows.build(cfg, prefix="cyui/%s" % sid[:6])
    res = comfy.queue_prompt(wf)
    pid = res.get("prompt_id")
    if not pid:
        raise AssistantError("ComfyUI 未返回 prompt_id")

    # 三模式通路 + 单条输入：aiSend 已写入用户原文（source='ai'），这里把它
    # 升级为优化后的完整提示词——每次只保留一条用户输入，不再出现
    # 「原文 + 优化后」两条重复的用户消息；找不到 AI 用户消息时才新增。
    # 对话页保留用户原话（source='ai' 的那条就是 aiSend 写入的原文），
    # 扩写后的完整提示词只存在生成卡的 prompt / final_prompt 里，由结果卡展示；
    # 找不到用户消息时才补一条（内容退化为本次提交的提示词）。
    user_msg = store.last_ai_user(sid)
    if not user_msg:
        user_msg = store.add_message(sid, {
            "role": "user", "content": cfg["prompt"], "mode": cfg["mode"], "skill": s["name"],
            "source": "ai",
            "images": [{"name": n, "url": "/api/image?type=input&filename=" + n} for n in cfg["images"]],
            "params": cfg["params"], "loras": cfg.get("loras") or [],
        }, title=title or cfg["prompt"][:24] or s["name"])
    asst_msg = store.add_message(sid, {
        "role": "assistant", "status": "pending", "job_id": pid, "mode": cfg["mode"],
        "skill": s["name"], "content": "", "images": [], "meta": meta,
        "prompt": cfg["prompt"], "final_prompt": cfg["final_prompt"],
        "source": "ai",   # 对话页据此在出图前不显示这张空卡片
    })
    comfy.track(pid, {
        "session_id": sid, "assistant_mid": asst_msg["id"], "user_mid": user_msg["id"],
        "mode": cfg["mode"], "skill": s["name"], "prompt": cfg["prompt"],
        "final_prompt": cfg["final_prompt"], "params": cfg["params"],
        "loras": cfg.get("loras") or [],
        "workflow": wf, "workflow_meta": meta, "images": cfg["images"],
    })
    out = {"job_id": pid, "session_id": sid, "mode": cfg["mode"], "skill": s["name"],
           "final_prompt": cfg["final_prompt"], "images": cfg["images"]}
    if used_loras:
        out["loras"] = used_loras
    # 底模与采样方案对不上时（例如 viggle 跑在蒸馏权重上）把提示带回去，
    # 让助手如实转告用户，而不是自己猜「应该没问题」。
    warn = (cfg["params"] or {}).get("unet_warn")
    if warn:
        out["unet_warn"] = warn
    sw = (cfg["params"] or {}).get("unet_auto_switched")
    if sw:
        out["unet_auto_switched_from"] = sw
    return out


def submit_upscale(image_name, target="default", session_id=None):
    cfg = upscale.settings()
    scale, src, out = upscale.resolve(image_name, target or "default", cfg)
    sid = store.ensure_session(session_id or _CTX_SESSION or None, "助手放大 · %s" % image_name[:18])
    wf = upscale.build(image_name, scale, cfg, prefix="cyui/up_%s" % sid[:6])
    res = comfy.queue_prompt(wf)
    pid = res.get("prompt_id")
    if not pid:
        raise AssistantError("ComfyUI 未返回 prompt_id")
    label = "×%.2f · %d×%d → %d×%d" % (scale, src[0], src[1], out[0], out[1])
    # 同样不回写用户消息：放大是助手替用户执行的动作，不该在对话里多出一条
    # 用户没说过的气泡；放大参数放在生成卡的标签里
    user_msg = store.last_ai_user(sid)
    if not user_msg:
        user_msg = store.add_message(sid, {
            "role": "user", "content": "高清放大 " + label, "mode": "upscale", "skill": "高清放大",
            "source": "ai",
            "images": [{"name": image_name, "url": "/api/image?type=input&filename=" + image_name}],
            "params": {"scale": scale, "target": target},
        }, title="助手放大 · %s" % image_name[:18])
    asst_msg = store.add_message(sid, {
        "role": "assistant", "status": "pending", "job_id": pid, "mode": "upscale",
        "skill": "高清放大", "content": "", "images": [], "prompt": "",
        "source": "ai",
        "meta": {"sampler": "SeedVR2 " + label, "latent": "%d×%d" % out,
                 "reference_images": 1, "loras": [], "upscale": True},
    })
    comfy.track(pid, {
        "session_id": sid, "assistant_mid": asst_msg["id"], "user_mid": user_msg["id"],
        "mode": "upscale", "skill": "高清放大", "prompt": "", "final_prompt": "",
        "params": {"scale": scale, "target": target, "from": list(src), "to": list(out)},
        "loras": [], "workflow": wf, "workflow_meta": {}, "images": [image_name],
    })
    return {"job_id": pid, "session_id": sid, "label": label, "size": list(out)}


# ---------------------------------------------------------------- 图片引用 → ComfyUI input

# 当前人工会话 id：助手生成时复用它，避免每次做事都在「最近对话」里新开一条
_CTX_SESSION = ""


def publish_result_bytes(data, filename):
    """把结果图同时写进 ComfyUI input，返回可作为 LoadImage 输入的文件名"""
    return comfy.upload_image(data, "cyui_res_" + os.path.basename(filename))


def ensure_input_image(ref):
    """把 /results/xxx、/api/image?type=output... 或 input 文件名统一转成 ComfyUI input 文件名。

    生成结果默认落在 CYUI 的 /results 目录，直接把 /results/xxx.png 交给 LoadImage
    会触发 ComfyUI 的 Prompt outputs failed validation；这里统一回灌一遍。
    """
    ref = str(ref or "").strip()
    if not ref:
        raise AssistantError("缺少图片引用")
    if ref.startswith("/results/"):
        fn = comfy.safe_filename(ref)
        if not fn:
            raise AssistantError("结果图文件名不合法")
        path = os.path.join(RESULTS_DIR, fn)
        if not os.path.isfile(path):
            raise AssistantError("结果图不存在：%s" % fn)
        with open(path, "rb") as f:
            return publish_result_bytes(f.read(), fn)
    if ref.startswith("/api/image") or ref.startswith("/view") or ref.startswith("http"):
        u = urlparse(ref)
        if u.scheme and u.netloc and u.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise AssistantError("不接受外部主机的图片地址")
        q = parse_qs(u.query)
        fn = comfy.safe_filename((q.get("filename") or [""])[0])
        sub = comfy.safe_subfolder((q.get("subfolder") or [""])[0])
        kind = comfy.safe_kind((q.get("type") or ["input"])[0])
        if not fn or sub is None or kind is None:
            raise AssistantError("图片地址参数不合法")
        if kind == "input" and not sub:
            return fn                       # 本来就在 input 里
        raw = comfy.view(fn, sub, kind)
        return publish_result_bytes(raw, ("%s_" % kind) + fn)
    # 纯文件名：既可能是 input 里的名字，也可能是 /results 里的结果图
    base = comfy.safe_filename(ref)
    if not base:
        raise AssistantError("图片文件名不合法")
    p = os.path.join(RESULTS_DIR, base)
    if os.path.isfile(p):
        with open(p, "rb") as f:
            return publish_result_bytes(f.read(), base)
    return base


def image_to_input(ref):
    """给前端拖拽 / 复用结果图用：任意 url → ComfyUI input 文件名"""
    name = ensure_input_image(ref)
    return {"name": name, "url": "/api/image?type=input&filename=" + name}


# ---------------------------------------------------------------- 批量
def _list_images(folder, limit):
    if not folder or not os.path.isdir(folder):
        raise AssistantError("文件夹不存在或不可读：%s" % folder)
    exts = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
    files = [os.path.join(folder, f) for f in sorted(os.listdir(folder))
             if f.lower().endswith(exts)]
    if not files:
        raise AssistantError("文件夹里没有图片：%s" % folder)
    return files[:max(1, min(50, int(limit or 20)))]


def _save_outputs(pid, prompt, skill_name, mode, params, session_id=""):
    """保存结果图：写图库 + 回灌 ComfyUI input，并带上所属会话 id。"""
    hist = comfy.history(pid)
    rec = hist.get(pid)
    if not rec:
        return []
    items = []
    for _nid, out in (rec.get("outputs") or {}).items():
        for img in out.get("images", []) or []:
            fn = img.get("filename")
            if not fn:
                continue
            data = comfy.view(fn, img.get("subfolder", ""), img.get("type", "output"))
            ext = os.path.splitext(fn)[1].lower() or ".png"
            local = "%s_%d%s" % (pid[:8], len(items), ext)
            with open(os.path.join(RESULTS_DIR, local), "wb") as f:
                f.write(data)
            # 同步进 ComfyUI input：后续「把这张图换风格 / 放大」可以直接把它当输入图
            try:
                in_name = publish_result_bytes(data, local)
            except Exception as e:
                comfy.log("结果图回灌 input 失败 %s: %s" % (local, e), "WARN")
                in_name = ""
            w = h = 0
            try:
                im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
                w, h = im.size
            except Exception:
                pass
            items.append({
                "url": "/results/" + local, "remote": fn, "subfolder": img.get("subfolder", ""),
                "input_name": in_name,
                "width": w, "height": h, "prompt_id": pid, "mode": mode,
                "skill": skill_name, "prompt": prompt,
                "name": (prompt or skill_name).strip().split("\n")[0][:40],
                "session_id": session_id or "", "params": params, "ts": time.time(),
            })
    if items:
        store.add_gallery(items)
    return items


def _run_batch(bid, files, skill, prompt_text, params, session_id=""):
    total = len(files)
    for idx, path in enumerate(files):
        with _BATCH_LOCK:
            b = BATCHES.get(bid)
            if not b or b.get("cancelled"):
                return
            b["current"] = os.path.basename(path)
            b["index"] = idx
        try:
            with open(path, "rb") as f:
                raw = f.read()
            name = comfy.upload_image(raw, "batch_%s_%s" % (bid[:6], os.path.basename(path)[:40]))
            text = (skill.get("prompt") or "").replace("{text}", prompt_text or "").strip(" ，,")
            text = text or (prompt_text or skill["name"])
            cfg = workflows.normalize({
                "mode": skill["mode"], "prompt": text,
                "images": [name] if skill["images"] else [],
                "params": dict(params or {}, **(skill.get("params") or {})),
            })
            cfg = _enrich(cfg)
            wf, meta = workflows.build(cfg, prefix="cyui/batch_%s" % bid[:6])
            res = comfy.queue_prompt(wf)
            pid = res.get("prompt_id")
            if not pid:
                raise AssistantError("排队失败")
            deadline = time.time() + 900
            while time.time() < deadline:
                time.sleep(3)
                h = comfy.history(pid)
                rec = h.get(pid)
                if not rec:
                    continue
                st = rec.get("status") or {}
                if st.get("status_str") == "error" or st.get("completed") is False:
                    raise AssistantError("ComfyUI 执行失败")
                if st.get("completed"):
                    items = _save_outputs(pid, text, skill["name"], skill["mode"],
                                          cfg["params"], session_id)
                    if items and session_id:
                        # 批量结果也写进当前对话的消息：助手 / 对话模式 / 自由画布三处一致
                        first = items[0]
                        store.add_message(session_id, {
                            "role": "assistant", "status": "done", "job_id": pid,
                            "mode": skill["mode"], "skill": skill["name"],
                            "content": "批量处理完成，共 %d 张" % len(items),
                            "images": items, "prompt": text, "final_prompt": text,
                            "source": "ai",
                            "meta": {"sampler": skill["name"],
                                     "latent": "%d×%d" % (first.get("width", 0), first.get("height", 0)),
                                     "reference_images": 1, "loras": []},
                        })
                    with _BATCH_LOCK:
                        bb = BATCHES.get(bid)
                        if bb:
                            bb["done"] += 1
                            bb["results"].extend([{
                                "url": i.get("url"), "width": i.get("width"), "height": i.get("height"),
                                "prompt": i.get("prompt"), "name": i.get("name"), "skill": i.get("skill"),
                                "params": i.get("params") or {}, "ts": i.get("ts"),
                                "session_id": session_id or i.get("session_id") or "",
                                "input_name": i.get("input_name") or "",
                                "prompt_id": i.get("prompt_id"),
                            } for i in items])
                    break
            else:
                raise AssistantError("单张处理超时")
        except Exception as e:
            with _BATCH_LOCK:
                bb = BATCHES.get(bid)
                if bb:
                    bb["failed"] += 1
                    bb["errors"].append("%s: %s" % (os.path.basename(path), str(e)[:120]))
    with _BATCH_LOCK:
        b = BATCHES.get(bid)
        if b:
            b["status"] = "done"
            b["finished_at"] = time.time()
            b["current"] = ""


def start_batch(folder, skill_id, prompt="", limit=20, session_id=""):
    skill = SKILL_MAP.get(skill_id)
    if not skill:
        raise AssistantError("未知技能：%s" % skill_id)
    if skill["mode"] not in ("img2img", "edit"):
        raise AssistantError("「%s」不支持批量处理，请选图片处理类技能" % skill["name"])
    files = _list_images(folder, limit)
    # 复用当前人工会话；用户还没打开会话时新建一条，并把 id 返回给前端认领
    label = os.path.basename(folder.rstrip("/\\"))[:20] or "图片"
    sid = store.ensure_session(session_id or None, "助手批量 · %s" % label)
    bid = uuid.uuid4().hex[:10]
    BATCHES[bid] = {
        "id": bid, "folder": folder, "skill": skill["name"], "skill_id": skill_id,
        "session_id": sid,
        "total": len(files), "done": 0, "failed": 0, "index": 0, "current": "",
        "status": "running", "results": [], "errors": [], "started_at": time.time(),
    }
    t = threading.Thread(target=_run_batch, args=(bid, files, skill, prompt, {}, sid), daemon=True)
    t.start()
    comfy.log("助手批量任务 %s · %s · %d 张 · 会话 %s" % (bid, skill["name"], len(files), sid), "INFO")
    return {"batch_id": bid, "session_id": sid, "total": len(files), "skill": skill["name"],
            "note": "后台逐张执行，可用 batch_status 查询进度"}


def batch_status(bid):
    b = BATCHES.get(bid)
    if not b:
        raise AssistantError("批量任务不存在：%s" % bid)
    return {k: b[k] for k in ("id", "folder", "skill", "session_id", "total", "done", "failed",
                              "status", "current", "results", "errors")}


# ---------------------------------------------------------------- 工具实现
def _tool_list_skills(**kw):
    return {"skills": public_skills()}


def _tool_list_loras(query="", limit=12, **kw):
    """按关键词搜 LoRA。给 AI 用：先搜，再决定加不加。"""
    pool = lora_inventory()
    items = search_loras(query, limit)
    out = {
        "query": str(query or ""),
        "total": len(pool),
        "count": len(items),
        "items": items,
    }
    if not pool:
        out["note"] = "ComfyUI 里还没有任何 LoRA（models/loras 为空），只能纯提示词生成"
    elif not items:
        out["note"] = ("没有匹配「%s」的 LoRA。改用纯提示词生成，并如实告诉用户本地没有对口的 LoRA，"
                       "不要编造文件名" % (query or ""))
    return out


def _tool_generate_images(prompt="", skill_id="", mode="", image_names=None, size="", count=1,
                          image_name="", images=None, loras=None, params=None, polish=False,
                          **kw):
    # 模型有时会把参数名写成 image_name / images：以前被 **kw 静默吞掉，
    # 参考图直接丢失、退化成从零画一张。这里统一收口。
    refs = image_names if image_names is not None else (images if images is not None else image_name)
    if isinstance(refs, str):
        refs = [x.strip() for x in refs.replace("，", ",").replace(";", ",").split(",") if x.strip()]
    # DeepSeek 可能把上一步的 /results/xxx.png 或 /api/image?... 直接传回来，
    # 统一回灌成 ComfyUI input 文件名，避免 Prompt outputs failed validation
    refs = [ensure_input_image(n) for n in (refs or []) if n][:2]

    skill = SKILL_MAP.get(skill_id) if skill_id else None
    if skill:
        if skill["mode"] not in ("text2img", "img2img", "edit"):
            # 高清放大 / 提示词类技能不该走 generate_images：静默降级会跑错工作流
            raise AssistantError(
                "技能「%s」属于 %s 类：放大请用 upscale_image，提示词请用 polish_prompt / reverse_prompt"
                % (skill["name"], skill["mode"]))
        # 技能自带参考图要求：给不够就直接说清楚，不要让模型换成文生图瞎画
        need = int(skill.get("images") or 0)
        if need and len(refs) < need:
            raise AssistantError(
                "「%s」需要 %d 张参考图，当前只给了 %d 张。请让用户先上传图片，"
                "或明确告诉用户缺图；不要改成文生图硬画。" % (skill["name"], need, len(refs)))
        template = skill.get("prompt") or ""
        if template:
            merged = template.replace("{text}", prompt or "").strip(" ，,")
            if prompt and "{text}" not in template:
                merged = template + "。" + prompt
            prompt = merged or template
        # 图生图类技能只吃一张首图，多传会被当成多图编辑、语义跑偏
        if skill["mode"] == "img2img":
            refs = refs[:1]

    prompt = (prompt or "").strip()
    if not prompt:
        raise AssistantError("缺少 prompt：先把用户需求扩写成完整画面提示词再提交")

    # 润色：用户明确要求「润色一下 / 优化提示词」时，先在本地 Qwen3-VL 过一遍再提交
    polished = False
    if polish:
        try:
            out = _tool_polish_prompt(text=prompt)
            if (out.get("polished") or "").strip():
                prompt = out["polished"].strip()
                polished = True
        except Exception as e:
            comfy.log("助手润色失败，用原文：%s" % e, "WARN")

    # 助手不提供局部重绘：一律走「编辑合一」的收敛逻辑（有图 → edit）
    real_mode = resolve_mode(skill["mode"] if skill else mode, refs, prompt)

    # 参数三层：用户界面那套（底座）→ 技能自带 → 本轮 AI 显式。
    # 底座必须带上，否则「我在抽屉里设了 30 步 / 16:9，AI 一生成又回到 8 步 1:1」。
    ai_patch, ai_rejected, ai_notes = _clean_param_patch(params or {}, _catalog_or_empty())
    merged = workspace_params()
    merged.update(dict(skill.get("params") or {}) if skill else {})
    merged.update(ai_patch)
    # edit / text2img 都是整幅重绘：Qwen 的编辑走参考图 latent 保图，
    # 而不是靠低 denoise 硬留原像素；denoise < 1 反而会让指令失效、原图原样回来
    # （只有 img2img 语义才吃 denoise，而 resolve_mode 会把它收敛成 edit，所以这里恒定 1.0）
    merged["denoise"] = 1.0
    # 继承用户在参数抽屉里选的采样方案：不继承的话切到 Viggle 也白切，
    # 加速 LoRA 会一直被当成「方案不是 viggle」而剔除
    if _CTX_SAMPLING and not merged.get("sampling"):
        merged["sampling"] = _CTX_SAMPLING
    # 采样方案优先级：AI 显式传 > 用户这句话里说的 > 界面当前 > 默认 turbo。
    # 用户嘴上说「用 viggle 5 步」而界面还停在 turbo 时，必须以话为准。
    _SCHEME_DEFAULTS = {"turbo": (8, 1.0), "standard": (30, 4.0),
                        "viggle": (workflows.VIGGLE_STEPS, 1.0)}
    if ai_patch.get("sampling"):
        pass                                   # 已经是 AI 显式指定的（配套值已在 _clean_param_patch 里补过）
    else:
        _inferred = sampling_from_text(prompt)
        if _inferred and _inferred != str(merged.get("sampling") or ""):
            # 方案变了：配套的步数 / CFG 必须跟着变，否则会得到「standard + 8 步」这种无效组合
            merged["sampling"] = _inferred
            _ds, _dc = _SCHEME_DEFAULTS.get(_inferred, (8, 1.0))
            if "steps" not in ai_patch:
                merged["steps"] = _ds
            if "cfg" not in ai_patch:
                merged["cfg"] = _dc
            if _inferred == "viggle":
                merged["negative"] = ""
            comfy.log("从提示词识别采样方案：%s（步数 %s / CFG %s）"
                      % (_inferred, merged.get("steps"), merged.get("cfg")), "INFO")
    if not merged.get("sampling"):
        merged["sampling"] = workflows.DEFAULTS.get("sampling") or "turbo"
    if merged.get("sampling") == "viggle":
        merged["steps"] = workflows.VIGGLE_STEPS
        merged["cfg"] = 1.0
        merged["negative"] = ""

    # Viggle 是一套组合（5 步 + 加速 LoRA + 标准底模），不是改个步数就行：
    # 这里与手动生成共用 prepare_sampling，自动挂 LoRA、必要时换标准底模。
    cat_now = _catalog_or_empty()
    ok_s, err_s, notes_s = workflows.prepare_sampling(merged, cat_now)
    if not ok_s:
        raise AssistantError(err_s)
    if notes_s:
        ai_notes = list(ai_notes) + notes_s
        comfy.log("助手采样方案自动补齐：" + "；".join(notes_s), "INFO")

    # 尺寸：显式 size > AI 传的宽高 > 从提示词里兜底解析 > 用户界面的画布设置
    wh = parse_size(size) or size_from_text(prompt)
    if wh:
        merged.update({"width": wh[0], "height": wh[1], "custom_size": True})
        if not size:
            comfy.log("未传 size，从提示词解析出画布 %d×%d" % wh, "INFO")

    try:
        cnt = max(1, min(8, int(count or 1)))
    except Exception:
        cnt = 1
    # 用户没说要多张时强制 1 张：这是「一条指令出两张图」的硬闸门
    if cnt > 1 and not _CTX_ALLOW_MULTI:
        cnt = 1
    merged["batch"] = cnt

    # LoRA：用户手选锁定的排在前面（每轮强制带上），AI 自己挑的追加在后，按名字去重。
    # 加速蒸馏 LoRA 只能配 Viggle 方案，其它方案里挂了会毁图，这里直接剔掉并回报。
    picked = _norm_loras(loras)
    merged_loras, seen = [], set()
    for it in _norm_loras(_CTX_USER_LORAS) + picked:
        if it["name"] in seen:
            continue
        seen.add(it["name"])
        merged_loras.append(it)
    sampling = str(merged.get("sampling") or _CTX_SAMPLING
                   or workflows.DEFAULTS.get("sampling") or "turbo")
    dropped = []
    if sampling != "viggle":
        keep = []
        for it in merged_loras:
            if is_accel_lora(it["name"]):
                dropped.append(it["name"])
            else:
                keep.append(it)
        merged_loras = keep
    merged_loras = merged_loras[:LORA_LIMIT]

    info = submit_generation(prompt, real_mode, refs, merged,
                             title=(skill["name"] if skill else prompt[:20]) or "AI 助手",
                             loras=merged_loras)
    info["mode"] = real_mode
    info["count"] = cnt
    info["size"] = "%d×%d" % (merged.get("width") or 1024, merged.get("height") or 1024)
    info["params_used"] = {k: merged.get(k) for k in
                           ("sampling", "steps", "cfg", "sampler", "scheduler", "seed",
                            "size_mode", "width", "height", "batch", "unet")}
    if polished:
        info["polished"] = True
    if ai_rejected:
        info["rejected_params"] = ai_rejected
    if ai_notes:
        info["param_notes"] = ai_notes
    if notes_s:
        info["sampling_notes"] = notes_s   # 自动挂 LoRA / 换底模的说明，必须回给用户
    if merged_loras:
        info["loras"] = [l["name"] for l in merged_loras]
    if dropped:
        info["dropped_loras"] = dropped
        info["lora_note"] = ("%s 是加速蒸馏 LoRA，只能在采样方案 Viggle 下叠加，本次已忽略"
                             % "、".join(dropped))
    info["note"] = ("已提交 %s 张（%s · %s %s 步 / CFG %s），结果会自动出现在对话与图库；不要重复提交"
                    % (cnt, info["size"], sampling, merged.get("steps"), merged.get("cfg")))
    if notes_s:
        info["note"] += "。" + "；".join(notes_s)
    if skill:
        info["skill_id"] = skill["id"]
    return info


def _tool_upscale_image(image_name="", target="default", **kw):
    if not image_name:
        raise AssistantError("缺少 image_name")
    return submit_upscale(ensure_input_image(image_name), target)


def _tool_polish_prompt(text="", **kw):
    if not (text or "").strip():
        raise AssistantError("缺少 text")
    out, cost = llm.polish(text)
    return {"polished": out, "seconds": cost}


def _tool_reverse_prompt(image_name="", **kw):
    if not image_name:
        raise AssistantError("缺少 image_name")
    out, cost = llm.reverse(ensure_input_image(image_name))
    return {"prompt": out, "seconds": cost}


def _tool_batch_process(folder="", skill_id="", prompt="", limit=20, **kw):
    return start_batch(folder, skill_id, prompt, limit, session_id=_CTX_SESSION)


def _tool_batch_status(batch_id="", **kw):
    return batch_status(batch_id)


def _tool_wait_batch(batch_id="", timeout=120, **kw):
    try:
        timeout = max(10, min(600, int(timeout or 120)))
    except Exception:
        timeout = 120
    t0 = time.time()
    while time.time() - t0 < timeout:
        if _CHAT_CANCELS.get(_CTX_STREAM):
            return {"status": "cancelled", "note": "用户已停止等待"}
        b = BATCHES.get(batch_id)
        if not b:
            return {"error": "批量任务不存在：%s" % batch_id}
        if b["status"] == "done":
            return {"status": "done", "done": b["done"], "failed": b["failed"],
                    "total": b["total"],
                    "results": [{"url": r.get("url"), "name": r.get("name"),
                                 "session_id": r.get("session_id")}
                                for r in b["results"][:12]],
                    "errors": b["errors"][:5]}
        time.sleep(2)
    b = BATCHES.get(batch_id) or {}
    return {"status": "timeout", "done": b.get("done", 0), "failed": b.get("failed", 0),
            "total": b.get("total", 0),
            "note": "等待超时，任务仍在后台跑，可用 batch_status 继续查询"}


def _tool_list_gallery(limit=6, **kw):
    try:
        n = max(1, min(24, int(limit or 6)))
    except Exception:
        n = 6
    items = store.list_gallery(n)
    return {"items": [{"name": g.get("name"), "width": g.get("width"), "height": g.get("height"),
                       "prompt": (g.get("prompt") or "")[:200], "url": g.get("url"),
                       "skill": g.get("skill")} for g in items]}


TOOL_IMPL = {
    "list_skills": _tool_list_skills,
    "list_loras": _tool_list_loras,
    "get_workspace": _tool_get_workspace,
    "set_workspace": _tool_set_workspace,
    "generate_images": _tool_generate_images,
    "upscale_image": _tool_upscale_image,
    "polish_prompt": _tool_polish_prompt,
    "reverse_prompt": _tool_reverse_prompt,
    "batch_process": _tool_batch_process,
    "batch_status": _tool_batch_status,
    "wait_batch": _tool_wait_batch,
    "list_gallery": _tool_list_gallery,
}


# ---------------------------------------------------------------- 停止机制
# stream_id -> True；/api/assistant/stop 置位，chat_stream 在每步之间检查
_CHAT_CANCELS = {}
_CTX_STREAM = ""
# chat_stream 共用的单工作线程池：LLM 调用与工具执行放进线程，主生成器轮询取消标记
_THREAD_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="cyui-ai")


# ---------------------------------------------------------------- DeepSeek 对话
def _turn_allow_multi(messages):
    """用户这句指令里是否明确要「好几张」。没有 → count 强制 1。"""
    for m in reversed(list(messages or [])):
        if m.get("role") == "user" and (m.get("content") or "").strip():
            return bool(_MULTI_RE.search(str(m.get("content"))))
    return False


def _dedupe_key(fn, args):
    """同一条指令里重复提交同一个任务 = 一张图出两张的唯一硬原因，这里直接拦掉。"""
    if fn not in ("generate_images", "upscale_image"):
        return ""
    try:
        return fn + "|" + json.dumps(args or {}, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        return ""


def _handle_tool(fn, args, repeat_of=None):
    """统一入口：相同参数重复调用时原样返回上次结果，不再真的提交一次。"""
    if repeat_of is not None:
        out = dict(repeat_of)
        out["duplicate"] = True
        out["note"] = "该任务本轮已经提交过，job_id 不变，系统已忽略此次重复提交"
        return out
    if fn not in TOOL_IMPL:
        return {"error": "未知工具 %s" % fn}
    return TOOL_IMPL[fn](**args)


def _workspace_brief():
    """把工作台现状压成一段话：模型不用每轮都调 get_workspace 也知道用户设了什么"""
    ws = _CTX_WORKSPACE if isinstance(_CTX_WORKSPACE, dict) else {}
    if not ws:
        return ""
    p = workspace_params()
    bits = []
    if ws.get("skill_name"):
        bits.append("界面技能「%s」" % ws["skill_name"])
    view = {"home": "首页", "chat": "对话", "canvas": "自由画布",
            "gallery": "作品库", "settings": "设置"}.get(ws.get("view") or "", "")
    if view:
        bits.append("当前在" + view)
    mode = p.get("size_mode") or "auto"
    size = {"auto": "跟随图1", "fixed": "按比例/手填", "native": "原图像素"}.get(mode, mode)
    if p.get("width") and p.get("height"):
        size += " %s×%s" % (p["width"], p["height"])
    bits.append("画布 " + size)
    bits.append("采样 %s · %s 步 · CFG %s · %s/%s" % (
        p.get("sampling") or "turbo", p.get("steps") if p.get("steps") is not None else "默认",
        p.get("cfg") if p.get("cfg") is not None else "默认",
        p.get("sampler") or "euler", p.get("scheduler") or "simple"))
    # 加速 LoRA 是否装好：没装时选 viggle 会直接失败，让模型提前知道别乱选
    if (p.get("sampling") or "") == "viggle":
        try:
            cat = comfy.cached_catalog() or {}
            ready = bool(((cat.get("accel") or {}).get("viggle") or {}).get("lora"))
        except Exception:
            ready = True      # 读不到清单就不断言，避免误报
        if not ready:
            bits.append("⚠ 本地未安装 5 步加速 LoRA（选 viggle 会报错，需先把文件放进 models/loras）")
    if p.get("batch") and int(p.get("batch") or 1) > 1:
        bits.append("每次 %s 张" % p["batch"])
    if p.get("seed") not in (None, -1, "-1"):
        bits.append("固定种子 %s" % p["seed"])
    if (p.get("negative") or "").strip():
        bits.append("负向「%s」" % str(p["negative"]).strip()[:40])
    if p.get("polish"):
        bits.append("生成前润色 开")
    line = ("\n\n【用户当前工作台】" + "；".join(bits) +
            "\ngenerate_images 默认就用这套参数，你只在 params 里写要改的项；"
            "想改界面本身（让用户下次也生效）用 set_workspace。")
    draft = str(ws.get("draft") or "").strip()
    if draft:
        line += "\n输入框里已有一段文字：「%s」——用户说「接着改 / 换一版」时指的是它。" % draft[:120]
    imgs = ws.get("images") or []
    if imgs:
        line += "\n当前已带参考图：%s" % "、".join(str(x) for x in imgs[:4])
    return line


def _system_prompt():
    """基础提示词 + 本轮上下文（用户锁定的 LoRA 要让模型知道，不然它会重复添加）"""
    sp = SYSTEM_PROMPT + _workspace_brief()
    locked = _norm_loras(_CTX_USER_LORAS)
    if locked:
        names = "、".join("%s（强度 %.2f）" % (l["name"], l["strength"]) for l in locked)
        sp += ("\n\n【用户已锁定 LoRA】%s\n这些是用户在手选面板里勾的，每轮都会自动附加，"
               "你**不需要也不能**再通过 loras 参数添加它们；也不要写进提示词正文。"
               "如果用户想换掉，提示他到 ⭐ LoRA 面板里取消。" % names)
    return sp


def chat(messages, api_key, model="deepseek-chat", max_steps=4, session_id="",
         user_loras=None, sampling="", workspace=None):
    global _CTX_SESSION, _CTX_ALLOW_MULTI, _CTX_USER_LORAS, _CTX_SAMPLING, _CTX_WORKSPACE
    if not api_key:
        raise AssistantError("请先在「全局设置 → 提示词润色 / 反推」里填写 DeepSeek API Key")
    # 助手与人工「最近对话」打通：本次会话里所有生成都写进同一条对话
    _CTX_SESSION = str(session_id or "")
    _CTX_ALLOW_MULTI = _turn_allow_multi(messages)
    _CTX_USER_LORAS = _norm_loras(user_loras)
    _CTX_SAMPLING = str(sampling or "")
    _CTX_WORKSPACE = workspace if isinstance(workspace, dict) else {}

    msgs = [{"role": "system", "content": _system_prompt()}]
    # 只带最近 30 条，避免前端把整个历史塞进来导致上下文爆炸 / 费用失控
    hist = [m for m in (messages or [])[:200]
            if m.get("role") in ("user", "assistant") and m.get("content")]
    for m in hist[-30:]:
        msgs.append({"role": m["role"], "content": str(m["content"])[:8000]})

    s = requests.Session()
    s.trust_env = False
    events = []
    submitted = {}
    for _ in range(max_steps):
        payload = {
            "model": model or "deepseek-chat",
            "messages": msgs,
            "tools": TOOLS,
            "tool_choice": "auto",
            "temperature": 0.4,
            "stream": False,
        }
        try:
            r = s.post("https://api.deepseek.com/chat/completions",
                       headers={"Authorization": "Bearer " + api_key,
                                "Content-Type": "application/json"},
                       json=payload, timeout=180)
        except Exception as e:
            raise AssistantError("DeepSeek 请求失败：%s" % str(e)[:160])
        if r.status_code != 200:
            raise AssistantError("DeepSeek 返回 %d：%s" % (r.status_code, r.text[:220]))
        try:
            msg = (r.json().get("choices") or [{}])[0].get("message") or {}
        except Exception as e:
            raise AssistantError("DeepSeek 返回解析失败：%s" % str(e)[:120])

        calls = msg.get("tool_calls") or []
        if not calls:
            return {"reply": (msg.get("content") or "").strip(), "events": events}

        msgs.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            fn = (c.get("function") or {}).get("name")
            raw_args = (c.get("function") or {}).get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
            except Exception:
                args = {}
            try:
                key = _dedupe_key(fn, args)
                result = _handle_tool(fn, args, repeat_of=submitted.get(key) if key else None)
                if key and key not in submitted and isinstance(result, dict) and result.get("job_id"):
                    submitted[key] = result
            except Exception as e:
                result = {"error": str(e)[:300]}
            events.append({"tool": fn, "args": args, "result": result})
            msgs.append({"role": "tool", "tool_call_id": c.get("id") or fn,
                         "content": json.dumps(result, ensure_ascii=False)[:6000]})

    return {"reply": "已经执行完工具调用，但还需要一步汇总。请再发一句「继续」让我总结结果。",
            "events": events}


# ---------------------------------------------------------------- 流式对话（SSE）
# 逐事件产出：start / step_start / step_result / reply / stopped / error / done
# 每一步之间都检查停止标记，LLM 调用与工具执行都在工作线程里轮询取消，
# 所以「停止」可以真正截断正在进行的思考 / 工具，而不是等它跑完。
def chat_stream(messages, api_key, model="deepseek-chat", max_steps=8, session_id="",
                user_loras=None, sampling="", workspace=None):
    global _CTX_SESSION, _CTX_STREAM, _CTX_ALLOW_MULTI, _CTX_USER_LORAS, _CTX_SAMPLING, _CTX_WORKSPACE
    if not api_key:
        raise AssistantError("请先在「全局设置 → 提示词润色 / 反推」里填写 DeepSeek API Key")
    _CTX_SESSION = str(session_id or "")
    _CTX_ALLOW_MULTI = _turn_allow_multi(messages)
    _CTX_USER_LORAS = _norm_loras(user_loras)
    _CTX_SAMPLING = str(sampling or "")
    # 工作台快照：本轮所有"按用户设置生成"都从它出发
    _CTX_WORKSPACE = workspace if isinstance(workspace, dict) else {}
    sid = uuid.uuid4().hex[:12]
    _CTX_STREAM = sid
    _CHAT_CANCELS[sid] = False

    msgs = [{"role": "system", "content": _system_prompt()}]
    hist = [m for m in (messages or [])[:200]
            if m.get("role") in ("user", "assistant") and m.get("content")]
    for m in hist[-30:]:
        msgs.append({"role": m["role"], "content": str(m["content"])[:8000]})

    try:
        max_steps = max(1, min(16, int(max_steps or 8)))
    except Exception:
        max_steps = 8

    def cancelled():
        return _CHAT_CANCELS.get(sid)

    def llm_call(payload):
        s = requests.Session()
        s.trust_env = False
        r = s.post("https://api.deepseek.com/chat/completions",
                   headers={"Authorization": "Bearer " + api_key,
                            "Content-Type": "application/json"},
                   json=payload, timeout=180)
        if r.status_code != 200:
            raise AssistantError("DeepSeek 返回 %d：%s" % (r.status_code, r.text[:220]))
        return r.json()

    ex = _THREAD_POOL
    events = []
    submitted = {}

    def llm_step(payload):
        """可停止的单次 LLM 调用：轮询 future，同时每 0.4s 检查停止标记"""
        fut = ex.submit(llm_call, payload)
        while True:
            if cancelled():
                fut.cancel()
                return None
            try:
                return fut.result(timeout=0.4)
            except concurrent.futures.TimeoutError:
                continue

    def run_tool(fn, args, repeat_of=None):
        """可停止的工具执行：wait_batch 内部也自查取消标记"""
        if repeat_of is not None:
            # 同一条指令重复提交同一个任务：原样返回上次结果，不再真跑一次
            out = dict(repeat_of)
            out["duplicate"] = True
            out["note"] = "该任务本轮已经提交过，job_id 不变，系统已忽略此次重复提交"
            return out
        if fn not in TOOL_IMPL:
            return {"error": "未知工具 %s" % fn}
        fut = ex.submit(TOOL_IMPL[fn], **args)
        while True:
            if cancelled():
                return {"__cancelled": True}
            try:
                return fut.result(timeout=0.4)
            except concurrent.futures.TimeoutError:
                continue

    yield {"type": "start", "stream_id": sid}
    try:
        for _step in range(max_steps):
            if cancelled():
                yield {"type": "stopped", "steps": len(events)}
                return
            payload = {
                "model": model or "deepseek-chat",
                "messages": msgs,
                "tools": TOOLS,
                "tool_choice": "auto",
                "temperature": 0.4,
                "stream": False,
            }
            try:
                data = llm_step(payload)
            except AssistantError as e:
                yield {"type": "error", "error": str(e)}
                return
            except Exception as e:
                yield {"type": "error", "error": "DeepSeek 请求失败：%s" % str(e)[:160]}
                return
            if data is None:  # 已停止
                yield {"type": "stopped", "steps": len(events)}
                return
            try:
                msg = (data.get("choices") or [{}])[0].get("message") or {}
            except Exception as e:
                yield {"type": "error", "error": "DeepSeek 返回解析失败：%s" % str(e)[:120]}
                return

            calls = msg.get("tool_calls") or []
            if not calls:
                reply = (msg.get("content") or "").strip()
                yield {"type": "reply", "text": reply}
                yield {"type": "done", "events": events, "reply": reply}
                return

            msgs.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
            for c in calls:
                if cancelled():
                    yield {"type": "stopped", "steps": len(events)}
                    return
                fn = (c.get("function") or {}).get("name")
                raw_args = (c.get("function") or {}).get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
                except Exception:
                    args = {}
                idx = len(events)
                yield {"type": "step_start", "i": idx, "tool": fn, "args": args}
                key = _dedupe_key(fn, args)
                repeat = submitted.get(key) if key else None
                try:
                    result = run_tool(fn, args or {}, repeat_of=repeat)
                except Exception as e:
                    result = {"error": str(e)[:300]}
                if key and not repeat and isinstance(result, dict) and result.get("job_id"):
                    submitted[key] = result
                if isinstance(result, dict) and result.get("__cancelled"):
                    events.append({"tool": fn, "args": args, "result": {"error": "用户停止"}})
                    yield {"type": "stopped", "steps": len(events)}
                    return
                events.append({"tool": fn, "args": args, "result": result})
                yield {"type": "step_result", "i": idx, "tool": fn, "args": args, "result": result}
                msgs.append({"role": "tool", "tool_call_id": c.get("id") or fn,
                             "content": json.dumps(result, ensure_ascii=False)[:6000]})

        # 到达步数上限：不带 tools 再调一次，强制模型用一段话收尾，不再让用户手动「继续」
        if cancelled():
            yield {"type": "stopped", "steps": len(events)}
            return
        payload = {"model": model or "deepseek-chat", "messages": msgs,
                   "temperature": 0.4, "stream": False}
        try:
            data = llm_step(payload)
        except Exception as e:
            yield {"type": "error", "error": "收尾汇总失败：%s" % str(e)[:160]}
            return
        if data is None:
            yield {"type": "stopped", "steps": len(events)}
            return
        reply = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") \
            or "已执行完 %d 步操作，结果会自动出现在对话与图库。" % len(events)
        yield {"type": "reply", "text": reply.strip()}
        yield {"type": "done", "events": events, "reply": reply.strip()}
    finally:
        if not _CHAT_CANCELS.get(sid):
            _CHAT_CANCELS.pop(sid, None)  # 停止过的保留标记，wait_batch 靠它提前退出
        _CTX_STREAM = ""
