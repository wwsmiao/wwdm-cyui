"""Qwen-Image 2.1 图片编辑：给 1-10 张参考图 + 编辑指令，改图但尽量保持原样。

节点分工（改映射前先看这里）：
  511 UNETLoader → 520 → 521 → 522 三个 LoraLoaderModelOnly → 518 QwenImage21Cache → 516 KSampler.model
  470/475/503/506/504/505/509/507/508/510 十个 LoadImage：参考图 1-10
  519 TextEncodeQwenImage21：prompt / negative / resolution / images.image_1..10 / vae
  517 ComfySwitchNode：switch=True 用 514 EmptyLatent（自定义尺寸），
                       switch=False 用 519 输出的 latent（保持第一张参考图尺寸）
  516 KSampler → 515 VAEDecode → 461 SaveImageAdvanced

和文生图的区别：
  · 必须给参考图，1-10 张都吃进同一个任务（images_per_task=10，不按图拆任务）
  · 默认保持参考图尺寸（switch=False），勾「自定义尺寸」才用 514 的比例/分辨率
  · 没用到的图片槽必须从图里摘掉，否则 LoadImage 会拿到空文件名
"""
from workflows.base import Workflow

# 参考图槽位：image_N 键 ↔ LoadImage 节点
IMAGE_SLOTS = [
    ("image_1", "470"),
    ("image_2", "475"),
    ("image_3", "503"),
    ("image_4", "506"),
    ("image_5", "504"),
    ("image_6", "505"),
    ("image_7", "509"),
    ("image_8", "507"),
    ("image_9", "508"),
    ("image_10", "510"),
]


class QwenImage21Edit(Workflow):
    id = "qwen-image-2.1-图片编辑"
    name = "Qwen-Image 2.1 图片编辑"
    description = "参考图编辑 · 最多 10 张图 · 默认保持原图尺寸 · 3 个 LoRA 槽"
    kind = "image"
    needs_image = True
    supports_size = True          # 只有勾「自定义尺寸」时生效
    supports_batch = False
    max_images = 10
    images_per_task = 10          # 1-10 张一起进同一个任务，不拆
    graph_file = "qwen-image-2.1-图片编辑.json"

    mapping = {
        "prompt": ["519", "inputs", "prompt"],
        "negative": ["519", "inputs", "negative_prompt"],
        "width": ["514", "inputs", "width"],
        "height": ["514", "inputs", "height"],
        "seed": ["516", "inputs", "seed"],
        "steps": ["516", "inputs", "steps"],
        "cfg": ["516", "inputs", "cfg"],
        "sampler_name": ["516", "inputs", "sampler_name"],
        "scheduler": ["516", "inputs", "scheduler"],
        "denoise": ["516", "inputs", "denoise"],
        "unet": ["511", "inputs", "unet_name"],
        "clip": ["512", "inputs", "clip_name"],
        "vae": ["513", "inputs", "vae_name"],
        "image": ["470", "inputs", "image"],
        "switch": ["517", "inputs", "switch"],
    }

    # 设置面板里能改的（prompt、参考图、宽高不在此列）
    param_map = {
        "negative": ["519", "inputs", "negative_prompt"],
        "seed": ["516", "inputs", "seed"],
        "steps": ["516", "inputs", "steps"],
        "cfg": ["516", "inputs", "cfg"],
        "sampler_name": ["516", "inputs", "sampler_name"],
        "scheduler": ["516", "inputs", "scheduler"],
        "denoise": ["516", "inputs", "denoise"],
        "resolution": ["519", "inputs", "resolution"],
        "unet": ["511", "inputs", "unet_name"],
        "clip": ["512", "inputs", "clip_name"],
        "vae": ["513", "inputs", "vae_name"],
        "custom_size": ["517", "inputs", "switch"],
    }

    # 三个 LoRA 槽：511 → 520 → 521 → 522 → 518
    lora = {
        "nodes": ["520", "521", "522"],
        "source": ["511", 0],
        "target_node": "518",
        "target_input": "model",
        "strength_default": 1,
    }

    def __init__(self):
        # 十张参考图各自写入自己的 LoadImage：image → 470、image2 → 475 … image10 → 510
        mapping = dict(type(self).mapping)
        for index, (_image_key, node_id) in enumerate(IMAGE_SLOTS, start=1):
            mapping["image" if index == 1 else f"image{index}"] = [node_id, "inputs", "image"]
        self.mapping = mapping

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        result = super().values(prompt, params, seed, negative)
        # 默认走「保持参考图尺寸」；设置里勾了 custom_size 才会被 param_map 覆盖成 True
        result["switch"] = False
        # 第 2 张起：image2 → image_2 …… image10 → image_10
        for index in range(2, len(IMAGE_SLOTS) + 1):
            key = f"image{index}"
            if params.get(key):
                result[key] = params.get(key)
        return result

    def build(self, prompt: str, params: dict | None = None, seed: int = 42,
              negative: str | None = None, workflow_params: dict | None = None) -> dict | None:
        graph = super().build(prompt, params, seed, negative, workflow_params)
        if graph is None:
            return None
        nodes = self.nodes_of(graph)
        # 前端传来的图片数量决定用几个槽；多余的槽（含 LoadImage 节点）整段摘掉，
        # 否则 LoadImage 会拿到空文件名，ComfyUI 直接报错
        given = [f"image{i}" if i > 1 else "image" for i in range(1, len(IMAGE_SLOTS) + 1)]
        params = params or {}
        used = sum(1 for key in given if str(params.get(key) or "").strip())
        used = max(1, min(len(IMAGE_SLOTS), used))
        encoder = nodes.get("519")
        for index, (image_key, node_id) in enumerate(IMAGE_SLOTS):
            if index < used:
                continue
            if encoder is not None:
                encoder.setdefault("inputs", {}).pop(f"images.{image_key}", None)
            nodes.pop(node_id, None)
        return graph


WORKFLOW = QwenImage21Edit()
