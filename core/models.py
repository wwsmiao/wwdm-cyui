"""模型名 / LoRA 名与「当前 ComfyUI 实例」对齐。

换实例（尤其换到远程实例）最容易踩的坑：工作流里写死的是本地文件名，而远端同一个
模型常常只是路径前缀、量化后缀或大小写不同：

    qwen3vl_32b_minimax_h3_nvfp4_awq      → text_encoders/qwen3vl_32b_..._awq
    MiniMax_H3_Ref2VA_pruned_nvfp4        → minimax_h3_ref2va_pruned_int8_convrot
    z-image-turbo-fp8-e4m3fn              → z_image_turbo_bf16 / z_image_turbo_int8_convrot
    qwt-xiayu\\qwt-xiayu-v1               → qwt-xiayu/qwt-xiayu-v1（只是路径分隔符不同）

所以提交前统一做一次「解析」：完全一致 → 忽略大小写的全路径 → 同名文件 → 同系列
（去掉量化后缀后同名，按量化偏好挑一个）→ 放弃。放弃时：
  · LoRA：把节点从图里摘掉（下游 model 直连上游），任务带一条提示
  · 底模 / VAE / CLIP：直接报错并列出候选，绝不悄悄换成别的模型
"""
import re

# 输入字段 → 模型种类。只认这些字段，避免把普通字符串参数当模型名去改
MODEL_FIELDS = {
    "ckpt_name": "ckpt",
    "unet_name": "unet",
    "clip_name": "clip",
    "clip_name1": "clip",
    "clip_name2": "clip",
    "clip_name3": "clip",
    "vae_name": "vae",
    "lora_name": "lora",
    "model_name": "upscale",
    "control_net_name": "controlnet",
    "clip_vision_name": "clip_vision",
}

# 这些种类缺了就一定跑不起来；lora 缺失可以摘掉
REQUIRED_KINDS = ("ckpt", "unet", "clip", "vae", "upscale", "controlnet", "clip_vision")

# 各类模型对应的「查询入口」：拿当前实例的可选清单用
KIND_SOURCES = {
    "ckpt": ("CheckpointLoaderSimple", "ckpt_name"),
    "unet": ("UNETLoader", "unet_name"),
    "clip": ("CLIPLoader", "clip_name"),
    "vae": ("VAELoader", "vae_name"),
    "lora": ("LoraLoaderModelOnly", "lora_name"),
    "upscale": ("UpscaleModelLoader", "model_name"),
}

# 量化 / 结构后缀：比对「同系列」时忽略
_DROP_TOKENS = {
    "fp8", "fp16", "bf16", "fp32", "int8", "int4", "nvfp4", "mxfp8", "fp4", "awq", "w4a8",
    "e4m3fn", "e5m2", "scaled", "convrot", "pruned", "quant", "quanto",
}
# 结构化词：优先保留，别把 turbo / pruned 版本换掉
_STRUCT_TOKENS = {"turbo", "distill", "distilled", "lightning", "pruned", "ref2v", "fl2v",
                  "ref2va", "fl2va", "inpaint", "inpainting", "ema"}

# 量化偏好：按原模型精度档选同类替代
_QUANT_ORDER = {
    "high": ["bf16", "fp16", "fp32", "fp8_scaled", "fp8_e4m3fn", "fp8", "int8", "nvfp4"],
    "fp8": ["fp8_scaled", "fp8_e4m3fn", "fp8", "bf16", "fp16", "int8", "nvfp4"],
    "low": ["int8_convrot", "int8", "nvfp4", "mxfp8", "fp4", "fp8_scaled", "fp8", "bf16", "fp16"],
}

# 同系列但命名规律对不上时，写死候选（按优先级）
_FAMILY_RULES = [
    ("unet", r"z[-_]image[-_]turbo",
     ["z_image_turbo_bf16.safetensors", "z_image_turbo_int8_convrot.safetensors",
      "z_image_turbo_nvfp4.safetensors", "z-image-turbo-fp8-e4m3fn.safetensors"]),
]


def norm(value) -> str:
    return str(value or "").replace("\\", "/").strip()


def basename(value) -> str:
    return norm(value).rsplit("/", 1)[-1]


def _tokens(name: str) -> list:
    return [t for t in re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", basename(name).lower()) if t]


def _stem(name: str) -> str:
    """去掉扩展名、量化与结构后缀后的「同系列指纹」。"""
    parts = [t for t in _tokens(name) if t not in _DROP_TOKENS]
    if parts and parts[-1] in ("safetensors", "sft", "pt", "ckpt", "bin", "gguf"):
        parts.pop()
    return "_".join(parts)


def _quant_class(name: str) -> str:
    low = basename(name).lower()
    if any(t in low for t in ("bf16", "fp16", "fp32")):
        return "high"
    if "fp8" in low:
        return "fp8"
    return "low"


def _quant_rank(name: str, original: str) -> tuple:
    """按替代偏好排序：先看是否保留了原模型的结构词，再看量化档。"""
    low = basename(name).lower()
    original_tokens = set(_tokens(original))
    struct_hits = sum(1 for t in _STRUCT_TOKENS if t in original_tokens and t in _tokens(name))
    order = _QUANT_ORDER[_quant_class(original)]
    rank = len(order)
    for index, token in enumerate(order):
        if token in low:
            rank = index
            break
    return (-struct_hits, rank, len(norm(name)))


def combo_options(spec) -> list:
    """object_info 里的下拉定义 → 可选值列表（兼容新旧两种写法）。"""
    if not isinstance(spec, list) or not spec:
        return []
    if isinstance(spec[0], list):
        return list(spec[0])
    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return list(spec[1].get("options") or [])
    return []


def _minimax_turbo(value: str, options: list) -> str | None:
    """MiniMax 的加速 LoRA：本地和远端命名完全不同，按「首尾帧/参考 + 步数」对。

    本地 minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16  ↔  远端 minimax_h3_turbo_4step_comfyui_pruned
    本地 minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16   ↔  远端 minimax_h3_fl2va_pdd_acc_8step_comfyui
    """
    match = re.search(r"minimax_h3_(ref2v|fl2v|ref2va|fl2va).*?(\d+)step", basename(value), re.I)
    if not match:
        return None
    family = "ref2v" if match.group(1).lower().startswith("ref2v") else "fl2v"
    steps = match.group(2)
    rows = [(option, basename(option).lower()) for option in options]
    tiers = (
        lambda name: "minimax_h3" in name and family in name and f"{steps}step" in name,
        lambda name: "minimax_h3" in name and f"{steps}step" in name and "turbo" in name,
        lambda name: "minimax_h3" in name and family in name and "turbo" in name,
        lambda name: "minimax_h3" in name and "turbo" in name,
    )
    for tier in tiers:
        hits = [option for option, name in rows if tier(name)]
        if hits:
            # 优先 comfyui 原生格式的名字，再按量化档
            return sorted(hits, key=lambda item: (
                "comfyui" not in basename(item).lower(), _quant_rank(item, value)))[0]
    return None


def resolve(kind: str, value, options: list) -> str | None:
    """把工作流里的模型名映射到 options（当前实例的可选清单）里的一个；找不到返回 None。"""
    if not value or not options:
        return value
    value = str(value)
    # 1) 完全一致
    if value in options:
        return value
    target = norm(value).lower()
    # 2) 忽略大小写 / 分隔符
    for option in options:
        if norm(option).lower() == target:
            return option
    # 3) 同名文件（解决子目录前缀不同：text_encoders/xxx.safetensors）
    name = basename(value).lower()
    same = [option for option in options if basename(option).lower() == name]
    if same:
        return min(same, key=lambda item: len(norm(item)))
    # 4) 写死的同系列候选
    for rule_kind, pattern, candidates in _FAMILY_RULES:
        if rule_kind != kind or not re.search(pattern, basename(value), re.I):
            continue
        for candidate in candidates:
            for option in options:
                if basename(option).lower() == candidate.lower():
                    return option
    # 4.5) MiniMax 加速 LoRA：按首尾帧/参考 + 步数对应
    if kind == "lora":
        hit = _minimax_turbo(value, options)
        if hit:
            return hit
    # 5) 同系列（去量化后缀后同名），按量化偏好挑
    stem = _stem(value)
    if stem:
        same_family = [option for option in options if _stem(option) == stem]
        if same_family:
            return sorted(same_family, key=lambda item: _quant_rank(item, value))[0]
    return None


def explain(kind: str, value: str, options: list, limit: int = 3) -> str:
    """找不到时给一句人话 + 几个最像的候选。"""
    stem = _stem(value)
    near = [option for option in options if stem and stem[:6] in _stem(option)][:limit]
    label = {"ckpt": "底模", "unet": "UNet", "clip": "CLIP", "vae": "VAE",
             "lora": "LoRA", "upscale": "放大模型"}.get(kind, "模型")
    text = f"当前 ComfyUI 实例里没有这个{label}：{value}"
    if near:
        text += "；最接近的有：" + "、".join(near)
    return text
