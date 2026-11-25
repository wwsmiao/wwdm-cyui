"""Qwen-Image 2.1 局部重绘：上传「涂好遮罩的图」，只重画遮罩区域。

节点分工（改映射前先看这里）：
  1 UNETLoader → 7 QwenImage21Cache → 6 KSampler.model
  2 CLIPLoader（qwen_image）→ 4 TextEncodeQwenImage21（prompt / negative / resolution）
  3 VAELoader → 4 / 10 / 8
  12 LoadImage：整张「带遮罩的图」——它的 MASK 输出取的是 alpha 通道（透明处 = 要重绘）
      pixels → 10.pixels    mask → 10.mask
  10 VAEEncodeForInpaint（grow_mask_by 遮罩外扩）→ 6 KSampler.latent_image
  6 KSampler（denoise 决定改动幅度）→ 8 VAEDecode → 9 SaveImageAdvanced

和图片编辑的区别：
  · 只吃一张图，而且必须是「遮罩区域已透明」的 PNG（界面上的局部重绘弹窗负责生成）
  · 输出尺寸跟着原图，没有比例 / 分辨率 / 张数可选
  · denoise 必须保持 1.0：VAEEncodeForInpaint 会把遮罩区填成灰底再编码，调小就留下灰块
    （实测 0.75 那次的遮罩区原样是灰色，没有重画）
"""
from workflows.base import Workflow


class QwenImage21Inpaint(Workflow):
    id = "qwen-image-2.1-局部重绘"
    name = "Qwen-Image 2.1 局部重绘"
    description = "涂抹遮罩 · 只重画选中区域 · 输出跟随原图尺寸"
    kind = "image"
    # 只有作品卡片「画面修复 - 局部重绘」用这个工作流，创作区的工作流下拉里不出现
    category = "inpaint"
    needs_image = True
    images_per_task = 1
    min_images = 1
    max_images = 1
    supports_size = False     # 尺寸由上传的图决定
    supports_batch = False
    estimate_size = False
    graph_file = "qwen-image-2.1-局部重绘.json"

    mapping = {
        "prompt": ["4", "inputs", "prompt"],
        "negative": ["4", "inputs", "negative_prompt"],
        "seed": ["6", "inputs", "seed"],
        "image": ["12", "inputs", "image"],
    }

    # 设置面板里能改的（提示词、遮罩图不在此列）
    param_map = {
        "negative": ["4", "inputs", "negative_prompt"],
        "seed": ["6", "inputs", "seed"],
        "steps": ["6", "inputs", "steps"],
        "cfg": ["6", "inputs", "cfg"],
        "sampler_name": ["6", "inputs", "sampler_name"],
        "scheduler": ["6", "inputs", "scheduler"],
        "denoise": ["6", "inputs", "denoise"],
        "resolution": ["4", "inputs", "resolution"],
        "grow_mask_by": ["10", "inputs", "grow_mask_by"],
        "unet": ["1", "inputs", "unet_name"],
        "clip": ["2", "inputs", "clip_name"],
        "clip_type": ["2", "inputs", "type"],
        "vae": ["3", "inputs", "vae_name"],
    }

    option_sources = {
        "clip_type": ("CLIPLoader", "type"),
        "sampler_name": ("KSampler", "sampler_name"),
        "scheduler": ("KSampler", "scheduler"),
    }

    settings_fields = [
        {"key": "unet", "label": "UNet 模型", "type": "select", "full": True},
        {"key": "clip", "label": "CLIP 模型", "type": "select", "full": True},
        {"key": "clip_type", "label": "CLIP 类型", "type": "select"},
        {"key": "vae", "label": "VAE 模型", "type": "select"},
        {"key": "steps", "label": "采样步数", "type": "number"},
        {"key": "cfg", "label": "CFG", "type": "number"},
        {"key": "denoise", "label": "重绘幅度 denoise", "type": "number", "hint": "保持 1.0；调小遮罩区会残留灰底"},
        {"key": "sampler_name", "label": "采样器", "type": "select"},
        {"key": "scheduler", "label": "调度器", "type": "select"},
        {"key": "grow_mask_by", "label": "遮罩外扩", "type": "number", "hint": "像素；多算进边缘一点，接缝更自然"},
        {"key": "resolution", "label": "文本编码分辨率", "type": "number"},
        {"key": "negative", "label": "负面提示词", "type": "textarea", "full": True},
        {"key": "seed", "label": "种子（-1 = 每次随机）", "type": "number"},
    ]

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        return {
            "prompt": prompt,
            "negative": negative,
            "seed": int(seed),
            "image": params.get("image"),
        }


WORKFLOW = QwenImage21Inpaint()
