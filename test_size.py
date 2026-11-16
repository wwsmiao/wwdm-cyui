# -*- coding: utf-8 -*-
"""尺寸链路诊断：模拟前端不同选择，打印实际进入工作流的画布尺寸。

用法：venv\\Scripts\\python.exe test_size.py
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from app import comfy, workflows


def ensure_ref(path):
    """诊断用原图，不存在就现造一张 1000×750（故意用非 32 倍数的尺寸）"""
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.new("RGB", (1000, 750), (120, 140, 160)).save(path)
    return path


def upload_ref(path, name="cyui_sztest_ref.png"):
    raw = open(path, "rb").read()
    return comfy.upload_image(raw, name)


def probe(label, mode, params, images, mask=None):
    raw = {
        "mode": mode,
        "prompt": "把天空换成晚霞",
        "params": params,
        "images": images,
        "mask": mask,
    }
    cfg = workflows.normalize(raw)
    # 复现 routes._enrich_ref_size 的行为
    from app import routes
    cfg = routes._enrich_ref_size(cfg)
    prompt, meta = workflows.build(cfg)

    latent_node = meta["latent"]
    # 找出真正的画布尺寸
    w = h = "?"
    for k, v in prompt.items():
        ct = v.get("class_type")
        if ct == "EmptyLatentImage":
            w, h = v["inputs"]["width"], v["inputs"]["height"]
        elif ct == "ImageScale" and k == "ref_scaled":
            w, h = v["inputs"]["width"], v["inputs"]["height"]
    mask_info = ""
    for k, v in prompt.items():
        if v.get("class_type") in ("LoadImageMask", "ImageToMask"):
            up = v["inputs"]["image"]
            src = prompt[up[0]] if up[0] in prompt else {}
            mask_info = " mask=%s" % repr(src.get("inputs", {}))
            break
    print("%-26s -> %sx%s  [%s]%s" % (label, w, h, latent_node, mask_info))


def check_chain(mode, params, images, mask):
    """返回采样节点 latent 输入向上游回溯的节点类型链，用于确认节点接法没被改坏。"""
    raw = {"mode": mode, "prompt": "x", "params": params, "images": images, "mask": mask}
    cfg = workflows.normalize(raw)
    from app import routes
    cfg = routes._enrich_ref_size(cfg)
    prompt, _ = workflows.build(cfg)
    ref = prompt["sample"]["inputs"]["latent_image"]
    chain, seen = [], set()
    while ref and ref[0] in prompt and ref[0] not in seen:
        seen.add(ref[0])
        node = prompt[ref[0]]
        chain.append(node["class_type"])
        ref = node["inputs"].get("samples") or node["inputs"].get("pixels")
    return chain


def main():
    p = ensure_ref("data/_sztest/ref_1000x750.png")
    name = upload_ref(p)
    print("原图 1000x750（非 32 倍数）-> %s\n" % name)

    base = {"steps": 8, "cfg": 1.0, "resolution": 1024, "batch": 1}

    print("== 图生图：auto 跟随图1 ==")
    probe("auto + 16:9 1K", "img2img", dict(base, size_mode="auto", width=1024, height=576), [name])
    probe("auto + 1:1 1K", "img2img", dict(base, size_mode="auto", width=1024, height=1024), [name])
    probe("auto + 2K", "img2img", dict(base, size_mode="auto", width=2048, height=1152), [name])

    print("\n== 图生图：fixed 按用户指定 ==")
    probe("fixed + 16:9 1K", "img2img", dict(base, size_mode="fixed", width=1024, height=576), [name])
    probe("fixed + 1:1 1K", "img2img", dict(base, size_mode="fixed", width=1024, height=1024), [name])
    probe("fixed + 800x600", "img2img", dict(base, size_mode="fixed", width=800, height=600), [name])
    probe("旧参数 custom_size", "img2img", dict(base, width=800, height=600, custom_size=True), [name])

    print("\n== 图生图：native 原图像素 ==")
    probe("native", "img2img", dict(base, size_mode="native", width=1024, height=1024), [name])

    print("\n== 局部重绘（重点：遮罩必须与画布同尺寸）==")
    m = upload_ref(p, "cyui_sztest_mask.png")
    probe("auto + 遮罩", "inpaint", dict(base, size_mode="auto", width=1024, height=1024), [name], m)
    probe("fixed 16:9 + 遮罩", "inpaint", dict(base, size_mode="fixed", width=1024, height=576), [name], m)
    probe("native + 遮罩", "inpaint", dict(base, size_mode="native", width=1024, height=1024), [name], m)

    print("\n== 文生图（无参考图，回归）==")
    probe("16:9 1K", "text2img", dict(base, size_mode="auto", width=1024, height=576), [])
    probe("1:1 1K", "text2img", dict(base, size_mode="auto", width=1024, height=1024), [])

    print("\n== 多张 + 遮罩（节点顺序回归）==")
    chain = check_chain("inpaint", dict(base, size_mode="auto", width=1024, height=1024, batch=2), [name], m)
    print("  采样输入链:", " -> ".join(chain))

    print("\n== 图片编辑 ==")
    probe("edit 自动（空画布）", "edit", dict(base, size_mode="auto", width=1024, height=1024), [name])
    probe("edit 按比例 16:9", "edit", dict(base, size_mode="fixed", width=1024, height=576), [name])


if __name__ == "__main__":
    main()
