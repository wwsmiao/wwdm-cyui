"""SD 1.5 局部重绘：和 Qwen 那个同一套遮罩流程，但换成 SD1.5 inpaint 底模。

节点分工（8 个节点，改映射前先看这里）：
  29 CheckpointLoaderSimple（底模 + CLIP + VAE 一起给）
       model → 3 KSampler.model      clip → 6 / 7 CLIPTextEncode
       vae   → 26 VAEEncodeForInpaint / 8 VAEDecode
  20 LoadImage：整张「遮罩区域已透明」的 PNG（局部重绘弹窗负责生成）
       pixels → 26.pixels    MASK（= 1 - alpha）→ 26.mask
  26 VAEEncodeForInpaint（grow_mask_by 遮罩外扩）→ 3 KSampler.latent_image
  3 KSampler（denoise 决定改动幅度）→ 8 VAEDecode → 9 SaveImage

和 Qwen 局部重绘的区别：
  · 走 SD1.5 系底模（默认 512-inpainting-ema），512 附近最稳，大图细节会变软
  · 参数更少：没有文本编码分辨率、没有 LoRA 槽位，采样器 / 调度器跟图里一致
  · denoise 同样建议 1.0：VAEEncodeForInpaint 会先把遮罩区填成灰底再编码，调小会留灰块
"""
from workflows.base import Workflow


class SD15Inpaint(Workflow):
    id = "sd1.5-局部重绘"
    name = "SD1.5 局部重绘"
    description = "SD1.5 inpaint 底模 · 涂哪改哪 · 速度快、显存低"
    kind = "image"
    # 只给作品卡片 / 画布节点的「局部重绘」入口用，创作区的下拉里不出现
    category = "inpaint"
    needs_image = True
    images_per_task = 1
    min_images = 1
    max_images = 1
    supports_size = False     # 尺寸由上传的图决定
    supports_batch = False
    estimate_size = False
    graph_file = "sd1.5-局部重绘.json"
    # 遮罩弹窗里显示的提示（每个局部重绘工作流可以不一样）
    inpaint_note = "SD1.5 inpaint 在 512×512 附近最稳；大图只涂改小块效果更好，整图重画容易糊。"

    mapping = {
        "prompt": ["6", "inputs", "text"],
        "negative": ["7", "inputs", "text"],
        "seed": ["3", "inputs", "seed"],
        "image": ["20", "inputs", "image"],
    }

    param_map = {
        "ckpt": ["29", "inputs", "ckpt_name"],
        "negative": ["7", "inputs", "text"],
        "seed": ["3", "inputs", "seed"],
        "steps": ["3", "inputs", "steps"],
        "cfg": ["3", "inputs", "cfg"],
        "sampler_name": ["3", "inputs", "sampler_name"],
        "scheduler": ["3", "inputs", "scheduler"],
        "denoise": ["3", "inputs", "denoise"],
        "grow_mask_by": ["26", "inputs", "grow_mask_by"],
    }

    option_sources = {
        "ckpt": ("CheckpointLoaderSimple", "ckpt_name"),
        "sampler_name": ("KSampler", "sampler_name"),
        "scheduler": ("KSampler", "scheduler"),
    }

    settings_fields = [
        {"key": "ckpt", "label": "底模（inpaint 版效果最好）", "type": "select", "full": True},
        {"key": "steps", "label": "采样步数", "type": "number"},
        {"key": "cfg", "label": "CFG", "type": "number"},
        {"key": "denoise", "label": "重绘幅度 denoise", "type": "number", "hint": "保持 1.0；调小遮罩区会残留灰底"},
        {"key": "sampler_name", "label": "采样器", "type": "select"},
        {"key": "scheduler", "label": "调度器", "type": "select"},
        {"key": "grow_mask_by", "label": "遮罩外扩", "type": "number", "hint": "像素；多算进边缘一点，接缝更自然"},
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


WORKFLOW = SD15Inpaint()
