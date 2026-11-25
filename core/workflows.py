"""工作流门面：把 workflows/ 下每个工作流模块收拢成统一接口。

具体某个工作流的节点映射、能力开关都写在它自己的 .py 里（workflows/xxx.py），
这里只负责查表、读默认值、读模型名，以及在需要时调用它的 build()。
"""
from workflows import WORKFLOWS
from workflows.base import resolve_params_size, resolve_size  # 兼容旧的导入路径

__all__ = ["WorkflowManager", "resolve_size", "resolve_params_size"]


class WorkflowManager:
    def __init__(self, registry: dict | None = None):
        self._items = dict(registry if registry is not None else WORKFLOWS)

    # ---------- 元信息 ----------
    def get_workflow(self, workflow_id: str):
        return self._items.get(workflow_id)

    def list(self) -> list:
        return [wf.list_item() for wf in self._items.values()]

    def ids(self) -> list:
        return list(self._items)

    def all(self) -> list:
        """按注册顺序返回工作流对象本身（体检、批量校验用）。"""
        return list(self._items.values())

    def kind_of(self, workflow_id: str) -> str:
        wf = self.get_workflow(workflow_id)
        return wf.kind if wf else "image"

    def needs_image_of(self, workflow_id: str) -> bool:
        wf = self.get_workflow(workflow_id)
        return bool(wf.needs_image) if wf else False

    def supports_of(self, workflow_id: str) -> dict:
        wf = self.get_workflow(workflow_id)
        if not wf:
            return {"size": False, "batch": False, "estimate": False}
        return {
            "size": bool(wf.supports_size),
            "batch": bool(wf.supports_batch),
            "estimate": bool(getattr(wf, "estimate_size", True)),
        }

    def get(self, workflow_id: str) -> dict | None:
        wf = self.get_workflow(workflow_id)
        return wf.graph() if wf else None

    def model_of(self, workflow_id: str) -> str:
        """从 UNETLoader 节点读出底模名称，供作品信息卡使用。"""
        graph = self.get(workflow_id) or {}
        for node in (graph.get("nodes", graph)).values():
            if node.get("class_type") == "UNETLoader":
                return node.get("inputs", {}).get("unet_name", "")
        return ""

    def negative_of(self, workflow_id: str) -> str:
        """读取负面提示词节点。"""
        wf = self.get_workflow(workflow_id)
        graph = self.get(workflow_id) or {}
        nodes = graph.get("nodes", graph)
        path = (wf.mapping.get("negative") if wf else None)
        if path:
            try:
                node_id, section, field = path
                return nodes[node_id][section][field]
            except (KeyError, TypeError, ValueError):
                pass
        for node in nodes.values():
            if node.get("class_type") == "CLIPTextEncode":
                text = node.get("inputs", {}).get("text", "")
                if "low quality" in text.lower():
                    return text
        return ""

    # ---------- 参数面板 ----------
    def param_map_of(self, workflow_id: str) -> dict:
        wf = self.get_workflow(workflow_id)
        return dict(wf.param_map) if wf else {}

    def defaults_of(self, workflow_id: str) -> dict:
        wf = self.get_workflow(workflow_id)
        if not wf:
            return {}
        graph = self.get(workflow_id) or {}
        nodes = graph.get("nodes", graph)
        defaults = dict(getattr(wf, "default_params", {}) or {})
        for key, path in (wf.param_map or {}).items():
            try:
                node_id, section, field = path
                defaults[key] = nodes[node_id][section][field]
            except (KeyError, TypeError, ValueError):
                continue
        defaults["seed"] = -1
        # LoRA 槽位：默认空着（不选就不加载，避免一开就叠满 5 个）；
        # 图里本来就接好 LoRA 的工作流（lora_default = "graph"）沿用图里的，别让用户一开就没 LoRA
        if wf.lora:
            strength = wf.lora.get("strength_default", 1)
            builtin = wf.builtin_loras() if hasattr(wf, "builtin_loras") else {}
            for index, node_id in enumerate(wf.lora.get("nodes") or [], 1):
                node = nodes.get(node_id) or {}
                defaults[f"lora_{index}"] = builtin.get(node_id, {}).get("name", "")
                defaults[f"lora_{index}_strength"] = builtin.get(node_id, {}).get(
                    "strength",
                    node.get("inputs", {}).get("strength_model", strength))
        return defaults

    def lora_spec_of(self, workflow_id: str) -> dict:
        wf = self.get_workflow(workflow_id)
        return dict(wf.lora) if wf and wf.lora else {}

    def lora_slots_of(self, workflow_id: str) -> int:
        return len(self.lora_spec_of(workflow_id).get("nodes") or [])

    def loras_of(self, workflow_id: str, workflow_params: dict | None = None) -> list:
        """本次实际会加载的 LoRA（名称 + 权重），用于写进作品记录。"""
        wf = self.get_workflow(workflow_id)
        return wf.lora_values(workflow_params) if wf else []

    # ---------- 构建 ----------
    def build(self, workflow_id: str, prompt: str, params: dict | None = None,
              seed: int = 42, negative: str | None = None,
              workflow_params: dict | None = None) -> dict | None:
        wf = self.get_workflow(workflow_id)
        if wf is None:
            return None
        return wf.build(prompt, params, seed, negative, workflow_params)

    def build_llm(self, workflow_id: str, user_text: str,
                  prompt_params: dict | None = None,
                  images=None, videos=None, audios=None) -> dict | None:
        wf = self.get_workflow(workflow_id)
        if wf is None or not hasattr(wf, "build_prompt"):
            return None
        return wf.build_prompt(user_text, prompt_params,
                               images=images, videos=videos, audios=audios)
