# -*- coding: utf-8 -*-
"""Qwen-Image 2.1 Turbo 参数化工作流引擎

统一节点链：
    UNETLoader → [LoRA 链] → QwenImage21Cache
    CLIPLoader / VAELoader
    LoadImage(1..16) → TextEncodeQwenImage21.images.image_N
    TextEncodeQwenImage21 ── positive/negative/latent
    [SetLatentNoiseMask] → 采样链 → VAEDecode → SaveImage

Turbo 使用官方 8 步固定 sigma 调度（SamplerCustomAdvanced），
普通模型可切换 standard（KSampler + 自定义步数）。

Viggle turbo（``sampling="viggle"``）是在标准底模上叠加的 5 步蒸馏 LoRA，
官方调度为 5 步、固定 sigma、cfg 1.0、无负向提示词、LoRA 强度固定 1.0。
"""
import math
import os
import random
import re
import time

# 官方 Qwen-Image 2.1 Turbo 8 步蒸馏 sigma 表（末位 0 表示走到干净图像）
TURBO_SIGMAS = "1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"
_TURBO_BASE = [float(x) for x in TURBO_SIGMAS.split(",")]

# Viggle turbo v0.2 官方调度：5 步 / sigma=[1.0, 0.875, 0.75, 0.5, 0.25] / 无 CFG。
# ComfyUI 的 ManualSigmas 需要末尾显式 0（表示走到干净图像），故补一个 0。
VIGGLE_STEPS = 5
VIGGLE_SIGMAS = "1, 0.875, 0.75, 0.5, 0.25, 0"
VIGGLE_LORA_SCALE = 1.0
VIGGLE_REPO = "https://hf-mirror.com/chfm/Qwen-Image-2.1-viggle-turbo"
VIGGLE_FILE = "Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r256.safetensors"
VIGGLE_DOWNLOAD = VIGGLE_REPO + "/resolve/main/" + VIGGLE_FILE
# 文件名里带这些片段的都认作 viggle 加速 LoRA（换版本也能匹配）
VIGGLE_HINTS = ("viggle-turbo", "viggle_turbo", "qwen-image-2.1-viggle", "qwen_image_2.1_viggle")

# ---------------- 局部重绘（inpaint）关键参数 ----------------
# Qwen-Image-2.1 没有 mask 输入：遮罩只能通过 SetLatentNoiseMask 作用在 latent 上，
# 因此「遮罩是否对齐 / 边缘是否柔和 / 未涂区域是否像素级保留」全靠工作流自己保证。
# 官方与社区（RunComfy 的 2.1 inpainting、mecha 的实测记录）共同结论是三步：
#   1) 遮罩先缩放到与编码画布严格同尺寸（no-offset，否则涂抹区域会整体偏移）
#   2) 遮罩外扩 grow + 羽化 blur（盖住 32 对齐误差与接缝，模型也更愿意自然过渡）
#   3) 采样后按遮罩在像素空间贴回原图（保证遮罩外逐像素不变，光靠 noise_mask 不够）
INPAINT_MASK_GROW = 12      # 遮罩外扩像素（盖住缩放偏移与边缘接缝）
INPAINT_MASK_BLUR = 6       # 遮罩羽化半径（px），让重绘边缘自然过渡
# 是否把原图也挂成参考图（reference_latents）。
# ⚠️ 实测（832×1248 人像，涂中部矩形，提示「换成一束白色郁金香」）：
#   挂参考图 → 输出几乎原样复现，郁金香一个都没出现（模型照着参考图抄）；
#   不挂参考图 → 正常长出郁金香，边缘与头发/衬衫自然衔接。
# 原因：inpaint 的起点 latent 已经是原图编码，遮罩区由 noise_mask 打满噪声本就没有内容可抄，
# 再额外喂一份原图只会让模型把它当成「目标长这样」。所以这里保持关闭。
INPAINT_USE_REFERENCE = False

# 采样方案 → 展示名
SAMPLING_NAMES = {
    "turbo": "Turbo 8 步",
    "standard": "Standard",
    "viggle": "Viggle 5 步加速",
}

# 三种采样方案的关系 —— 唯一权威定义，前端参数选项卡照着它渲染卡片和提示。
#
#   底模：turbo 用蒸馏权重；viggle / standard 用标准（非蒸馏）权重
#         （viggle 还要在标准权重上再叠 5 步蒸馏 LoRA）
#   步数：turbo 8 步（改步数会在官方 8 步 sigma 曲线上线性重采样）
#         viggle 固定 5 步（官方调度，绝不重采样）
#         standard 自由 25~40 步（KSampler 自己的 scheduler 负责）
#   CFG ：turbo / viggle 是蒸馏 student，只认 1.0；standard 可调
#   负向：CFG=1 时正负样本的差值项被消掉，CFGGuider / KSampler 都等价于只用正向，
#         所以 turbo / viggle 的负向提示词是摆设，standard 把 CFG 调 >1 才真正生效
SAMPLINGS = [
    {
        "key": "turbo",
        "name": "Turbo",
        "badge": "8 步",
        "steps": 8,
        "steps_fixed": False,
        "cfg": 1.0,
        "cfg_locked": True,
        "negative": False,
        "unet": "turbo",
        "node": "SamplerCustomAdvanced",
        "desc": "官方 8 步蒸馏权重 + 官方 sigma 曲线，默认方案，最稳最快。",
        "detail": "底模必须带 turbo。改步数会在 8 步曲线上重采样，偏离 8 步越多画质越难保证。",
    },
    {
        "key": "viggle",
        "name": "Viggle",
        "badge": "5 步",
        "steps": VIGGLE_STEPS,
        "steps_fixed": True,
        "cfg": 1.0,
        "cfg_locked": True,
        "negative": False,
        "unet": "standard",
        "node": "SamplerCustomAdvanced",
        "desc": "5 步蒸馏 LoRA 叠在标准底模上，比 Turbo 再快一档。",
        "detail": "底模必须换回标准（非 turbo）权重；LoRA 强度固定 1.0，步数 / CFG / 负向全部锁死。",
    },
    {
        "key": "standard",
        "name": "Standard",
        "badge": "25~40 步",
        "steps": 25,
        "steps_fixed": False,
        "cfg": 1.0,
        "cfg_locked": False,
        "negative": True,
        "unet": "any",
        "node": "KSampler",
        "desc": "普通 KSampler + 调度器，步数与 CFG 全开放。",
        "detail": "给非蒸馏底模用。25~40 步、euler + simple 起步；CFG 调到 1 以上，负向提示词才真正参与计算。",
    },
]


def find_viggle_lora(loras):
    """在 ComfyUI 已注册的 LoRA 列表里找加速 LoRA 文件名

    注意：这里只做「名字匹配」，不读文件、不碰权重。ComfyUI 的
    model_lora_keys_unet 对 QwenImage 已同时注册裸名与 transformer. 前缀，
    gate_up 的 gate_layer/proj 分半切分也由它自己完成，所以 diffusers 格式的
    发布文件可以直接挂，项目侧不需要任何格式转换。
    """
    for n in (loras or []):
        low = str(n).lower()
        if any(h in low for h in VIGGLE_HINTS):
            return str(n)
    return ""


def turbo_sigmas(steps):
    """按用户步数重采样官方 8 步 sigma 曲线。

    Turbo 权重是按 8 步蒸馏的，8 步最稳；用户改步数时在官方曲线上线性取点，
    保持「起点 1.0 / 终点 0」与整体去噪节奏，避免直接用 8 步表跑任意步数失真。
    """
    try:
        n = int(steps)
    except Exception:
        n = 8
    n = max(1, min(60, n))
    if n == len(_TURBO_BASE) - 1:
        return TURBO_SIGMAS
    total = len(_TURBO_BASE) - 1
    out = []
    for i in range(n + 1):
        t = (i / float(n)) * total
        lo = int(math.floor(t))
        hi = min(total, lo + 1)
        f = t - lo
        out.append(_TURBO_BASE[lo] * (1 - f) + _TURBO_BASE[hi] * f)
    out[0] = 1.0
    out[-1] = 0.0
    return ", ".join(("%.6f" % v).rstrip("0").rstrip(".") or "0" for v in out)


# 帮助页：必备模型、放置目录与 hf-mirror 国内镜像直链（2026-11 实测可下载）
_HF_QWEN21 = "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main"
_HF_QWEN3VL = "https://hf-mirror.com/Comfy-Org/Qwen3-VL/resolve/main"

# GGUF 量化底模（2026-11 实测：这两个仓库的导出带 general.architecture=qwen_image，
# ComfyUI-GGUF 能正常加载）
#   标准版：配合 viggle 5 步加速使用
#   turbo 版：单独用，8 步
# ⚠️ unsloth/Qwen-Image-2.1{,-Turbo}-GGUF 虽然文件更全，但它们是 stable-diffusion.cpp
#    格式：缺 general.architecture 字段、张量还带 model.diffusion_model. 前缀，
#    ComfyUI-GGUF 的 detect_arch() 不认识 → 报「Unknown model architecture」。
#    别推荐用户去那儿下。
GGUF_REPO_URL = "https://hf-mirror.com/Abiray/Qwen-Image-2.1-GGUF/tree/main"
GGUF_REPO_TURBO_URL = "https://hf-mirror.com/m9ter1a/Qwen-Image-2.1-Turbo-GGUF/tree/main"

REQUIRED_MODELS = [
    {
        "key": "unet_turbo",
        "name": "qwen_image_2.1_turbo_int8_convrot.safetensors",
        "kind": "unet",
        "folder": "ComfyUI/models/unet/",
        "size": "6.8 GB",
        "url": _HF_QWEN21 + "/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
        "required": True,
        "desc": "Turbo 主模型（8 步出图，默认）。也可换成自己的 Qwen-Image 底模。",
    },
    {
        "key": "clip",
        "name": "qwen3vl_8b_int8_convrot.safetensors",
        "kind": "clip",
        "folder": "ComfyUI/models/clip/",
        "size": "8.7 GB",
        "url": _HF_QWEN3VL + "/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
        "required": True,
        "desc": "图像生成的文本编码器，CLIPLoader 类型必须选 qwen_image。",
    },
    {
        "key": "vae",
        "name": "qwen_image_2.1_vae_bf16.safetensors",
        "kind": "vae",
        "folder": "ComfyUI/models/vae/",
        "size": "0.6 GB",
        "url": _HF_QWEN21 + "/vae/qwen_image_2.1_vae_bf16.safetensors",
        "required": True,
        "desc": "Qwen-Image 2.1 专用 VAE，负责编码参考图与解码结果。",
    },
    {
        "key": "clip_llm",
        "name": "qwen3vl_4b_fp8_scaled.safetensors",
        "kind": "clip",
        "folder": "ComfyUI/models/clip/",
        "size": "4.9 GB",
        "url": _HF_QWEN3VL + "/text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
        "required": False,
        "desc": "本地提示词润色 / 图片反推用的 Qwen3-VL 4B 文本模型；只用 DeepSeek 润色可不装。",
    },
    {
        "key": "unet_std",
        "name": "qwen_image_2.1_int8_convrot.safetensors",
        "kind": "unet",
        "folder": "ComfyUI/models/unet/",
        "size": "6.8 GB",
        "url": _HF_QWEN21 + "/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
        "required": False,
        "desc": "标准（非 Turbo）主模型，采样方案切 standard 时使用，默认 25~40 步。也是 Viggle 5 步加速的底模。",
    },
    {
        "key": "unet_std_gguf",
        "name": "qwen_image_2.1_Q4_K_M.gguf",
        "kind": "unet",
        "folder": "ComfyUI/models/diffusion_models/",
        "size": "3.9 GB",
        "url": "https://hf-mirror.com/Abiray/Qwen-Image-2.1-GGUF/resolve/main/qwen_image_2.1_Q4_K_M.gguf",
        "required": False,
        "desc": "标准底模的 GGUF 量化版，显存占用比 int8 更低，同样可以叠加 Viggle 5 步加速 LoRA。"
                "需先安装 ComfyUI-GGUF 插件；量化档位可按显存换 Q5_K_M / Q6_K。",
    },
    {
        "key": "lora_viggle",
        "name": "Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r256.safetensors",
        "kind": "lora",
        "folder": "ComfyUI/models/loras/",
        "size": "1.3 GB",
        "url": "https://hf-mirror.com/chfm/Qwen-Image-2.1-viggle-turbo/resolve/main/"
               "Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r256.safetensors",
        "required": False,
        "desc": "Viggle 5 步蒸馏加速 LoRA（叠在标准底模上，40 步的效果用 5 步跑完）。"
                "原始 diffusers 格式即可直接用，ComfyUI 的 QwenImage 分支已原生兼容，无需转换。"
                "放入目录后可在「参数 → 采样方案」里选 Viggle。",
    },
]

# 本项目用到的插件（自定义节点）。nodes 里的类名会在 ComfyUI /object_info 里逐一检测。
# required=True 的插件缺失会导致基础出图不可用；False 的只影响对应可选功能。
REQUIRED_PLUGINS = [
    {
        "key": "core_qwen",
        "name": "ComfyUI 核心节点（Qwen-Image 2.1 支持）",
        "required": True,
        "nodes": ["TextEncodeQwenImage21", "QwenImage21Cache", "RandomNoise", "CFGGuider",
                  "KSamplerSelect", "SamplerCustomAdvanced", "ManualSigmas", "SplitSigmasDenoise"],
        "desc": "全部生成模式的主节点链（编码 / 缓存 / 采样 / sigma）。",
        "install": "更新 ComfyUI 到最新版本（ComfyUI-Manager → 更新 ComfyUI，或重新下载整合包）",
        "repo": "",
    },
    {
        "key": "gguf",
        "name": "ComfyUI-GGUF",
        "required": False,
        "nodes": ["UnetLoaderGGUF", "CLIPLoaderGGUF"],
        "desc": "加载 .gguf 量化底模 / 文本编码器，12G 显存可选装更省显存的量化版本。",
        "install": "ComfyUI-Manager 搜索 ComfyUI-GGUF，安装后重启 ComfyUI",
        "repo": "https://github.com/city96/ComfyUI-GGUF",
    },
    {
        "key": "seedvr2",
        "name": "SeedVR2 Video Upscaler",
        "required": False,
        "nodes": ["SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel", "SeedVR2VideoUpscaler"],
        "desc": "高清放大（1536 / 2048 / 4096）主链路。",
        "install": "ComfyUI-Manager 搜索 SeedVR2 Video Upscaler，安装后重启 ComfyUI",
        "repo": "https://github.com/numz/SeedVR2_comfyUI",
    },
    {
        "key": "ttp",
        "name": "TTP Toolset",
        "required": False,
        "nodes": ["TTP_Image_Tile_Batch", "TTP_Image_Assy"],
        "desc": "4K 放大的 3×3 分块拼接，与 SeedVR2 配合使用。",
        "install": "ComfyUI-Manager 搜索 TTP Toolset，安装后重启 ComfyUI",
        "repo": "",
    },
]

DEFAULT_NEGATIVE = "模糊，低质量，畸形，多余肢体，水印，文字错误，AI感，过度磨皮，塑料感，明显瑕疵"

DEFAULTS = {
    "unet": "qwen_image_2.1_turbo_int8_convrot.safetensors",
    "clip": "qwen3vl_8b_int8_convrot.safetensors",
    "clip_type": "qwen_image",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
    "weight_dtype": "default",
    "sampling": "turbo",             # turbo | standard | viggle
    "steps": 8,                      # turbo 固定 8；standard 可改；viggle 固定 5
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "resolution": 1024,              # 参考图缩放的总像素预算，0 = 保持原尺寸(32 倍数)
    "width": 1024,
    "height": 1024,
    # 画布尺寸来源：auto = 有参考图时跟随图1（保持比例、不放大），无图用 width/height
    #              fixed = 严格用 width/height（按比例预设或手填都走这里）
    #              native = 参考图原始像素，只做 32 对齐，绝不缩放
    "size_mode": "auto",
    "custom_size": False,            # 兼容旧参数：为 True 时等价于 size_mode=fixed
    "denoise": 1.0,
    "seed": -1,                      # -1 = 每次随机
    "batch": 1,
    "cache_device": "auto",
    "cache_dtype": "default",
    "negative": DEFAULT_NEGATIVE,
    "max_images": 10,                # UI 参考图上限（Qwen-Image-2.1 编辑最多 10 张输入图）
    # Viggle 加速 LoRA 的实际文件名，由路由按 ComfyUI 的 LoRA 清单回填；
    # 留空表示不自动挂载（用户自己勾了同名 LoRA 时也不会重复加）
    "viggle_lora": "",
    "unet_auto_switched": "",        # Viggle 模式下底模被自动换成标准版的记录
}

SKILLS = [
    {
        "id": "text2img",
        "name": "文生图",
        "icon": "✦",
        "group": "基础生成",
        "tag": "纯文字",
        "color": "#7c6cff",
        "desc": "一句话生成一张图，可叠加最多 5 个 LoRA（输入框「⭐ LoRA」自选）锁定人物与画风。",
        "placeholder": "描述你想创作的画面，例如：一只戴墨镜的橘猫，赛博朋克霓虹街头，电影感光影…",
        "min_images": 0, "max_images": 0, "needs_mask": False,
        "denoise": 1.0,
        "examples": ["极简香水产品海报，米白背景，柔和侧光", "小恩雅，校园操场，逆光发丝", "九头身女性模特，浅灰摄影棚，柔和自然光"],
        "tip": "Qwen 2.1 支持在图中渲染中文文字，写清楚文字内容效果更稳。",
        "cloud": [
            {"cat": "人像", "items": [
                "九头身女性模特，浅灰摄影棚，柔和自然光，时尚杂志封面",
                "赛博朋克少女，霓虹雨夜，湿发反光，电影感特写",
                "汉服少女立于金色沙滩，暖色逆光，衣袂飘逸",
                "复古港风人像，胶片颗粒，霓虹招牌背景",
            ]},
            {"cat": "产品", "items": [
                "极简香水瓶产品海报，米白背景，柔和侧光，高级质感",
                "咖啡杯产品图，木质桌面，晨光斜射，浅景深",
                "运动鞋悬浮构图，纯色背景，硬光轮廓",
                "护肤品玻璃瓶特写，水珠，冷调柔光",
            ]},
            {"cat": "场景", "items": [
                "雪山日出，云海翻涌，广角风光摄影",
                "江南水乡清晨，薄雾，青石板路，国风意境",
                "赛博朋克城市天际线，雨夜霓虹，电影级构图",
                "沙漠公路日落，热浪扭曲，长焦压缩感",
            ]},
            {"cat": "插画", "items": [
                "吉卜力风格乡村小屋，夏日白云，治愈系",
                "水墨山水，留白构图，淡墨远山",
                "像素风游戏场景，霓虹森林，8-bit",
                "厚涂奇幻插画，发光蘑菇森林，冷紫配色",
            ]},
            {"cat": "海报文字", "items": [
                "极简咖啡店开业海报，中文标题「今日开业」，留白排版",
                "国潮茶饮海报，红金配色，中文书法标题「秋日限定」",
                "电影海报风格，人物剪影，暗调逆光，标题「归途」",
            ]},
            {"cat": "建筑空间", "items": [
                "现代极简客厅，落地窗，午后阳光，室内摄影",
                "未来主义图书馆，环形书架，冷白灯光",
                "徽派老宅天井，细雨，青瓦白墙，胶片质感",
            ]},
            {"cat": "风格模板", "items": [
                "生成吉卜力风格的乡村插画",
                "生成水墨风格的山景图",
                "生成赛博朋克风格的城市海报",
                "生成油画风格的静物图",
            ]},
        ],
    },
    {
        "id": "img2img",
        "name": "图生图",
        "icon": "◈",
        "group": "基础生成",
        "tag": "1 张参考",
        "color": "#4da3ff",
        "desc": "以一张图为底，保留构图与主体，改变风格、材质、季节或光影。",
        "placeholder": "想怎么改这张图？例如：改成水彩插画风格，保持构图不变…",
        "min_images": 1, "max_images": 1, "needs_mask": False,
        "denoise": 0.65,
        "examples": ["改成胶片摄影质感，保留构图", "把白天改成黄昏，暖色调", "转为 3D 黏土风格，保留主体位置"],
        "tip": "重绘幅度 denoise 越小越像原图（0.4~0.7 稳妥），越大越自由。",
        "cloud": [
            {"cat": "换图片风格", "items": [
                "改成梵高星月夜笔触，保留构图与主体位置",
                "转为日系胶片摄影，低饱和，颗粒感",
                "改成 3D 黏土风格，保留人物姿态",
                "转为水彩插画，柔和晕染，保留主体",
                "改成赛博朋克霓虹风格，保留构图",
                "改成宫崎骏动画赛璐璐风格，保留画面结构",
            ]},
            {"cat": "光影季节", "items": [
                "把白天改成黄昏，暖橙色调，长阴影",
                "改成雪夜场景，保持建筑结构与主体",
                "加入晨雾，柔化远景，保留主体清晰度",
                "改成阴天柔光，降低对比，保留细节",
            ]},
            {"cat": "材质质感", "items": [
                "衣服材质改成丝绸，保留褶皱走向",
                "画面改成金属质感，冷色反光",
                "转为毛毡手工质感，保留轮廓与配色",
            ]},
            {"cat": "画质修复", "items": [
                "提升细节与锐度，保持内容不变，写实摄影质感",
                "降低噪点，修复轻微模糊，保留原色调",
            ]},
        ],
    },
    {
        "id": "edit",
        "name": "图片编辑",
        "icon": "◫",
        "group": "图像编辑",
        "tag": "1~10 张参考",
        "color": "#39c6b3",
        "desc": "多图参考的指令式编辑：增删元素、替换背景、风格迁移、合成排版。",
        "placeholder": "告诉我要做什么，例如：把图1的人物放到图2的场景里，保持光影统一…",
        "min_images": 1, "max_images": 10, "needs_mask": False,
        "denoise": 1.0,
        "examples": ["把图1的产品放进图2的场景中，光影自然融合", "去掉背景里的路人，保持其他不变", "参考图2的配色重新渲染图1"],
        "tip": "参考图按上传顺序编号 图1、图2…；输出尺寸默认跟随图1。",
        "cloud": [
            {"cat": "人像玩法", "items": [
                "把图1人物的发型换成齐肩短发，发色改为栗棕色",
                "把图1的人物换上图2的服装，保持姿势与背景",
                "把图1人物的脸替换成图2的脸，保留光线与妆容",
                "把图1的发色改成银灰色，保留发型与光感",
                "给图1人物换一头蓬松卷发，五官与妆容不变",
                "把图1的妆面改成清透裸妆，光线保持一致",
            ]},
            {"cat": "背景处理", "items": [
                "去掉背景，输出纯白底产品图",
                "把背景替换成浅灰摄影棚，柔和阴影",
                "把背景换成海边日落，人物光影自然融合",
                "抠出主体人物，透明背景，边缘干净",
                "去掉背景杂物，换成纯色渐变背景",
            ]},
            {"cat": "元素增删", "items": [
                "去掉画面中的路人和杂物，保持地面与透视",
                "在桌面右侧加一杯拿铁，光影方向一致",
                "把图1的 logo 替换成图2的 logo，贴合透视",
                "在人物手中加一把透明雨伞，保持手部自然",
            ]},
            {"cat": "多图合成", "items": [
                "把图1的产品放进图2的场景，光影与比例自然",
                "参考图2的配色重新渲染图1",
                "把图1的人物放进图2的背景，统一光线方向",
            ]},
            {"cat": "文字替换", "items": [
                "把画面中的英文招牌替换成中文「咖啡」，保持字体风格",
                "把海报标题改成「秋日限定」，保持排版与配色",
                "把画面文字翻译成英文，保持原有字体与透视",
            ]},
        ],
    },
    {
        "id": "inpaint",
        "name": "局部重绘",
        "icon": "◎",
        "group": "图像编辑",
        "tag": "遮罩涂抹",
        "color": "#ff9f43",
        "desc": "用画笔涂出要改的区域，只重绘涂抹部分，其余像素原样保留。",
        "placeholder": "描述涂抹区域要变成什么，例如：把这块区域换成一束白色郁金香…",
        "min_images": 1, "max_images": 1, "needs_mask": True,
        "denoise": 1.0,
        "examples": ["把涂抹区域换成一只橘猫", "去掉涂抹区域的水印，补齐背景", "把衣服颜色改为米白色"],
        "tip": "在第一张参考图上点「绘制遮罩」；白色 = 重绘区域，黑色 = 保留。",
        "cloud": [
            {"cat": "去除", "items": [
                "去掉涂抹区域的水印，补齐背景纹理",
                "去掉涂抹区域的路人，恢复地面",
                "擦除涂抹区域的文字，补齐背景",
                "去掉涂抹区域的电线，保持天空自然",
            ]},
            {"cat": "替换", "items": [
                "把涂抹区域换成一束白色郁金香",
                "把涂抹区域改成木门，材质与光影一致",
                "给涂抹区域加上一扇窗，透视与光线匹配",
                "把涂抹区域换成一面绿植墙，阴影自然",
            ]},
            {"cat": "修复补全", "items": [
                "修复涂抹区域的划痕与污点",
                "把衣服颜色改为米白色",
                "补齐涂抹区域缺失的头发与发丝",
                "补全涂抹区域的衣料褶皱，纹理延续",
            ]},
        ],
    },
]

SKILL_MAP = {s["id"]: s for s in SKILLS}

INPAINT_PROMPT = "只重绘画面中被遮罩标出的区域，让它与周围未遮罩区域无缝衔接，未遮罩区域必须保持像素级一致："

EDIT_HINT = "参考图按上传顺序依次为 图1、图2…，请综合理解各图内容并按指令编辑，输出以图1的构图与尺寸为准。"


def target_size(orig_w, orig_h, resolution):
    """复现 TextEncodeQwenImage21 内部的参考图缩放公式。

    该节点的第三输出是「空 latent」（源码 torch.zeros([1,64,H//16,W//16])），
    参考图只作为 reference_latents 挂在 conditioning 上。因此 img2img / inpaint
    必须自己把原图按同一尺寸缩放后 VAEEncode，采样起点才是真正的原图内容。
    """
    try:
        w0, h0 = int(orig_w), int(orig_h)
    except Exception:
        w0 = h0 = resolution or 1024
    w0, h0 = max(1, w0), max(1, h0)
    if resolution > 0:
        ratio = w0 / h0
        width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
        height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
    else:
        width, height = round(w0 / 32) * 32, round(h0 / 32) * 32
    return max(32, width), max(32, height)


# 画布尺寸来源。前端「尺寸」卡片的三段选择直接对应这里，
# routes 在提交前据此决定 img2img / 局部重绘的编码画布有多大。
SIZE_MODES = ("auto", "fixed", "native")
SIZE_MODE_NAMES = {
    "auto": "自动（跟随图1）",
    "fixed": "指定尺寸",
    "native": "原图像素",
}


def fit_size(orig_w, orig_h, budget):
    """保持参考图比例，把最长边收敛到 budget 以内，并向上对齐到 32 的倍数。

    「自动尺寸」的实现。三条约束：
      1. 比例严格跟原图走，绝不把竖图塞进横画布；
      2. 只缩不放——小图放大再重绘会凭空捏造细节，也让局部重绘的结果无法贴回原图；
      3. 32 对齐用 ceil 而不是 round，宁可多 16 像素也不要从原图裁掉一条边。
    """
    try:
        w0, h0 = int(orig_w), int(orig_h)
    except Exception:
        w0 = h0 = 0
    w0, h0 = max(1, w0), max(1, h0)
    try:
        budget = int(budget or 0)
    except Exception:
        budget = 0
    long_edge = max(w0, h0)
    if budget > 0 and long_edge > budget:
        k = budget / float(long_edge)
        w0, h0 = w0 * k, h0 * k
    width = int(math.ceil(w0 / 32.0)) * 32
    height = int(math.ceil(h0 / 32.0)) * 32
    return max(32, width), max(32, height)


def native_size(orig_w, orig_h):
    """参考图原始像素，仅向上对齐到 32 的倍数（不缩不放）。"""
    try:
        w0, h0 = int(orig_w), int(orig_h)
    except Exception:
        w0 = h0 = 1024
    return (max(32, int(math.ceil(max(1, w0) / 32.0)) * 32),
            max(32, int(math.ceil(max(1, h0) / 32.0)) * 32))


def _resolution_for(params):
    """把 size_mode 翻译成 TextEncodeQwenImage21 的 resolution 参数。

    官方节点 resolution 语义（见 ComfyUI nodes_qwen.py）：
      > 0  = 参考图重采样到「约 resolution×resolution 面积内、保比例、32 对齐」，
             空 latent 尺寸跟随第一张参考图缩放后的尺寸
      = 0  = 每张参考图保持自身尺寸（仅 32 对齐），空 latent 跟随图1原始尺寸

    之前这里无条件传 q["resolution"]（默认 1024），于是「原图像素」模式根本不生效，
    竖图（如 672×1024）会被塞进正方形预算、比例还时常算反 → 得到压扁的横图。
    """
    p = params or {}
    mode = p.get("size_mode") if p.get("size_mode") in SIZE_MODES else "auto"
    if mode == "native":
        return 0
    if mode == "fixed":
        # 固定画布由 EmptyLatentImage 显式定尺寸，encode 节点不该再按预算重采样参考图
        return 0
    # auto：预算值（0 也合法，等于「保持原尺寸」）
    try:
        return int(p.get("resolution") or 0)
    except Exception:
        return 0


def resolve_canvas(mode, params, images, orig_size=None):
    """img2img / 局部重绘的编码画布尺寸（唯一实现，路由与助手共用）。

    orig_size 是首图真实尺寸，读取失败传 None。返回 ((w, h), 说明)；
    不需要目标画布（文生图 / 图片编辑 / 没有参考图）时返回 (None, "")。

    之前这段逻辑在 routes 与 assistant 里各写了一份且都只看 resolution，
    导致「尺寸」卡片的选择在带参考图的技能里被静默忽略——这正是两处实现
    漂移留下的坑，所以统一到这里。
    """
    if mode not in ("img2img", "inpaint") or not images:
        return None, ""
    p = params or {}
    size_mode = p.get("size_mode") if p.get("size_mode") in SIZE_MODES else "auto"
    try:
        pw = max(64, min(4096, int(p.get("width") or 1024)))
        ph = max(64, min(4096, int(p.get("height") or 1024)))
    except Exception:
        pw = ph = 1024
    w, h = orig_size or (0, 0)

    if size_mode == "fixed":
        return (pw, ph), SIZE_MODE_NAMES["fixed"]
    if size_mode == "native":
        return (native_size(w, h) if w else (pw, ph)), SIZE_MODE_NAMES["native"]
    # auto：跟随图1。档位取预设宽高的较长边，保证「选 1K 就按 1K 封顶」
    if not w:
        return (pw, ph), SIZE_MODE_NAMES["auto"]
    return fit_size(w, h, max(pw, ph)), SIZE_MODE_NAMES["auto"]


def skill(mode):
    return SKILL_MAP.get(mode, SKILLS[0])


def is_turbo_unet(name):
    """底模是否本身已是 8 步蒸馏的 turbo 权重"""
    return "turbo" in str(name or "").lower()


def unet_sampling_warning(sampling, unet):
    """底模和采样方案对不上时给一句能照着做的提示；空字符串表示没问题。

    这是三种方案最容易踩的坑：Turbo 的 8 步 sigma 曲线和 Viggle 的 5 步曲线都
    是针对蒸馏 student 调的，跑在标准权重上会糊；反过来标准 KSampler 跑 25~40 步
    叠在蒸馏权重上也没有意义（权重压根不是按这个步数训练的）。
    """
    turbo = is_turbo_unet(unet)
    if sampling == "turbo" and not turbo:
        return ("当前底模不是 turbo 蒸馏权重，8 步固定 sigma 跑在标准权重上会发糊。"
                "换回 turbo 底模，或把采样方案切到 Standard。")
    if sampling == "standard" and turbo:
        return ("当前是 turbo 蒸馏底模，权重只按 8 步训练，走标准 KSampler 25~40 步意义不大。"
                "切回 Turbo 方案，或换成标准底模。")
    if sampling == "viggle" and turbo:
        return ("Viggle 必须叠在标准底模上（官方要求不要叠加两个蒸馏 student）。"
                "请把底模换成同目录的标准版。")
    return ""


def standard_unet_candidates(name):
    """由 turbo 底模名推导同目录下的标准（非蒸馏）底模名

    例：qwen_image_2.1_turbo_int8_convrot.safetensors
        → qwen_image_2.1_int8_convrot.safetensors

    Viggle 5 步 LoRA 只能叠在标准底模上，两个蒸馏 student 叠加会互相打架
    （官方 README：Never stack two students）。这里只做候选推导，是否真的存在
    由调用方对照模型清单确认。
    """
    s = str(name or "")
    if not is_turbo_unet(s):
        return []
    out = []
    for pat in ("_turbo", "-turbo", "turbo_", "turbo-", "turbo.", ".turbo", " turbo", "turbo "):
        low = s.lower()
        i = low.find(pat)
        if i >= 0:
            cand = s[:i] + s[i + len(pat):]
            cand = re.sub(r"([-_.])\1+", r"\1", cand)
            if cand and cand not in out:
                out.append(cand)
            break
    else:
        cand = re.sub(r"[-_.]?turbo[-_.]?", "", s, flags=re.I)
        if cand and cand != s:
            out.append(cand)
    return out


def pick_standard_unet(name, available):
    """从 available 里挑一个标准底模；找不到返回空串"""
    pool = [str(x) for x in (available or [])]
    for cand in standard_unet_candidates(name):
        for a in pool:
            if a == cand or a.replace("\\", "/").split("/")[-1] == cand.replace("\\", "/").split("/")[-1]:
                return a
    # 兜底：同扩展名、名字里不含 turbo 的第一个（仅在原文件确实带 turbo 时才这么退化）
    if is_turbo_unet(name):
        for a in pool:
            if not is_turbo_unet(a) and a.lower().endswith(os.path.splitext(str(name))[1].lower()):
                return a
    return ""


def prepare_sampling(q, catalog):
    """按采样方案自动补齐必需条件（手动生成与 AI 助手共用同一套）。

    Viggle 5 步不是「把 steps 改成 5」这么简单，它是一套组合：
      1. 必须有 5 步蒸馏加速 LoRA，写进 q["viggle_lora"]，build() 才会串进模型链；
      2. 底模必须是标准（非 turbo）权重 —— 两个蒸馏 student 叠加会互相打架。

    以前这段只在手动 /api/generate 里实现，AI 助手走 submit_generation 就漏了：
    说了「用 viggle 5 步」却只改步数，加速 LoRA 没挂上，底模还停在 turbo，
    出来的图糊成一片。现在两侧共用。

    返回 (ok, error, notes)：
      ok     False 表示缺必要条件，不该继续提交（error 里是能照做的说明）
      notes  自动做了什么（挂 LoRA / 换底模），要回给用户，避免"悄悄改了没说"
    直接原地修改 q（dict）。
    """
    notes = []
    sampling = str((q or {}).get("sampling") or "turbo")
    if sampling not in ("viggle", "standard"):
        return True, "", notes       # turbo 不需要额外条件
    cat = catalog if isinstance(catalog, dict) else {}
    accel = ((cat.get("accel") or {}).get("viggle") or {})

    # 一、Viggle 必须有 5 步加速 LoRA（少了这玩意 5 步就是糊图）
    if sampling == "viggle":
        lora = str(accel.get("lora") or "") or find_viggle_lora(cat.get("loras") or [])
        if not lora:
            return False, ("Viggle 5 步加速需要先安装加速 LoRA：把 %s 放进 ComfyUI 的 "
                           "models/loras/ 后点「刷新模型清单」。下载：%s"
                           % (VIGGLE_FILE, VIGGLE_DOWNLOAD)), notes
        q["viggle_lora"] = lora
        notes.append("已挂 5 步加速 LoRA「%s」" % lora)

    # 二、viggle / standard 都要跑在标准（非蒸馏）权重上：
    # viggle 是「两个蒸馏 student 叠加会打架」；standard 的 25~40 步叠在 8 步蒸馏权重上收益也很小。
    # 底模是 turbo 时自动换成同目录标准版，并在 notes 里说清楚（不能悄悄改模型）。
    if is_turbo_unet(q.get("unet")):
        pool = list(cat.get("unets") or []) + list(cat.get("unets_gguf") or [])
        std = pick_standard_unet(q.get("unet"), pool)
        if std:
            q["unet_auto_switched"] = q.get("unet")
            q["unet"] = std
            notes.append("底模自动换成标准权重「%s」（%s 不能跑在蒸馏权重上）"
                         % (std, "Viggle" if sampling == "viggle" else "Standard"))
        else:
            notes.append("没找到对应的标准底模，当前底模是蒸馏权重，%s 跑在它上面会掉效果"
                         "（建议在参数里换成标准版底模）"
                         % ("Viggle" if sampling == "viggle" else "Standard"))
    return True, "", notes


def compose_prompt(mode, text, image_count=0):
    """把用户输入 + 技能模板拼成最终提示词"""
    text = (text or "").strip()
    if mode == "inpaint":
        return INPAINT_PROMPT + (text or "自然补全周围环境，保持原有风格与光影")
    if mode == "edit":
        hint = EDIT_HINT if image_count > 1 else "输出以图1的构图与尺寸为准。"
        return (text or "按参考图内容生成一张协调统一的图片") + " " + hint
    if mode == "img2img":
        if "保持" not in text and "不变" not in text:
            text += " 保持图1的构图、主体位置、镜头角度与画面结构不变。"
        return text
    return text or "一只戴墨镜的橘猫坐在霓虹街头的窗台上，电影感光影，细节丰富"


def auto_route(text, image_count=0, has_mask=False, has_lora=False):
    """智能创作：轻量关键词路由（不依赖外部 LLM），与前端 autoRoute 保持一致。
    has_lora 仅保留参数兼容：LoRA 是输入框自选的通用增强，所有模式都可用，
    不再强制路由回文生图（否则带参考图 + LoRA 会撞上「不支持参考图」）。"""
    t = (text or "").lower()
    if has_mask:
        return "inpaint"
    if any(k in t for k in ("局部重绘", "只改", "涂抹", "遮罩", "去掉水印", "擦除")):
        return "inpaint"
    if image_count >= 2:
        return "edit"
    if image_count == 1:
        if any(k in t for k in ("风格", "改成", "变成", "转为", "重绘", "色调", "调色", "滤镜",
                                "油画", "水彩", "素描", "卡通", "动漫", "黏土", "水墨", "插画",
                                "胶片", "老照片", "赛博朋克", "像素风", "写实", "质感")):
            return "img2img"
        return "edit"
    return "text2img"


def normalize(raw):
    """合并默认参数 + 客户端参数，做范围收敛"""
    p = dict(DEFAULTS)
    incoming = raw.get("params") or {}
    for k in DEFAULTS:
        if k in incoming and incoming[k] is not None:
            p[k] = incoming[k]

    def num(k, lo, hi, cast=float, default=None):
        try:
            v = cast(p[k])
        except Exception:
            v = cast(default if default is not None else DEFAULTS[k])
        return max(lo, min(hi, v))

    p["resolution"] = int(num("resolution", 0, 4096, int))
    # 允许自定义任意像素尺寸（下限 64，上限 4096）；非 8 倍数由 ComfyUI 的
    # latent 取整自动对齐，不再在前端/后端硬拦截，否则用户填 544x900 会被拒。
    p["width"] = int(num("width", 64, 4096, int))
    p["height"] = int(num("height", 64, 4096, int))
    p["steps"] = int(num("steps", 1, 200, int))
    p["cfg"] = round(num("cfg", 0.0, 30.0, float), 2)
    p["denoise"] = round(num("denoise", 0.05, 1.0, float), 2)
    p["batch"] = int(num("batch", 1, 8, int))
    p["max_images"] = int(num("max_images", 1, 10, int))
    p["custom_size"] = bool(p.get("custom_size"))
    # size_mode 是权威（三态 auto/fixed/native），custom_size 只是旧版抽屉的镜像。
    # 优先级：显式传了合法 size_mode 就听它的；只有旧客户端「只传 custom_size、不传
    # size_mode」时才用 custom_size 推断。否则残留的 custom_size=true 会覆盖掉
    # 用户刚选的 native（这正是「选原图像素却按 1024×440 出图」的根因）。
    incoming_mode = incoming.get("size_mode")
    if incoming_mode in SIZE_MODES:
        p["size_mode"] = incoming_mode
        p["custom_size"] = (incoming_mode == "fixed")
    else:
        p["size_mode"] = "fixed" if p["custom_size"] else "auto"
        p["custom_size"] = p["size_mode"] == "fixed"
    p["sampling"] = p["sampling"] if p["sampling"] in ("turbo", "standard", "viggle") else "turbo"
    p["cache_device"] = p["cache_device"] if p["cache_device"] in ("auto", "gpu", "cpu", "off") else "auto"
    p["cache_dtype"] = p["cache_dtype"] if p["cache_dtype"] in ("default", "int8", "int4") else "default"
    p["viggle_lora"] = str(p.get("viggle_lora") or "")
    p["unet_auto_switched"] = ""
    # 底模与方案不匹配时把提示带回前端（不阻断生成，只提醒）
    p["unet_warn"] = unet_sampling_warning(p["sampling"], p["unet"])

    # Viggle turbo 是 5 步蒸馏 student：官方明确只认 5 步 / 固定 sigma / cfg 1.0，
    # 且「no negative prompt」。这里统一锁定，避免用户改步数或 CFG 后画质崩掉。
    if p["sampling"] == "viggle":
        p["steps"] = VIGGLE_STEPS
        p["cfg"] = 1.0
        p["negative"] = ""

    seed = raw.get("seed")
    if seed is None:
        seed = p.get("seed", -1)
    try:
        seed = int(seed)
    except Exception:
        seed = -1
    if seed < 0:
        seed = random.randint(1, 2 ** 48)
    p["seed"] = seed

    cfg = {
        "mode": raw.get("mode") if raw.get("mode") in SKILL_MAP else "text2img",
        "prompt": (raw.get("prompt") or "").strip(),
        "negative": str(p.get("negative") or ""),
        "images": [str(x) for x in (raw.get("images") or []) if x][:16],
        "mask": raw.get("mask") or None,
        "loras": [],
        "params": p,
        "session_id": raw.get("session_id") or "",
        "title": raw.get("title") or "",
        "target_size": None,  # 由路由按首图真实尺寸回填
    }
    # 兜底：文生图不接受参考图。路由 / 助手给了 text2img 却带图时自动升级
    # （单图 → 图生图，多图 → 图片编辑），而不是让用户撞上「最多支持 0 张」的校验错
    if cfg["mode"] == "text2img" and cfg["images"]:
        cfg["mode"] = "img2img" if len(cfg["images"]) == 1 else "edit"
    for l in (raw.get("loras") or [])[:5]:
        if isinstance(l, dict) and l.get("name"):
            try:
                strength = float(l.get("strength", 1.0))
            except Exception:
                strength = 1.0
            cfg["loras"].append({"name": str(l["name"]), "strength": max(-2.0, min(2.0, strength))})
    cfg["final_prompt"] = compose_prompt(cfg["mode"], cfg["prompt"], len(cfg["images"]))
    return cfg


def validate(cfg):
    """返回错误字符串列表"""
    errs = []
    s = skill(cfg["mode"])
    n = len(cfg["images"])
    if n < s["min_images"]:
        errs.append("「%s」至少需要 %d 张参考图（当前 %d 张）" % (s["name"], s["min_images"], n))
    if n > s["max_images"]:
        errs.append("「%s」最多支持 %d 张参考图（当前 %d 张）" % (s["name"], s["max_images"], n))
    if s["needs_mask"] and not cfg["mask"]:
        errs.append("「局部重绘」需要先在第一张图上绘制遮罩")
    # 自定义像素允许任意正整数：不再用「必须是 32 倍数」阻断生成。
    return errs


def build(cfg, prefix=None):
    """构建 ComfyUI API 格式 prompt"""
    p = {}
    q = cfg["params"]
    sk = skill(cfg["mode"])
    seed = q["seed"]
    unet_name = str(q["unet"] or "")
    clip_name = str(q["clip"] or "")
    # GGUF 底模：ComfyUI-GGUF 插件提供 UnetLoaderGGUF / CLIPLoaderGGUF，
    # 按扩展名自动切换加载器，其余节点链完全一致。
    gguf_unet = unet_name.lower().endswith(".gguf")
    gguf_clip = clip_name.lower().endswith(".gguf")

    if gguf_unet:
        p["unet"] = {
            "class_type": "UnetLoaderGGUF",
            "inputs": {"unet_name": unet_name},
        }
    else:
        p["unet"] = {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": unet_name, "weight_dtype": q["weight_dtype"]},
        }
    model_ref = ["unet", 0]
    # Viggle 5 步加速：把加速 LoRA 串在最前面（官方要求强度固定 1.0，不可与其它
    # 蒸馏 student 叠加）。用户自己勾了同名 LoRA 时不再重复挂。
    lora_chain = list(cfg["loras"])
    viggle_lora = str(q.get("viggle_lora") or "").strip()
    if q["sampling"] == "viggle" and viggle_lora:
        if not any(l["name"] == viggle_lora for l in lora_chain):
            lora_chain.insert(0, {"name": viggle_lora, "strength": VIGGLE_LORA_SCALE})
    elif q["sampling"] == "viggle":
        for l in lora_chain:
            if "viggle" in l["name"].lower():
                l["strength"] = VIGGLE_LORA_SCALE
                break
    for i, lora in enumerate(lora_chain, 1):
        key = "lora_%d" % i
        p[key] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_ref,
                "lora_name": lora["name"],
                "strength_model": lora["strength"],
            },
        }
        model_ref = [key, 0]

    p["cache"] = {
        "class_type": "QwenImage21Cache",
        "inputs": {"model": model_ref, "device": q["cache_device"], "dtype": q["cache_dtype"]},
    }
    if gguf_clip:
        p["clip"] = {
            "class_type": "CLIPLoaderGGUF",
            "inputs": {"clip_name": clip_name, "type": q["clip_type"]},
        }
    else:
        p["clip"] = {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": q["clip_type"], "device": "default"},
        }
    p["vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": q["vae"]}}

    for i, name in enumerate(cfg["images"], 1):
        p["ref_%d" % i] = {"class_type": "LoadImage", "inputs": {"image": name}}

    enc_inputs = {
        "clip": ["clip", 0],
        "prompt": cfg["final_prompt"],
        "negative_prompt": cfg["negative"],
        # resolution 的语义由 size_mode 决定（这是「原图像素被压扁」的根因）：
        #   native → 0  官方节点语义 = 每张参考图保持自身尺寸（仅 32 对齐），空 latent 跟随图1
        #   auto   → 预算值（约 N×N 面积内保比例）
        #   fixed  → 由 EmptyLatentImage 显式指定，这里传 0 避免节点又去重采样参考图
        "resolution": _resolution_for(q),
        "vae": ["vae", 0],
    }
    # 参考图挂 reference_latents 是 Qwen 编辑流的强复现约束（edit 依赖它保图）。
    # img2img 的保图由「VAEEncode 起点 + denoise」控制——若把参考图也挂到 conditioning 上，
    # 两层保图叠加，模型会无视 denoise 忠实复现原图（实测 denoise=0.65 时输出与原图逐像素
    # 几乎相同，提示词完全失效），所以 img2img 不挂 reference。
    # inpaint 同理且更严重：起点 latent 已是原图编码，再挂参考图 = 把「目标长什么样」直接告诉
    # 模型，实测会原样复现、提示词完全失效（关掉后才正常按提示补内容）。见 INPAINT_USE_REFERENCE。
    if sk["id"] == "inpaint":
        use_reference = bool(INPAINT_USE_REFERENCE)
    else:
        use_reference = sk["id"] not in ("img2img", "inpaint")
    if use_reference:
        for i in range(1, len(cfg["images"]) + 1):
            enc_inputs["images.image_%d" % i] = ["ref_%d" % i, 0]
    p["encode"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc_inputs}

    # img2img / inpaint：以「原图 VAE 编码」为采样起点，denoise / mask 才有保图语义。
    # edit：官方编辑流程用 encode 的空 latent（尺寸跟随图1）。
    pixel_latent = sk["id"] in ("img2img", "inpaint") and bool(cfg["images"])
    tw = th = 0
    if pixel_latent:
        fallback = q["resolution"] or 1024
        tw, th = cfg.get("target_size") or (fallback, fallback)
        p["ref_scaled"] = {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["ref_1", 0],
                "upscale_method": "lanczos",
                "width": tw,
                "height": th,
                "crop": "disabled",
            },
        }
        p["encoded"] = {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["ref_scaled", 0], "vae": ["vae", 0]},
        }
        latent_ref = ["encoded", 0]
        latent_desc = "原图编码 %d×%d" % (tw, th)
    elif cfg["images"] and q.get("size_mode") != "fixed":
        latent_ref = ["encode", 2]   # 空画布，尺寸跟随图1
        latent_desc = "跟随图1尺寸（空画布）"
    else:
        p["empty"] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": q["width"], "height": q["height"], "batch_size": q["batch"]},
        }
        latent_ref = ["empty", 0]
        latent_desc = "自定义 %d×%d" % (q["width"], q["height"])

    # 参考图 / 原图编码出来的 latent 批次固定为 1：batch（×N 张数）必须显式复制，
    # 否则编辑 / 图生图 / 局部重绘里 ×2~×8 只会出 1 张。
    if q["batch"] > 1 and latent_ref[0] != "empty":
        p["latent_repeat"] = {
            "class_type": "RepeatLatentBatch",
            "inputs": {"samples": latent_ref, "amount": q["batch"]},
        }
        latent_ref = ["latent_repeat", 0]
        latent_desc += " ×%d" % q["batch"]

    # 最终遮罩引用：既给 SetLatentNoiseMask，也给采样后的像素级贴回用
    mask_out = None
    if cfg["mask"]:
        # ① 对齐：遮罩必须与编码画布严格同尺寸。SetLatentNoiseMask 只做 reshape 挂载，
        #    采样时才用双线性把尺寸不符的遮罩硬拉过去——涂抹区域随之偏移，
        #    表现就是「局部重绘位置不对、边缘漏改」。先缩放到 (tw, th) 再转 mask。
        p["mask_src"] = {
            "class_type": "LoadImage",
            "inputs": {"image": cfg["mask"]},
        }
        mask_img = ["mask_src", 0]
        if pixel_latent and tw and th:
            p["mask_scaled"] = {
                "class_type": "ImageScale",
                "inputs": {
                    "image": mask_img,
                    "upscale_method": "bilinear",
                    "width": tw,
                    "height": th,
                    "crop": "disabled",
                },
            }
            mask_img = ["mask_scaled", 0]
        p["mask"] = {
            "class_type": "ImageToMask",
            "inputs": {"image": mask_img, "channel": "red"},
        }
        mask_ref = ["mask", 0]

        # ② 外扩：原图要缩到 32 的倍数、遮罩又要缩放对齐，误差常有一两个像素；
        #    再叠加 VAE 的 8 倍下采样，不往外扩就会出现「重绘区边缘留一圈原像素」的硬接缝。
        if INPAINT_MASK_GROW:
            p["mask_grow"] = {
                "class_type": "GrowMask",
                "inputs": {"mask": mask_ref, "expand": INPAINT_MASK_GROW,
                           "tapered_corners": True},
            }
            mask_ref = ["mask_grow", 0]

        # ③ 羽化：把硬边变成渐变边。SetLatentNoiseMask 接受 0~1 的浮点遮罩，
        #    边缘处权重递减 → 采样时按比例融合，接缝自然消失。
        if INPAINT_MASK_BLUR:
            p["mask_to_img"] = {"class_type": "MaskToImage", "inputs": {"mask": mask_ref}}
            p["mask_blur"] = {
                "class_type": "ImageBlur",
                "inputs": {"image": ["mask_to_img", 0],
                           "blur_radius": INPAINT_MASK_BLUR,
                           "sigma": max(0.5, INPAINT_MASK_BLUR / 3.0)},
            }
            p["mask_final"] = {
                "class_type": "ImageToMask",
                "inputs": {"image": ["mask_blur", 0], "channel": "red"},
            }
            mask_ref = ["mask_final", 0]

        mask_out = mask_ref
        p["mask_latent"] = {
            "class_type": "SetLatentNoiseMask",
            "inputs": {"samples": latent_ref, "mask": mask_out},
        }
        latent_ref = ["mask_latent", 0]
        latent_desc += " + 遮罩(扩%d/羽%d)" % (INPAINT_MASK_GROW, INPAINT_MASK_BLUR)

    if q["sampling"] in ("turbo", "viggle"):
        viggle = q["sampling"] == "viggle"
        p["noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        p["guider"] = {
            "class_type": "CFGGuider",
            "inputs": {
                "model": ["cache", 0],
                "positive": ["encode", 0],
                "negative": ["encode", 1],
                "cfg": 1.0 if q["cfg"] <= 0 else q["cfg"],
            },
        }
        p["sampler_select"] = {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": "euler"},
        }
        if viggle:
            # 官方 5 步固定 sigma（末尾 0 = 走到干净图像），不按步数重采样
            p["sigmas"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": VIGGLE_SIGMAS}}
        else:
            p["sigmas"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": turbo_sigmas(q["steps"])}}
        sigmas_ref = ["sigmas", 0]
        denoise = q["denoise"]
        if denoise < 0.999:
            p["sigmas_denoise"] = {
                "class_type": "SplitSigmasDenoise",
                "inputs": {"sigmas": sigmas_ref, "denoise": denoise},
            }
            sigmas_ref = ["sigmas_denoise", 1]  # low_sigmas = 实际去噪段
        p["sample"] = {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["noise", 0],
                "guider": ["guider", 0],
                "sampler": ["sampler_select", 0],
                "sigmas": sigmas_ref,
                "latent_image": latent_ref,
            },
        }
        if viggle:
            sampler_desc = "Viggle %d 步固定 sigma" % VIGGLE_STEPS
        else:
            sampler_desc = (
                "Turbo 8 步固定 sigma" if int(q["steps"]) == 8
                else "Turbo %d 步（重采样 sigma）" % int(q["steps"])
            )
    else:
        p["sample"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["cache", 0],
                "seed": seed,
                "steps": q["steps"],
                "cfg": q["cfg"],
                "sampler_name": q["sampler"],
                "scheduler": q["scheduler"],
                "positive": ["encode", 0],
                "negative": ["encode", 1],
                "latent_image": latent_ref,
                "denoise": q["denoise"],
            },
        }
        sampler_desc = "KSampler %d 步 / %s" % (q["steps"], q["scheduler"])

    p["decode"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]},
    }
    # ④ 像素级贴回（仅局部重绘）：noise_mask 只保证「采样时不动遮罩外」，
    #    但整个 latent 仍要过一遍 VAE 解码，遮罩外的像素会有轻微色偏/细节漂移。
    #    按同一张遮罩把结果贴回原图，遮罩外就真的是原像素，一个 byte 都不变。
    out_img = ["decode", 0]
    if mask_out is not None and pixel_latent:
        dest = ["ref_scaled", 0]
        if q["batch"] > 1:
            # 原图只有 1 张，批量出图时先复制到 N 张再逐张合成，尺寸/内容才对得上
            p["ref_repeat"] = {
                "class_type": "RepeatImageBatch",
                "inputs": {"image": dest, "amount": q["batch"]},
            }
            dest = ["ref_repeat", 0]
        p["composite"] = {
            "class_type": "ImageCompositeMasked",
            "inputs": {
                "destination": dest,
                "source": out_img,
                "x": 0, "y": 0,
                "resize_source": False,
                "mask": mask_out,
            },
        }
        out_img = ["composite", 0]
        latent_desc += " → 像素级贴回"
    p["save"] = {
        "class_type": "SaveImage",
        "inputs": {
            "images": out_img,
            "filename_prefix": prefix or ("cyui/%s" % time.strftime("%Y%m%d")),
        },
    }
    return p, {
        "sampler": sampler_desc,
        "latent": latent_desc,
        "nodes": len(p),
        "loader": "GGUF" if (gguf_unet or gguf_clip) else "safetensors",
        "reference_images": len(cfg["images"]),
        "loras": [l["name"] for l in lora_chain],
        "sampling": q["sampling"],
        "steps": int(q["steps"]),
        "cfg": float(q["cfg"]),
        # 实际编码画布：只有 img2img / 局部重绘是自己定的像素尺寸，
        # 文生图看 EmptyLatentImage，图片编辑由 TextEncodeQwenImage21 内部决定
        "size_mode": q.get("size_mode") or "auto",
        "canvas": [int(tw), int(th)] if pixel_latent else None,
    }
