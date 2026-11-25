"""项目清单：本项目需要哪些 ComfyUI 节点与模型，各自从哪来。

清单是**从工作流图里扫出来的**（新增工作流会自动多出条目），再套一份人工维护的
来源表（仓库 / 模型地址 / 放到哪个目录 / 说明）。没有公开地址的文件（自研 / 风格
LoRA 这类自备文件）不上清单，避免列出一堆点不开的条目。

所有链接都在 2026-11-25 逐个核对过：GitHub 仓库用 API 查过、模型仓库用魔搭
接口查过文件名，能对上当前工作流里写的文件名。
"""
import re

# ---------- 运行环境 ----------
CORE = {
    "name": "ComfyUI",
    "repo": "https://github.com/comfyanonymous/ComfyUI",
    "min_version": "0.44",
    "note": "Qwen-Image 2.1、MiniMax H3、ResolutionSelector、SaveImageAdvanced 都是内置节点，"
            "要用较新版本（0.46 实测正常）；老版本会提示缺节点。",
}

# ---------- 自定义节点包 ----------
# key = object_info 里的 python_module（custom_nodes.<目录名>）
PACKS = {
    "custom_nodes.ComfyUI-SeedVR2_VideoUpscaler": {
        "id": "seedvr2",
        "name": "ComfyUI-SeedVR2 Video Upscaler",
        "repo": "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler",
        "install": "git clone https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler",
        "purpose": "SeedVR2 高清放大 / 二采（画面修复里的放大链路）",
    },
    "custom_nodes.Comfyui_TTP_Toolset": {
        "id": "ttp",
        "name": "ComfyUI TTP Toolset",
        "repo": "https://github.com/TTPlanetPig/ComfyUI_TTP_Toolset",
        "install": "git clone https://github.com/TTPlanetPig/ComfyUI_TTP_Toolset",
        "purpose": "图片分块批处理（TTP 分块放大，配合 SeedVR2 处理大图）",
    },
    "custom_nodes.viggle_turbo": {
        "id": "viggle",
        "name": "Qwen-Image 2.1 Viggle Turbo",
        "repo": "https://github.com/RiverSide71/Qwen-Image-2.1-viggle-turbo",
        "install": "git clone https://github.com/RiverSide71/Qwen-Image-2.1-viggle-turbo",
        "purpose": "Viggle 6 步加速（ViggleTurboLora / ViggleTurboSigmas 节点）",
    },
}

# 拿不到 python_module（实例离线）时，按节点名兜底
PACK_BY_NODE = {
    "SeedVR2LoadDiTModel": "seedvr2", "SeedVR2LoadVAEModel": "seedvr2",
    "SeedVR2VideoUpscaler": "seedvr2",
    "TTP_Image_Assy": "ttp", "TTP_Image_Tile_Batch": "ttp", "TTP_Tile_image_size": "ttp",
    "ViggleTurboLora": "viggle", "ViggleTurboSigmas": "viggle",
}

RECOMMENDED = [{
    "id": "manager",
    "name": "ComfyUI-Manager（推荐）",
    "repo": "https://github.com/ltdrdata/ComfyUI-Manager",
    "install": "git clone https://github.com/ltdrdata/ComfyUI-Manager",
    "purpose": "在 ComfyUI 里一键安装 / 更新上面这些节点和缺失模型；不装也能手动 git clone。",
    "nodes": [],
    "workflows": [],
    "installed": None,
}]

MS = "https://modelscope.cn/models/"

# ---------- 模型来源 ----------
# 按文件名前缀匹配；folder 是放进 ComfyUI/models/ 下的哪个目录
CATALOG = [
    # Qwen-Image 2.1
    {"prefixes": ("qwen_image_2.1_int8_convrot", "qwen_image_2.1_turbo_int8_convrot",
                  "qwen_image_2.1_bf16", "qwen_image_2.1_turbo_bf16"),
     "folder": "diffusion_models", "repo": MS + "Comfy-Org/Qwen-Image-2.1",
     "note": "int8_convrot 省显存（约 7.3G），bf16 画质最好但更大"},
    {"prefixes": ("qwen3vl_8b_int8_convrot", "qwen3vl_8b_bf16", "qwen3vl_8b_w4a8"),
     "folder": "text_encoders", "repo": MS + "Comfy-Org/Qwen-Image-2.1",
     "note": "Qwen-Image 2.1 的文本编码器（Qwen3-VL 8B）"},
    {"prefixes": ("qwen_image_2.1_vae_bf16",),
     "folder": "vae", "repo": MS + "Comfy-Org/Qwen-Image-2.1"},
    {"prefixes": ("qwen3vl_4b_",),
     "folder": "text_encoders", "repo": MS + "Comfy-Org/Qwen3-VL",
     "note": "提示词反推 / 润色工作流用的轻量文本模型"},
    {"prefixes": ("gemma4_",),
     "folder": "text_encoders", "repo": MS + "Comfy-Org/gemma-4",
     "note": "gemma 系列提示词工作流（Gemma4 提示词生成）"},
    # Z-Image
    {"prefixes": ("z_image_turbo_bf16", "z_image_turbo_int8_convrot", "z_image_turbo_nvfp4"),
     "folder": "diffusion_models", "repo": MS + "Comfy-Org/z_image_turbo"},
    {"prefixes": ("z-image-turbo-fp8-e4m3fn",),
     "folder": "diffusion_models", "repo": MS + "Comfy-Org/z_image_turbo",
     "note": "图里默认写的是社区 fp8 量化版；同系列可用 z_image_turbo_int8_convrot 代替（改设置里的 UNet 即可）"},
    {"prefixes": ("qwen_3_4b",),
     "folder": "text_encoders", "repo": MS + "Comfy-Org/z_image_turbo",
     "note": "Z-Image 的文本编码器"},
    {"prefixes": ("ae.safetensors",),
     "folder": "vae", "repo": MS + "Comfy-Org/z_image_turbo",
     "note": "Z-Image 的 VAE"},
    {"prefixes": ("z_image_turbo_distill",),
     "folder": "loras", "repo": MS + "Comfy-Org/z_image_turbo", "optional": True},
    # MiniMax H3
    {"prefixes": ("MiniMax_H3_Ref2VA", "MiniMax_H3_FL2VA", "minimax_h3_ref2va", "minimax_h3_fl2va"),
     "folder": "diffusion_models", "repo": MS + "Comfy-Org/MiniMax-H3",
     "note": "仓库里同时有 bf16 / int8_convrot / pruned 等版本，按显存挑；工作流默认写的是 nvfp4 版"},
    {"prefixes": ("qwen3vl_32b_minimax_h3",),
     "folder": "text_encoders", "repo": MS + "Comfy-Org/MiniMax-H3",
     "note": "MiniMax H3 的 32B 文本编码器（nvfp4_awq 最省显存）"},
    {"prefixes": ("minimax_h3_video_vae", "minimax_h3_audio_vae", "minimax_h3_sol_vae"),
     "folder": "vae", "repo": MS + "Comfy-Org/MiniMax-H3",
     "note": "视频 VAE + 音频 VAE，两个都要放"},
    {"prefixes": ("minimax_h3_ref2v_turbo", "minimax_h3_fl2v_turbo"),
     "folder": "loras", "repo": MS + "Comfy-Org/MiniMax-H3",
     "note": "MiniMax 加速 LoRA（参考生视频 4 步 / 首尾帧 8 步），设置里可关"},
    # Qwen-Image 2.1 Viggle 加速
    {"prefixes": ("Qwen-Image-2.1-viggle-turbo",),
     "folder": "loras", "repo": MS + "Viggle/Qwen-Image-2.1-viggle-turbo",
     "note": "Viggle 官方 6 步加速 LoRA（r128 / r256 都可以）"},
    # SD1.5 局部重绘
    {"prefixes": ("512-inpainting-ema", "v1-5-pruned"),
     "folder": "checkpoints", "repo": MS + "AI-ModelScope/stable-diffusion-inpainting",
     "note": "SD1.5 inpaint 底模；仓库是 diffusers 格式，需要转单文件，或直接用整合包里的 "
             "512-inpainting-ema.safetensors。也可换 Comfy-Org/stable-diffusion-v1-5-archive 的 v1-5-pruned-emaonly"},
    # SeedVR2
    {"prefixes": ("seedvr2_ema_3b", "seedvr2_ema_7b", "ema_vae_fp16"),
     "folder": "SEEDVR2", "repo": MS + "numz/SeedVR2_comfyUI",
     "note": "放大模型 + 配套 VAE；3B 省显存，7B 更清晰"},
]


def folder_of(kind: str) -> str:
    return {
        "ckpt": "checkpoints", "unet": "diffusion_models", "clip": "text_encoders",
        "vae": "vae", "lora": "loras", "upscale": "upscale_models",
        "seedvr2_dit": "SEEDVR2", "seedvr2_vae": "SEEDVR2",
    }.get(kind, "models")


def _entry_for(name: str) -> dict:
    base = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    for item in CATALOG:
        if any(base.startswith(prefix) for prefix in item["prefixes"]):
            return item
    return {}


def build(workflows, instance=None) -> dict:
    """扫工作流图 → 插件清单 + 模型清单（附使用到的位置）。"""
    nodes = {}       # class_type → {workflows, module, category}
    models = {}      # (folder, name) → {workflows, kind}
    for wf in workflows:
        graph = wf.graph() if hasattr(wf, "graph") else None
        if not graph:
            continue
        body = graph.get("nodes") if isinstance(graph.get("nodes"), dict) else graph
        for node in body.values():
            if not isinstance(node, dict):
                continue
            cls = node.get("class_type") or ""
            if not cls:
                continue
            slot = nodes.setdefault(cls, {"workflows": set(), "module": "", "category": ""})
            slot["workflows"].add(wf.name or wf.id)
            inputs = node.get("inputs") or {}
            for field, value in inputs.items():
                if not isinstance(value, str) or not value:
                    continue
                if field in ("ckpt_name",):
                    kind = "ckpt"
                elif field in ("unet_name",):
                    kind = "unet"
                elif field in ("clip_name", "clip_name1", "clip_name2", "clip_name3"):
                    kind = "clip"
                elif field in ("vae_name",):
                    kind = "vae"
                elif field in ("lora_name",):
                    kind = "lora"
                elif field in ("model_name",):
                    kind = "upscale"
                elif field == "model" and cls == "SeedVR2LoadDiTModel":
                    kind = "seedvr2_dit"
                elif field == "model" and cls == "SeedVR2LoadVAEModel":
                    kind = "seedvr2_vae"
                else:
                    continue
                key = (folder_of(kind), str(value).replace("\\", "/"))
                models.setdefault(key, {"workflows": set(), "kind": kind})["workflows"].add(wf.name or wf.id)

    # 节点归属：先看当前实例报告的 python_module，再看节点名兜底表
    info = {}
    snapshot = instance.snapshot() if instance is not None else None
    if snapshot:
        for cls in nodes:
            # object_info 的 python_module 没放进快照，单独补一次（只查自定义节点，量很小）
            if cls not in ("SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel", "SeedVR2VideoUpscaler",
                           "TTP_Image_Assy", "TTP_Image_Tile_Batch", "TTP_Tile_image_size",
                           "ViggleTurboLora", "ViggleTurboSigmas"):
                continue
            try:
                raw = instance.comfy.object_info(cls, timeout=10).get(cls, {})
                info[cls] = raw.get("python_module") or ""
            except Exception:
                info[cls] = ""

    used_packs = {}
    for cls, slot in nodes.items():
        module = info.get(cls) or ""
        pack_id = ""
        for key, pack in PACKS.items():
            if module and module == key:
                pack_id = pack["id"]
                break
        if not pack_id:
            pack_id = PACK_BY_NODE.get(cls, "")
        if not pack_id:
            continue
        entry = used_packs.setdefault(pack_id, {"nodes": set(), "workflows": set()})
        entry["nodes"].add(cls)
        entry["workflows"] |= slot["workflows"]

    available = set()
    if snapshot:
        available = set((snapshot.get("labels") or {}))

    plugins = []
    for key, pack in PACKS.items():
        if pack["id"] not in used_packs:
            continue
        used = used_packs[pack["id"]]
        plugins.append({
            "id": pack["id"],
            "name": pack["name"],
            "repo": pack["repo"],
            "install": pack["install"],
            "purpose": pack["purpose"],
            "nodes": sorted(used["nodes"]),
            "workflows": sorted(used["workflows"]),
            # 实例离线时 installed=None，界面不要显示「未安装」
            "installed": (all(node in available for node in used["nodes"]) if available else None),
        })
    plugins.extend(RECOMMENDED)

    rows = []
    for (folder, name), meta in models.items():
        catalog = _entry_for(name)
        # 没有公开地址的文件（基本都是自备 LoRA）不上清单，免得列一堆点不开的条目
        if not catalog.get("repo"):
            continue
        rows.append({
            "name": name,
            "folder": folder,
            "repo": catalog.get("repo", ""),
            "note": catalog.get("note", ""),
            "optional": bool(catalog.get("optional")),
            "workflows": sorted(meta["workflows"]),
            "present": _present(instance, folder, meta["kind"], name),
        })
    rows.sort(key=lambda row: (FOLDER_ORDER.index(row["folder"])
                               if row["folder"] in FOLDER_ORDER else 99, row["name"]))

    groups = []
    for folder in FOLDER_ORDER:
        items = [row for row in rows if row["folder"] == folder]
        if items:
            groups.append({"folder": folder, "items": items})

    return {"core": CORE, "plugins": plugins, "models": rows, "groups": groups}


FOLDER_ORDER = ["diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "SEEDVR2", "upscale_models"]

# 目录 → 查「当前实例有没有这个文件」用的节点字段
FOLDER_SOURCE = {
    "diffusion_models": ("UNETLoader", "unet_name", "unet"),
    "text_encoders": ("CLIPLoader", "clip_name", "clip"),
    "vae": ("VAELoader", "vae_name", "vae"),
    "loras": ("LoraLoaderModelOnly", "lora_name", "lora"),
    "checkpoints": ("CheckpointLoaderSimple", "ckpt_name", "ckpt"),
    "upscale_models": ("UpscaleModelLoader", "model_name", "upscale"),
    "SEEDVR2": ("SeedVR2LoadDiTModel", "model", "seedvr2"),
}


def _present(instance, folder: str, kind: str, name: str):
    """当前实例里有没有这个名字；实例离线返回 None（界面不显示「缺失」）。"""
    if instance is None:
        return None
    source = FOLDER_SOURCE.get(folder)
    if folder == "SEEDVR2":
        node = "SeedVR2LoadVAEModel" if kind == "seedvr2_vae" else "SeedVR2LoadDiTModel"
        source = (node, "model", "seedvr2")
    if not source:
        return None
    node, field, resolve_kind = source
    options = instance.model_options(node, field)
    if not options:
        return None
    from core.models import resolve
    return resolve(resolve_kind, name, options) is not None
