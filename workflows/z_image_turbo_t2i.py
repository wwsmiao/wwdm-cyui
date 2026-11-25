"""Z-Image-Turbo 文生图：ComfyUI 原生节点链，8 步出图，可叠最多 5 个 LoRA。

节点分工（改映射前先看这里）：
  66 UNETLoader → 73~77 LoraLoaderModelOnly → 69 ModelSamplingAuraFlow → 70 KSampler
  67 正向提示词 / 71 负面提示词 / 68 空 latent（宽高、张数）/ 62 CLIP / 63 VAE
"""
from workflows.base import Workflow


class ZImageTurboT2I(Workflow):
    id = "z-image-turbo-文生图"
    name = "Z-Image-Turbo 文生图"
    description = "ComfyUI 原生节点 · 8 步快速出图"
    kind = "image"
    graph_file = "z-image-turbo-文生图.json"

    mapping = {
        "prompt": ["67", "inputs", "text"],
        "negative": ["71", "inputs", "text"],
        "width": ["68", "inputs", "width"],
        "height": ["68", "inputs", "height"],
        "batch": ["68", "inputs", "batch_size"],
        "seed": ["70", "inputs", "seed"],
        "steps": ["70", "inputs", "steps"],
        "cfg": ["70", "inputs", "cfg"],
        "sampler_name": ["70", "inputs", "sampler_name"],
        "scheduler": ["70", "inputs", "scheduler"],
        "denoise": ["70", "inputs", "denoise"],
        "unet": ["66", "inputs", "unet_name"],
        "clip": ["62", "inputs", "clip_name"],
        "vae": ["63", "inputs", "vae_name"],
    }

    param_map = {
        "negative": ["71", "inputs", "text"],
        "seed": ["70", "inputs", "seed"],
        "steps": ["70", "inputs", "steps"],
        "cfg": ["70", "inputs", "cfg"],
        "sampler_name": ["70", "inputs", "sampler_name"],
        "scheduler": ["70", "inputs", "scheduler"],
        "denoise": ["70", "inputs", "denoise"],
        "unet": ["66", "inputs", "unet_name"],
        "clip": ["62", "inputs", "clip_name"],
        "vae": ["63", "inputs", "vae_name"],
    }

    lora = {
        "nodes": ["73", "74", "75", "76", "77"],
        "source": ["66", 0],
        "target_node": "69",
        "target_input": "model",
        "strength_default": 1,
    }


WORKFLOW = ZImageTurboT2I()
