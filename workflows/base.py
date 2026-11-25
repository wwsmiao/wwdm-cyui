"""工作流基类：图加载、参数注入、LoRA 串联。

每个工作流一个模块（见同目录 z_image_turbo_t2i.py 等），只声明自己那张图的
文件、节点映射和能力开关；真正的注入逻辑都在这里，避免三个文件各写一套。
"""
import json
import random
from copy import deepcopy

from config import ASPECT_RATIOS, DEFAULT_PARAMS, RESOLUTIONS, WORKFLOW_DIR

GRAPH_DIR = WORKFLOW_DIR / "graphs"

# 提示词（LLM）参数的取值类型
LLM_BOOL_KEYS = {"thinking"}
LLM_INT_KEYS = {"max_length", "top_k", "seed"}
LLM_FLOAT_KEYS = {"temperature", "top_p", "min_p", "repetition_penalty", "presence_penalty"}


def resolve_size(ratio: str, resolution: str) -> tuple:
    """按比例与最长边算出宽高，并向下对齐到 64 的倍数。"""
    rw, rh = ASPECT_RATIOS.get(ratio, ASPECT_RATIOS["1:1"])
    longest = RESOLUTIONS.get(resolution, RESOLUTIONS["1k"])
    scale = longest / max(rw, rh)
    width = int(rw * scale) // 64 * 64 or 64
    height = int(rh * scale) // 64 * 64 or 64
    return width, height


def resolve_params_size(params: dict) -> tuple:
    """统一尺寸入口：自定义宽高优先，按 8 像素对齐以兼容 latent。"""
    params = params or {}
    if params.get("custom"):
        try:
            width = int(params.get("custom_width", 1024))
            height = int(params.get("custom_height", 1024))
        except (TypeError, ValueError):
            width, height = 1024, 1024
        width = max(64, min(4096, width // 8 * 8))
        height = max(64, min(4096, height // 8 * 8))
        return width, height
    return resolve_size(params.get("ratio", "1:1"), params.get("resolution", "1k"))


def set_value(nodes: dict, path, value) -> bool:
    """把值写进 node[section][field]；空值与路径不匹配都直接跳过。"""
    if value is None or value == "":
        return False
    try:
        node_id, section, field = path
        nodes[node_id][section][field] = value
        return True
    except (KeyError, TypeError, ValueError):
        return False


class Workflow:
    """一个 ComfyUI 工作流的全部描述。"""

    id = ""
    name = ""
    description = ""
    kind = "image"           # image | video | llm
    # 用途分类：inpaint = 只给「画面修复 - 局部重绘」按钮用，创作区的工作流下拉里不出现
    category = ""
    # 执行引擎：comfy = 提交给 ComfyUI；python = 后端自己算（没有 graph_file）
    engine = "comfy"
    needs_image = False      # 是否必须提供参考图
    supports_prompt = True   # 是否有提示词输入（纯放大类工作流为 False）
    scale_param = None       # 只有一个「放大倍数」滑块的工作流在这里声明 {min,max,step,default}
    images_per_task = 1      # 一个任务吃几张参考图（首尾帧工作流是 2，图片编辑最多 10）
    min_images = 1           # 至少几张才能提交（首尾帧必须 2 张）
    graph_file = ""          # graphs/ 下的 JSON 文件名

    # 能力开关：false 表示界面上的对应参数对本工作流无效
    supports_size = True     # 图片比例 / 分辨率 / 自定义宽高
    supports_batch = True    # 生成张数
    estimate_size = True     # 提交时按参数估算宽高（不支持尺寸的、或尺寸由专门节点算的工作流设为 False）

    mapping = {}             # 生成参数 → 节点路径
    param_map = {}           # 设置面板参数 → 节点路径
    # 设置面板下拉框的可选值来源：{参数名: (节点类型, 输入字段)}，
    # 用于不走 UNET/CLIP/VAE 的工作流（如 TTP 放大的 SeedVR2 模型）
    option_sources = {}
    # 设置面板要渲染哪些字段（顺序即展示顺序）：[{key,label,type,options?,full?}]，
    # 为 None 时按 imageFields / videoFields 的固定布局渲染
    settings_fields = None
    lora = {}                # LoRA 槽位描述
    # 局部重绘弹窗里显示的一句话提示（如「SD1.5 512 附近最稳」），非 inpaint 工作流为空
    inpaint_note = ""
    # 默认沿用图里哪些槽位已经接好的 LoRA（槽位号）。空 = 全部空着（不选就不加载）；
    # 图里自带 LoRA 又不想一开就叠 N 层的工作流，在这里只列要沿用的槽位
    lora_keep = ()

    _graph = None

    # ---------- 图 ----------
    @property
    def graph_path(self):
        return GRAPH_DIR / self.graph_file

    def graph(self) -> dict | None:
        """返回图的深拷贝，调用方可以随便改。"""
        if self._graph is None:
            try:
                with self.graph_path.open("r", encoding="utf-8") as fh:
                    self._graph = json.load(fh)
            except (OSError, ValueError):
                return None
        return deepcopy(self._graph)

    def nodes_of(self, graph: dict) -> dict:
        return graph.get("nodes", graph)

    def node_count(self) -> int:
        graph = self.graph() or {}
        return len(self.nodes_of(graph))

    def list_item(self) -> dict:
        return {
            "id": self.id,
            "name": self.name or self.id,
            "description": self.description,
            "node_count": self.node_count(),
            "kind": self.kind,
            "category": getattr(self, "category", "") or "",
            "engine": getattr(self, "engine", "comfy"),
            # 纯 Python 工作流自己的专属参数（网格拼接的行/列）
            "grid": getattr(self, "grid", None),
            "needs_image": self.needs_image,
            "supports_size": self.supports_size,
            "supports_batch": self.supports_batch,
            "images_per_task": self.images_per_task,
            "supports_prompt": bool(getattr(self, "supports_prompt", True)),
            "scale": getattr(self, "scale_param", None),
            "inpaint_note": getattr(self, "inpaint_note", "") or "",
            "limits": self.limits(),
        }

    # 媒体素材上限：None 表示不限制，工作流按自己的输入槽位声明
    max_images = None
    max_videos = None
    max_audios = None

    def limits(self) -> dict | None:
        """媒体素材上限（图片/视频/音频各最多几个），None 表示不限制。"""
        return {
            "images": self.max_images,
            "videos": self.max_videos,
            "audios": self.max_audios,
        }

    # ---------- 取值 ----------
    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        """界面参数 → 图里要写的值。不支持的参数干脆不出现，避免误写。"""
        result = {"prompt": prompt, "negative": negative, "seed": int(seed)}
        if self.supports_size:
            width, height = resolve_params_size(params)
            result["width"] = width
            result["height"] = height
        if self.supports_batch:
            try:
                result["batch"] = max(1, int(params.get("batch", 1)))
            except (TypeError, ValueError):
                result["batch"] = 1
        if self.needs_image:
            result["image"] = params.get("image")
        return result

    @staticmethod
    def coerce(key: str, raw):
        """设置面板里的字符串统一转成节点需要的类型。"""
        if key in ("turbo", "use_lora", "enabled", "switch", "custom_size", "rewrite"):
            return str(raw).strip().lower() in ("1", "true", "on", "yes", "开", "开启")
        if key in ("seed", "steps", "steps_turbo", "steps_full", "largest_size",
                   "tile_x", "tile_y", "resolution", "max_resolution", "batch_size",
                   "padding", "blocks_to_swap", "size_multiple", "grow_mask_by"):
            try:
                return int(float(raw))
            except (TypeError, ValueError):
                return None
        if key in ("fps", "multiple"):
            # 帧率与尺寸对齐步长是 FLOAT 输入（156/157 是 PrimitiveFloat），保持小数
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
        if key in ("cfg", "denoise", "quality", "duration", "overlap", "noise", "shift",
                   "lora_strength", "megapixels"):
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
        if key == "batch":
            try:
                return int(raw)
            except (TypeError, ValueError):
                return None
        return str(raw)

    def apply_params(self, nodes: dict, workflow_params: dict | None) -> None:
        """设置里保存的参数优先级最高，按工作流独立生效。"""
        for key, raw in (workflow_params or {}).items():
            path = self.param_map.get(key)
            if not path or raw is None or raw == "":
                continue
            value = self.coerce(key, raw)
            if value is None or (key == "seed" and value < 0):
                continue
            set_value(nodes, path, value)

    # ---------- LoRA ----------
    def lora_values(self, workflow_params: dict | None) -> list:
        if not self.lora:
            return []
        params = workflow_params or {}
        slots = list(self.lora.get("nodes") or [])
        default_strength = self.lora.get("strength_default", 1)
        builtin = self.builtin_loras()
        result = []
        for index, slot in enumerate(slots, 1):
            key = f"lora_{index}"
            # 键存在就是用户的明确选择（空串 = 这个槽位不用），没这个键才回落到图里自带的
            name = (str(params.get(key) or "").strip() if key in params
                    else builtin.get(slot, {}).get("name", ""))
            if not name:
                continue
            raw = params.get(f"{key}_strength")
            if raw is None or raw == "":
                raw = builtin.get(slot, {}).get("strength", default_strength)
            try:
                strength = float(raw)
            except (TypeError, ValueError):
                strength = float(default_strength)
            result.append({"name": name, "strength": strength})
        return result

    def builtin_loras(self) -> dict:
        """图里已经接好、且声明要沿用的 LoRA：{节点号: {"name", "strength"}}。"""
        if not self.lora:
            return {}
        keep = [str(sid) for sid in (self.lora_keep or ())]
        if not keep:
            return {}
        nodes = self.nodes_of(self.graph() or {})
        result = {}
        for slot in keep:
            if slot not in (self.lora.get("nodes") or []):
                continue
            inputs = (nodes.get(slot) or {}).get("inputs") or {}
            name = str(inputs.get("lora_name") or "").strip()
            if not name:
                continue
            try:
                strength = float(inputs.get("strength_model", self.lora.get("strength_default", 1)))
            except (TypeError, ValueError):
                strength = self.lora.get("strength_default", 1)
            result[slot] = {"name": name, "strength": strength}
        return result

    def apply_loras(self, nodes: dict, loras: list) -> None:
        """按选中的 LoRA 重建串联链：没用到的槽位直接从图里摘掉。"""
        if not self.lora:
            return
        slots = list(self.lora.get("nodes") or [])
        templates = {sid: deepcopy(nodes[sid]) for sid in slots if sid in nodes}
        for sid in slots:
            nodes.pop(sid, None)
        if not templates:
            return

        first = templates.get(slots[0]) or next(iter(templates.values()))
        previous = list(self.lora.get("source") or [])
        for index, slot in enumerate(slots[:len(loras)]):
            lora = loras[index]
            node = deepcopy(templates.get(slot) or first)
            node.setdefault("inputs", {})["lora_name"] = lora["name"]
            node["inputs"]["strength_model"] = lora["strength"]
            node["inputs"]["model"] = previous
            nodes[slot] = node
            previous = [slot, 0]

        target = nodes.get(self.lora.get("target_node"))
        if target is not None:
            target.setdefault("inputs", {})[self.lora.get("target_input", "model")] = previous
        # 一个模型同时喂给多个下游节点时（如调度器 + 引导器）用 targets 一起接
        for node_id, field in self.lora.get("targets") or []:
            node = nodes.get(node_id)
            if node is not None:
                node.setdefault("inputs", {})[field] = previous

    # ---------- 组装 ----------
    def build(self, prompt: str, params: dict | None = None, seed: int = 42,
              negative: str | None = None, workflow_params: dict | None = None) -> dict | None:
        graph = self.graph()
        if graph is None:
            return None
        params = {**DEFAULT_PARAMS, **(params or {})}
        nodes = self.nodes_of(graph)

        values = self.values(prompt, params, seed, negative)
        for key, path in self.mapping.items():
            if key in values:
                set_value(nodes, path, values[key])

        self.apply_params(nodes, workflow_params)
        self.apply_loras(nodes, self.lora_values(workflow_params))
        return graph


class PromptWorkflow(Workflow):
    """文本生成类工作流（提示词润色）：只吃文字，没有尺寸概念。"""

    kind = "llm"
    supports_size = False
    supports_batch = False
    # 媒体素材上限：None 表示不限制，模块按自己的槽位数声明
    max_images = None
    max_videos = None
    max_audios = None

    def limits(self) -> dict:
        return {
            "images": self.max_images,
            "videos": self.max_videos,
            "audios": self.max_audios,
        }

    @staticmethod
    def coerce_llm(key: str, raw):
        if key in LLM_BOOL_KEYS:
            return str(raw).strip().lower() in ("1", "true", "on", "yes", "开", "开启")
        if key in LLM_INT_KEYS:
            try:
                value = int(float(raw))
            except (TypeError, ValueError):
                return None
            # 界面用 -1 表示随机，ComfyUI 的 seed 不接受负数
            if key == "seed":
                return random.randint(0, 2 ** 31 - 1) if value < 0 else value
            return value
        if key in LLM_FLOAT_KEYS:
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
        return str(raw)

    def build_prompt(self, user_text: str, prompt_params: dict | None = None,
                     images=None, videos=None, audios=None) -> dict | None:
        """用户提示词套模板后注入，其余参数按 param_map 覆盖。

        素材参数留给子类使用，基类只处理文字。
        """
        graph = self.graph()
        if graph is None:
            return None
        nodes = self.nodes_of(graph)
        params = dict(prompt_params or {})

        template = str(params.pop("user_prompt", "") or "").strip()
        if template:
            text = (template.replace("{prompt}", user_text)
                    if "{prompt}" in template else f"{template}\n\n{user_text}")
        else:
            text = user_text
        params["user_prompt"] = text

        for key, raw in params.items():
            path = self.param_map.get(key)
            if not path or raw is None or raw == "":
                continue
            value = self.coerce_llm(key, raw)
            if value is None:
                continue
            set_value(nodes, path, value)
        return graph
