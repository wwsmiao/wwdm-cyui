"""ComfyUI 实例能力探测：这台实例上到底有哪些节点、哪些模型可用。

本地实例和远程实例差别很大：远程常常缺 SeedVR2 / TTP / Viggle 这类自定义节点，
同一个模型的文件名也不一样（量化后缀、子目录前缀、大小写）。工作流本身是写死的，
所以这里给出一份「按实例缓存」的能力快照：

  · 前端据 available 把跑不起来的工作流从下拉里隐藏（本地切回来又自动出现）
  · 设置面板 / 连接状态里给出原因，不用等提交后才看到 400
  · 模型名能不能对上由 core/models 的解析规则判断，能对上就算可用（提交时会自动改名）

整份 /object_info 只拉一次（远程实例约 1–2 秒），节点清单和模型清单都从这份里切出来，
避免每个工作流、每个字段各发一次请求。
"""
import time
from urllib.parse import urlparse

from core.comfy import ComfyError
from core.models import MODEL_FIELDS, REQUIRED_KINDS, combo_options, explain, resolve

SNAPSHOT_TTL = 180         # 快照缓存时长（秒）


class InstanceInfo:
    def __init__(self, comfy):
        self.comfy = comfy
        self._snapshot = {}   # base → (ts, {"labels": {...}, "options": {(cls, field): [...]}})
        self._caps = {}       # (base, ids) → (ts, dict)

    # ---------- 基础信息 ----------
    @property
    def base(self) -> str:
        return self.comfy.base

    def is_local(self) -> bool:
        host = (urlparse(self.base).hostname or "").lower()
        return host in ("127.0.0.1", "localhost", "::1", "")

    def snapshot(self, force: bool = False) -> dict | None:
        """整份实例信息；拉不到（实例掉线）返回 None，调用方就不要做限制。"""
        now = time.time()
        cached = self._snapshot.get(self.base)
        if cached and not force and now - cached[0] < SNAPSHOT_TTL:
            return cached[1]
        try:
            info = self.comfy.request("GET", "/object_info", timeout=120).json()
        except (ComfyError, ValueError):
            return None
        if not isinstance(info, dict) or not info:
            return None
        labels = {}
        options = {}
        for cls, spec in info.items():
            if not isinstance(spec, dict):
                continue
            labels[cls] = str(spec.get("display_name") or cls)
            inputs = spec.get("input") or {}
            for bucket in ("required", "optional"):
                for field, definition in (inputs.get(bucket) or {}).items():
                    # 所有下拉（模型、采样器、CLIP 类型 …）都存一份，设置面板就不用再逐个问
                    values = combo_options(definition)
                    if values:
                        options[(cls, field)] = values
        data = {"labels": labels, "options": options}
        if len(self._snapshot) > 6:
            self._snapshot.clear()
        self._snapshot[self.base] = (now, data)
        return data

    def nodes(self) -> dict | None:
        snap = self.snapshot()
        return (snap or {}).get("labels")

    def node_count(self) -> int:
        return len(self.nodes() or {})

    def model_options(self, node: str, field: str) -> list:
        snap = self.snapshot() or {}
        cached = (snap.get("options") or {}).get((node, field))
        if cached is not None:
            return cached
        # 快照里没有（节点是后来装的 / 快照过期）：单独问一次
        return self.comfy.combo_of(node, field)

    def cached_options(self, node: str, field: str) -> list | None:
        """只查快照，不发请求；快照里没有就返回 None 交给调用方去问。"""
        snap = self.snapshot()
        if not snap:
            return None
        return (snap.get("options") or {}).get((node, field))

    def options_of(self, kind: str) -> list:
        from core.models import KIND_SOURCES
        source = KIND_SOURCES.get(kind)
        if not source:
            return []
        return self.model_options(source[0], source[1])

    # ---------- 工作流体检 ----------
    def missing_nodes(self, graph: dict | None) -> list:
        avail = self.nodes()
        if not avail or not graph:
            return []
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), dict) else graph
        seen = []
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            cls = node.get("class_type")
            if cls and cls not in avail and cls not in seen:
                seen.append(cls)
        return seen

    def missing_models(self, graph: dict | None) -> list:
        if not graph:
            return []
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), dict) else graph
        missing = []
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            cls = node.get("class_type") or ""
            for field, value in (node.get("inputs") or {}).items():
                kind = MODEL_FIELDS.get(field)
                if not kind or kind not in REQUIRED_KINDS:
                    continue
                if not isinstance(value, str) or not value:
                    continue
                options = self.model_options(cls, field)
                if not options:
                    continue          # 节点不在实例里，由 missing_nodes 负责
                if resolve(kind, value, options) is None:
                    missing.append(explain(kind, value, options))
        return missing

    def inspect(self, workflow) -> dict:
        """单个工作流在当前实例上能不能跑。"""
        engine = getattr(workflow, "engine", "comfy")
        # 纯 Python（网格拼接）/ 直连第三方 API（DeepSeek）的工作流不依赖 ComfyUI 节点
        if engine != "comfy" or not getattr(workflow, "graph_file", ""):
            return {"available": True, "missing_nodes": [], "missing_models": [], "reason": ""}
        graph = workflow.graph()
        if not graph:
            return {"available": False, "missing_nodes": [], "missing_models": [],
                    "reason": "工作流图文件缺失"}
        missing_nodes = self.missing_nodes(graph)
        missing_models = self.missing_models(graph)
        reason = ""
        if missing_nodes:
            head = "、".join(missing_nodes[:3])
            more = f" 等 {len(missing_nodes)} 个节点" if len(missing_nodes) > 3 else ""
            reason = f"当前 ComfyUI 实例没装这些节点：{head}{more}"
        elif missing_models:
            reason = missing_models[0]
        return {
            "available": not missing_nodes and not missing_models,
            "missing_nodes": missing_nodes,
            "missing_models": missing_models,
            "reason": reason,
        }

    def capabilities(self, workflows: list, force: bool = False) -> dict:
        """{工作流 id: 体检结果}，同一实例 + 同一批工作流 2 分钟内复用。"""
        ids = tuple(sorted(getattr(wf, "id", "") for wf in workflows))
        key = (self.base, ids)
        now = time.time()
        cached = self._caps.get(key)
        if cached and not force and now - cached[0] < SNAPSHOT_TTL:
            return cached[1]
        if self.snapshot() is None:
            # 实例连不上时不做限制，否则下拉会一片空
            result = {wf.id: {"available": True, "missing_nodes": [], "missing_models": [],
                              "reason": ""} for wf in workflows}
        else:
            result = {wf.id: self.inspect(wf) for wf in workflows}
        if len(self._caps) > 6:
            self._caps.clear()
        self._caps[key] = (now, result)
        return result

    def summary(self, workflows: list) -> dict:
        caps = self.capabilities(workflows)
        unavailable = [
            {"id": wf.id, "name": wf.name or wf.id, "reason": caps[wf.id].get("reason", "")}
            for wf in workflows if not caps[wf.id].get("available", True)
        ]
        return {
            "base": self.base,
            "local": self.is_local(),
            "node_count": self.node_count(),
            "workflow_count": len(workflows),
            "unavailable": unavailable,
        }
