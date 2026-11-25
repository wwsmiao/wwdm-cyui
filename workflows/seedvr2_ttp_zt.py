"""SeedVR2 + TTP 放大 + Z-Image 二采：先分块放大，再用 Z-Image 低降噪重绘一遍再拼回。

节点分工（改映射前先看这里）：
  214 LoadImage（原图）
  194 ImageScaleBy scale_by=首次放大倍数 → 201 取尺寸
  195 ImageScale 对齐尺寸 → 196 TTP_Tile_image_size（3×3 分块、10% 重叠）→ 197 切块
  207 缩到 0.25 → 208 SeedVR2VideoUpscaler（DiT 203 / VAE 204）逐块放大
  208 → 687 VAEEncode → 686 KSampler（Z-Image：681 UNet + 682 CLIP + 683 提示词，denoise 低）→ 689 VAEDecode
  689 → 211 缩回块尺寸 → 210 TTP_Image_Assy 拼回 → 213 SaveImage
  685 ModelSamplingAuraFlow：Z-Image 的 shift

和纯 TTP 放大的区别：
  · 放大完还会走一遍 Z-Image 重绘（denoise 默认 0.15），画面细节更"实"，也更容易过锐
  · 提示词是本工作流的「二采提示词」，在设置里改，创作区不用写
"""
from workflows.base import Workflow

MIN_SCALE, MAX_SCALE = 1.0, 4.0


class SeedVR2TTPTwoPass(Workflow):
    id = "seedvr2-ttp-zt-二采"
    name = "SeedVR2 + TTP 放大 + 二采"
    description = "分块 SeedVR2 放大 → Z-Image 二采（低降噪）→ 拼回"
    kind = "image"
    needs_image = True
    max_images = 1
    supports_size = False      # 尺寸 = 原图 × 首次放大倍数
    supports_batch = False     # 一次一张
    supports_prompt = False    # 二采提示词固定在设置里，创作区只有放大倍数
    estimate_size = False

    scale_param = {"min": MIN_SCALE, "max": MAX_SCALE, "step": 0.5,
                   "default": 2.0, "label": "首次放大倍数"}

    graph_file = "seedvr2-ttp-zt-二采.json"

    mapping = {
        "image": ["214", "inputs", "image"],
        "scale": ["194", "inputs", "scale_by"],
    }

    param_map = {
        # 二采（Z-Image）这一遍
        "prompt_text": ["683", "inputs", "text"],
        "unet": ["681", "inputs", "unet_name"],
        "clip": ["682", "inputs", "clip_name"],
        "vae": ["684", "inputs", "vae_name"],
        "shift": ["685", "inputs", "shift"],
        "seed": ["686", "inputs", "seed"],
        "steps": ["686", "inputs", "steps"],
        "cfg": ["686", "inputs", "cfg"],
        "sampler_name": ["686", "inputs", "sampler_name"],
        "scheduler": ["686", "inputs", "scheduler"],
        "denoise": ["686", "inputs", "denoise"],
        # 第一遍分块放大（SeedVR2）
        "dit_model": ["203", "inputs", "model"],
        "seedvr_vae": ["204", "inputs", "model"],
        "upscale_method": ["194", "inputs", "upscale_method"],
        "tile_x": ["196", "inputs", "width_factor"],
        "tile_y": ["196", "inputs", "height_factor"],
        "overlap": ["196", "inputs", "overlap_rate"],
        "resolution": ["208", "inputs", "resolution"],
        "max_resolution": ["208", "inputs", "max_resolution"],
        "batch_size": ["208", "inputs", "batch_size"],
        "color_correction": ["208", "inputs", "color_correction"],
        "noise": ["208", "inputs", "input_noise_scale"],
        "blocks_to_swap": ["203", "inputs", "blocks_to_swap"],
        "offload_device": ["208", "inputs", "offload_device"],
        "padding": ["210", "inputs", "padding"],
    }

    option_sources = {
        "dit_model": ("SeedVR2LoadDiTModel", "model"),
        "seedvr_vae": ("SeedVR2LoadVAEModel", "model"),
        "upscale_method": ("ImageScaleBy", "upscale_method"),
        "color_correction": ("SeedVR2VideoUpscaler", "color_correction"),
        "offload_device": ("SeedVR2VideoUpscaler", "offload_device"),
    }

    # 设置面板里的字段（顺序即展示顺序），前端按这份渲染
    settings_fields = [
        {"key": "prompt_text", "label": "二采提示词（Z-Image 重绘用）", "type": "textarea", "full": True},
        {"key": "unet", "label": "Z-Image UNet", "type": "select", "full": True},
        {"key": "clip", "label": "Z-Image CLIP", "type": "select", "full": True},
        {"key": "vae", "label": "Z-Image VAE", "type": "select", "full": True},
        {"key": "steps", "label": "二采步数", "type": "number"},
        {"key": "cfg", "label": "二采 CFG", "type": "number"},
        {"key": "denoise", "label": "二采降噪（越小越像原图）", "type": "number"},
        {"key": "shift", "label": "采样 shift", "type": "number"},
        {"key": "sampler_name", "label": "采样器", "type": "select"},
        {"key": "scheduler", "label": "调度器", "type": "select"},
        {"key": "seed", "label": "二采种子（-1 = 用工作流默认）", "type": "number"},
        {"key": "upscale_method", "label": "放大插值算法", "type": "select"},
        {"key": "dit_model", "label": "SeedVR2 DiT 模型", "type": "select", "full": True},
        {"key": "seedvr_vae", "label": "SeedVR2 VAE 模型", "type": "select", "full": True},
        {"key": "resolution", "label": "SeedVR2 目标分辨率", "type": "number"},
        {"key": "max_resolution", "label": "最大分辨率（0 = 不限制）", "type": "number"},
        {"key": "tile_x", "label": "分块列数", "type": "number"},
        {"key": "tile_y", "label": "分块行数", "type": "number"},
        {"key": "overlap", "label": "分块重叠率（0 – 0.5）", "type": "number"},
        {"key": "padding", "label": "拼接留边（像素）", "type": "number"},
        {"key": "color_correction", "label": "色彩校正", "type": "select"},
        {"key": "batch_size", "label": "每批块数", "type": "number"},
        {"key": "noise", "label": "输入噪声（0 – 1）", "type": "number"},
        {"key": "blocks_to_swap", "label": "显存优化：交换块数（0 = 关闭）", "type": "number"},
        {"key": "offload_device", "label": "卸载设备", "type": "select"},
    ]

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        try:
            scale = float(params.get("scale", 2))
        except (TypeError, ValueError):
            scale = 2.0
        scale = max(MIN_SCALE, min(MAX_SCALE, scale))
        return {"image": params.get("image"), "scale": round(scale, 2)}


WORKFLOW = SeedVR2TTPTwoPass()
