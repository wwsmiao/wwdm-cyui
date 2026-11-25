"""ComfyUI HTTP API 代理客户端：所有请求都从后端转发，前端不直连 ComfyUI。"""
import time

import requests

from core.models import (MODEL_FIELDS, REQUIRED_KINDS, combo_options, explain,
                         resolve)


class ComfyError(Exception):
    pass


class ComfyClient:
    def __init__(self, url_getter, client_id_getter):
        self._url_getter = url_getter
        self._client_getter = client_id_getter
        # /object_info 的模型清单很大（远端几百个文件），缓存一下别每次开关设置都重拉
        self._object_cache = {}
        # 每次提交时打印一次「模型名被换掉」的记录，方便排查远程实例差异
        self.last_adaptations = []

    @property
    def base(self) -> str:
        return self._url_getter().rstrip("/")

    @property
    def client_id(self) -> str:
        return self._client_getter()

    def request(self, method: str, endpoint: str, timeout: int = 15, **kwargs):
        try:
            response = requests.request(
                method, self.base + endpoint, timeout=timeout, **kwargs
            )
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            raise ComfyError(f"ComfyUI 连接失败（{self.base}）：{exc}") from exc

    def object_info(self, node: str, timeout: int = 20) -> dict:
        """带缓存的 /object_info：换远程实例后模型清单拉一次要好几秒。"""
        now = time.time()
        cache_key = (self.base, node)
        cached = self._object_cache.get(cache_key)
        if cached and now - cached[0] < 90:
            return cached[1]
        data = self.request("GET", f"/object_info/{node}", timeout=timeout).json()
        if len(self._object_cache) > 40:
            self._object_cache.clear()
        self._object_cache[cache_key] = (now, data)
        return data

    # ---------- 模型名适配 ----------
    def combo_of(self, node: str, field: str) -> list:
        """某个节点某个输入的可选值（下拉清单）；拿不到就返回空。"""
        try:
            info = self.object_info(node, timeout=20)
        except ComfyError:
            return []
        inputs = (info.get(node) or {}).get("input") or {}
        spec = (inputs.get("required") or {}).get(field)
        if spec is None:
            spec = (inputs.get("optional") or {}).get(field)
        return combo_options(spec)

    def options_for_kind(self, kind: str) -> list:
        from core.models import KIND_SOURCES
        source = KIND_SOURCES.get(kind)
        if not source:
            return []
        return self.combo_of(source[0], source[1])

    def prepare_graph(self, graph: dict) -> dict:
        """提交前把图里的模型名对齐到当前实例：换远程实例后不用改工作流文件。

        · LoRA 找不到同名/同系列 → 从图里摘掉（下游 model 直连上游），任务不因此失败
        · 底模 / CLIP / VAE 找不到 → 直接报错，绝不悄悄换成别的模型
        """
        if not isinstance(graph, dict):
            return graph
        nodes = graph["nodes"] if isinstance(graph.get("nodes"), dict) else graph
        drop = []
        self.last_adaptations = []
        for node_id, node in list(nodes.items()):
            if not isinstance(node, dict):
                continue
            cls = node.get("class_type") or ""
            inputs = node.get("inputs") or {}
            for field, value in list(inputs.items()):
                kind = MODEL_FIELDS.get(field)
                if not kind or not isinstance(value, str) or not value:
                    continue
                options = self.combo_of(cls, field)
                if not options:
                    # 节点本身不在这个实例里（另有可用性检查会拦），这里不拦
                    continue
                fixed = resolve(kind, value, options)
                if fixed == value:
                    continue
                if fixed:
                    inputs[field] = fixed
                    self.last_adaptations.append(f"{value} → {fixed}")
                    continue
                if kind == "lora":
                    drop.append(node_id)
                elif kind in REQUIRED_KINDS:
                    raise ComfyError(explain(kind, value, options) +
                                     "。到「设置 → 图片参数 / 视频参数」里重新选一个当前实例有的模型。")
        for node_id in dict.fromkeys(drop):
            node = nodes.pop(node_id, None)
            if not isinstance(node, dict):
                continue
            upstream = (node.get("inputs") or {}).get("model")
            if not upstream:
                continue
            for other in nodes.values():
                for field, value in (other.get("inputs") or {}).items():
                    if isinstance(value, list) and len(value) == 2 and value[0] == node_id:
                        other["inputs"][field] = upstream
            self.last_adaptations.append(f"摘掉当前实例没有的 LoRA 节点 {node_id}")
        # 模型名自动对齐属于内部细节，不打印；对不上的会在提交时报错里写清楚
        return graph

    def status(self) -> dict:
        stats = self.request("GET", "/system_stats").json()
        queue = self.request("GET", "/queue").json()
        return {
            "system": stats.get("system", {}),
            "devices": stats.get("devices", []),
            "running": len(queue.get("queue_running", [])),
            "pending": len(queue.get("queue_pending", [])),
        }

    def queue_ids(self) -> set:
        """还在跑的 / 排队的 prompt_id 集合（远程实例排队可能很久，找回时要看这个）。"""
        queue = self.request("GET", "/queue").json()
        ids = set()
        for group in (queue.get("queue_running") or [], queue.get("queue_pending") or []):
            for item in group:
                if isinstance(item, dict) and item.get("prompt_id"):
                    ids.add(item["prompt_id"])
                elif isinstance(item, (list, tuple)) and len(item) > 1:
                    ids.add(item[1])
        return ids

    def submit(self, graph: dict) -> str:
        graph = self.prepare_graph(graph)
        payload = {"prompt": graph, "client_id": self.client_id}
        try:
            response = requests.post(self.base + "/prompt", json=payload, timeout=30)
        except requests.RequestException as exc:
            raise ComfyError(f"ComfyUI 连接失败（{self.base}）：{exc}") from exc
        if response.status_code >= 400:
            # ComfyUI 的 400 里带着具体哪个节点哪个字段不合法，别只丢一句 Bad Request
            raise ComfyError(self.validation_message(response))
        try:
            data = response.json()
        except ValueError as exc:
            raise ComfyError(f"ComfyUI 返回的内容不是 JSON：{response.text[:200]}") from exc
        if data.get("node_errors"):
            raise ComfyError(f"工作流节点错误：{data['node_errors']}")
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"提交失败：{data}")
        return prompt_id

    @staticmethod
    def validation_message(response) -> str:
        """把 ComfyUI 的 prompt 校验错误翻译成一句人话（模型不在列表用最常见）。"""
        try:
            data = response.json()
        except ValueError:
            return f"提交被 ComfyUI 拒绝（{response.status_code}）：{response.text[:200]}"
        problems = []
        hints = []
        for node_id, info in (data.get("node_errors") or {}).items():
            cls = info.get("class_type") or f"节点 {node_id}"
            for err in info.get("errors") or []:
                extra = err.get("extra_info") or {}
                field = extra.get("input_name") or ""
                value = extra.get("received_value")
                detail = str(err.get("details") or err.get("message") or "")
                if err.get("type") == "value_not_in_list" and field:
                    problems.append(f"{cls}.{field} 的「{value}」不在当前实例的可选列表里")
                    if "模型文件" not in hints:
                        hints.append("模型文件")
                elif err.get("type") == "required_input_missing":
                    problems.append(f"{cls} 缺少必填输入 {field or '（未指明）'}")
                elif "invalid image" in detail.lower() or "invalid video" in detail.lower():
                    problems.append(f"{cls}：{detail}")
                    if "素材" not in hints:
                        hints.append("素材")
                else:
                    problems.append(f"{cls}：{detail or '校验失败'}")
        if problems:
            more = "…" if len(problems) > 6 else ""
            text = "工作流校验没通过：" + "；".join(problems[:6]) + more + "。"
            if "模型文件" in hints:
                text += ("常见原因是当前 ComfyUI 没有工作流里写的模型文件（换过实例后文件名往往对不上）；"
                         "到「设置 → 图片参数 / 视频参数」里，从模型下拉框重新选当前实例里有的模型。")
            if "素材" in hints:
                text += ("参考图 / 参考视频在 ComfyUI 的 input 目录里找不到（可能被清理了），"
                         "重新选一张或重新上传再提交。")
            return text
        message = (data.get("error") or {}).get("message") or "校验失败"
        return f"提交被 ComfyUI 拒绝：{message}"

    def history(self, prompt_id: str, timeout: int = 30) -> dict:
        return self.request("GET", f"/history/{prompt_id}", timeout=timeout).json()

    def view_url(self, image: dict) -> str:
        from urllib.parse import urlencode
        query = urlencode({
            "filename": image.get("filename", ""),
            "subfolder": image.get("subfolder", ""),
            "type": image.get("type", "output"),
        })
        return f"{self.base}/view?{query}"

    def view_bytes(self, image: dict) -> bytes:
        # 长视频的 /view 下载可能远超一分钟，放宽到 10 分钟
        return self.request("GET", self.view_url(image).replace(self.base, ""),
                            timeout=600).content

    def interrupt(self) -> bool:
        self.request("POST", "/interrupt", timeout=10)
        return True
