# -*- coding: utf-8 -*-
"""高清放大（SeedVR2 + 分块拼接）

预设：app/presets/upscale_seedvr2.json（来自用户提供的「高清放大.json」，
已移除 easy-use / PreviewImage 这类只用于界面展示的节点，减少依赖）

链路：
    LoadImage → ImageScaleBy(scale)              目标尺寸
              → ImageScale(原图 → 目标尺寸)
              → TTP 切块 → 每块缩到 1/4 → SeedVR2 放大 → 拼回 → SaveImage

说明：工作流内部把每个分块缩到 25% 再交给 SeedVR2，所以最终像素尺寸由
ImageScaleBy 的 scale_by 决定，SeedVR2 只负责细节重建。
"""
import copy
import io
import json
import os
import random

from PIL import Image, ImageOps

from . import comfy, config

_PRESET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets", "upscale_seedvr2.json")

with open(_PRESET_FILE, "r", encoding="utf-8") as _f:
    PRESET = json.load(_f)

DEFAULTS = {
    "scale": 2.0,                 # 「默认」档的放大倍数
    "dit": "seedvr2_ema_3b_fp16.safetensors",
    "vae": "ema_vae_fp16.safetensors",
    "resolution": 1024,           # SeedVR2 每个分块的处理分辨率（短边）
    "tile_factor": 3,             # 横/纵切块数
    "tile_overlap": 0.1,
    "attention_mode": "sageattn_3",
    "color_correction": "lab",
    "offload_device": "cpu",
    "blocks_to_swap": 0,
}

# 菜单档位：default 用设置里的倍数，其余按「长边像素」放大
TARGETS = [("default", "默认"), ("1536", "1.5K"), ("2048", "2K"), ("4096", "4K")]


def settings():
    out = dict(DEFAULTS)
    saved = config.get("upscale") or {}
    if isinstance(saved, dict):
        for k in DEFAULTS:
            if saved.get(k) is not None:
                out[k] = saved[k]
    try:
        out["scale"] = max(1.0, min(4.0, float(out["scale"])))
    except Exception:
        out["scale"] = 2.0
    try:
        out["resolution"] = max(256, min(2048, int(out["resolution"])))
        out["tile_factor"] = max(1, min(6, int(out["tile_factor"])))
        out["blocks_to_swap"] = max(0, min(40, int(out["blocks_to_swap"])))
        out["tile_overlap"] = max(0.0, min(0.5, float(out["tile_overlap"])))
    except Exception:
        out.update(DEFAULTS)
    return out


def save_settings(patch):
    cur = settings()
    for k, v in (patch or {}).items():
        if k not in DEFAULTS:
            continue
        try:
            if k in ("scale", "tile_overlap"):
                cur[k] = float(v)
            elif k in ("resolution", "tile_factor", "blocks_to_swap"):
                cur[k] = int(v)
            else:
                cur[k] = str(v)
        except Exception:
            continue
    config.set_many({"upscale": cur})
    return settings()


def image_size(name):
    """读 ComfyUI input 里的图片真实尺寸（按 EXIF 方向）"""
    raw = comfy.view(name, "", "input")
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)
        return im.size


def resolve(image_name, target, cfg=None):
    """把菜单档位换算成实际倍数，返回 (scale, (src_w, src_h), (out_w, out_h))"""
    cfg = cfg or settings()
    sw, sh = image_size(image_name)
    sw, sh = max(1, sw), max(1, sh)
    if target in (None, "", "default"):
        scale = float(cfg["scale"])
    else:
        try:
            long_edge = int(float(target))
        except Exception:
            long_edge = 0
        if long_edge >= 256:
            scale = long_edge / float(max(sw, sh))
        else:
            scale = float(target) if target else float(cfg["scale"])
    scale = max(1.0, min(12.0, round(scale, 4)))
    ow, oh = round(sw * scale), round(sh * scale)
    # 某些节点对奇数尺寸敏感，向上取偶
    ow, oh = ow + (ow % 2), oh + (oh % 2)
    return scale, (sw, sh), (ow, oh)


def build(image_name, scale, cfg=None, prefix=None):
    """按预设生成 API prompt，只改图片 / 倍数 / 模型 / 分块等参数"""
    cfg = cfg or settings()
    if not cfg.get("dit") or not cfg.get("vae"):
        raise comfy.ComfyError("未配置 SeedVR2 放大模型，请到「全局设置 → 高清放大」选择模型")
    wf = copy.deepcopy(PRESET)

    wf["681"]["inputs"]["image"] = image_name
    wf["682"]["inputs"]["scale_by"] = round(float(scale), 4)

    tile = max(1, min(6, int(cfg["tile_factor"])))
    wf["684"]["inputs"].update({
        "width_factor": tile,
        "height_factor": tile,
        "overlap_rate": float(cfg["tile_overlap"]),
    })

    wf["691"]["inputs"].update({
        "model": cfg["dit"],
        "attention_mode": cfg["attention_mode"],
        "offload_device": cfg["offload_device"],
        "blocks_to_swap": int(cfg["blocks_to_swap"]),
    })
    wf["692"]["inputs"]["model"] = cfg["vae"]

    wf["696"]["inputs"].update({
        "seed": random.randint(1, 2 ** 31 - 1),
        "resolution": int(cfg["resolution"]),
        "color_correction": cfg["color_correction"],
        "offload_device": cfg["offload_device"],
    })

    wf["699"]["inputs"]["filename_prefix"] = prefix or "cyui/upscale"
    return wf
