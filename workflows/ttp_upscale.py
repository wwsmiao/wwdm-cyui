"""TTP 分块高清放大：分块 + SeedVR2 逐块放大再拼回，唯一可调参数是放大倍数。

节点分工（改映射前先看这里）：
  682 LoadImage（输入图）
  681 ImageScaleBy scale_by = 放大倍数 → 689 取尺寸
  683 ImageScale 把原图放大到同一尺寸 → 684 TTP_Tile_image_size（3×3 分块、10% 重叠）
  685 TTP_Image_Tile_Batch 切块 → 695 缩到 0.25 → 696 SeedVR2VideoUpscaler 放大
  697 缩回块尺寸 → 699 TTP_Image_Assy 拼回 → 700 SaveImage
"""
from workflows.base import Workflow

MIN_SCALE, MAX_SCALE = 1.0, 10.0


class TTPUpscale(Workflow):
    id = "ttp-高清放大"
    name = "TTP 分块高清放大"
    description = "分块 + SeedVR2 放大 · 模型 / 分块 / 分辨率可调"
    kind = "image"
    needs_image = True
    max_images = 1
    supports_size = False     # 尺寸由原图 × 放大倍数决定
    supports_batch = False    # 一次只处理一张
    supports_prompt = False   # 这个工作流没有提示词输入

    # 唯一的生成参数：放大倍数滑块
    scale_param = {"min": MIN_SCALE, "max": MAX_SCALE, "step": 0.1, "default": 2.0, "label": "放大倍数"}

    graph_file = "ttp-高清放大.json"

    mapping = {
        "image": ["682", "inputs", "image"],
        "scale": ["681", "inputs", "scale_by"],
    }

    # 设置面板里能调的东西：模型、放大算法、分块、分辨率、拼接
    param_map = {
        "dit_model": ["691", "inputs", "model"],
        "seedvr_vae": ["692", "inputs", "model"],
        "upscale_method": ["681", "inputs", "upscale_method"],
        "tile_x": ["684", "inputs", "width_factor"],
        "tile_y": ["684", "inputs", "height_factor"],
        "overlap": ["684", "inputs", "overlap_rate"],
        "resolution": ["696", "inputs", "resolution"],
        "max_resolution": ["696", "inputs", "max_resolution"],
        "batch_size": ["696", "inputs", "batch_size"],
        "color_correction": ["696", "inputs", "color_correction"],
        "seed": ["696", "inputs", "seed"],
        "noise": ["696", "inputs", "input_noise_scale"],
        "blocks_to_swap": ["691", "inputs", "blocks_to_swap"],
        "offload_device": ["696", "inputs", "offload_device"],
        "padding": ["699", "inputs", "padding"],
    }

    # 这些下拉的可选值不在 UNET/CLIP/VAE 里，单独跟 ComfyUI 要
    option_sources = {
        "dit_model": ("SeedVR2LoadDiTModel", "model"),
        "seedvr_vae": ("SeedVR2LoadVAEModel", "model"),
        "upscale_method": ("ImageScaleBy", "upscale_method"),
        "color_correction": ("SeedVR2VideoUpscaler", "color_correction"),
        "offload_device": ("SeedVR2VideoUpscaler", "offload_device"),
    }

    # 设置面板字段（顺序即展示顺序）：放大倍数在创作区滑块，这里管模型与分块细节
    settings_fields = [
        {"key": "upscale_method", "label": "放大插值算法", "type": "select"},
        {"key": "dit_model", "label": "SeedVR2 DiT 模型", "type": "select", "full": True},
        {"key": "seedvr_vae", "label": "SeedVR2 VAE 模型", "type": "select", "full": True},
        {"key": "resolution", "label": "目标分辨率（长边，像素）", "type": "number"},
        {"key": "max_resolution", "label": "最大分辨率（0 = 不限制）", "type": "number"},
        {"key": "tile_x", "label": "分块列数", "type": "number"},
        {"key": "tile_y", "label": "分块行数", "type": "number"},
        {"key": "overlap", "label": "分块重叠率（0 – 0.5）", "type": "number"},
        {"key": "padding", "label": "拼接留边（像素）", "type": "number"},
        {"key": "seed", "label": "采样种子（-1 = 用工作流默认）", "type": "number"},
        {"key": "color_correction", "label": "色彩校正", "type": "select"},
        {"key": "noise", "label": "输入噪声（0 – 1）", "type": "number"},
        {"key": "batch_size", "label": "每批块数", "type": "number"},
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


WORKFLOW = TTPUpscale()
