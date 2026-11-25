"""提示词助手：按工作流走两条通路——ComfyUI 文本工作流，或 DeepSeek 官方 API。

四种功能：
  polish  提示词润色     —— 输入框文字 + 模版（系统/用户提示词）
  reverse 单图反推       —— 一张图片 + 输入框文字 + 模版
  edit    图片编辑润色   —— 全部图片（按顺序）+ 输入框文字 + 模版
  minimax minimax-h3     —— 全部图片 / 视频 / 音频（按顺序）+ 输入框文字 + 模版

DeepSeek 官方 API：纯文字，或最多 10 张图片（vision 模型 deepseek-flash，base64 内联）；
视频 / 音频素材不支持。图片按功能规则传入：润色不带图、反推第一张、编辑/minimax 全部。
"""
import base64
import json
import time
import urllib.error
import urllib.request

from config import (DEFAULT_PROMPT_FUNCTION_TEMPLATES, DEFAULT_PROMPT_TEMPLATES,
                    PROMPT_FUNCTIONS)
from core.comfy import ComfyError

DEFAULT_PROMPT_TIMEOUT = 300
FUNCTION_KEYS = ("polish", "reverse", "edit", "minimax")
MAX_DEEPSEEK_IMAGES = 10
DEEPSEEK_BODY_LIMIT = 48 * 1024 * 1024      # 请求体 48 MiB
DEEPSEEK_IMAGE_LIMIT = 32 * 1024 * 1024     # 单张（base64 前）32 MiB


class Assistant:
    def __init__(self, settings_getter, workflows=None, comfy=None, tasks=None, files=None):
        self.settings = settings_getter
        self.workflows = workflows
        self.comfy = comfy
        self.tasks = tasks
        self.files = files

    # ---------- 模版 ----------
    def templates(self) -> list:
        """设置里的模版；没有任何模版时退回内置的几套。"""
        saved = (self.settings().get("prompt_templates") or [])
        result = []
        for item in saved:
            if not isinstance(item, dict):
                continue
            result.append({
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or "未命名模版"),
                "system": str(item.get("system") or ""),
                "user": str(item.get("user") or ""),
                "builtin": bool(item.get("builtin")),
            })
        if not result:
            result = [dict(item) for item in DEFAULT_PROMPT_TEMPLATES]
        return result

    def template_for(self, function: str, template_id: str = "") -> dict:
        templates = self.templates()
        wanted = (template_id or "").strip()
        if not wanted:
            bindings = self.settings().get("prompt_function_templates") or {}
            wanted = str(bindings.get(function) or "").strip()
            if not wanted:
                wanted = DEFAULT_PROMPT_FUNCTION_TEMPLATES.get(function, "")
        for item in templates:
            if item["id"] == wanted:
                return item
        return templates[0] if templates else {"id": "", "name": "默认", "system": "", "user": ""}

    # ---------- 工作流 ----------
    def workflow_id(self, preferred: str = "") -> str:
        cfg = self.settings()
        configured = (preferred or (cfg.get("prompt_workflow") or "")).strip()
        if configured and self.workflows and self.workflows.get(configured):
            return configured
        if not self.workflows:
            return ""
        for item in self.workflows.list():
            if item.get("kind") == "llm":
                return item["id"]
        return ""

    def _split_assets(self, function: str, assets: list) -> dict:
        """按功能决定哪些素材真正送进模型，图片/视频/音频各自保持用户选择顺序。"""
        images = [a["name"] for a in assets if a.get("kind") == "image" and a.get("name")]
        videos = [a["name"] for a in assets if a.get("kind") == "video" and a.get("name")]
        audios = [a["name"] for a in assets if a.get("kind") == "audio" and a.get("name")]
        if function == "polish":
            return {"images": [], "videos": [], "audios": []}
        if function == "reverse":
            return {"images": images[:1], "videos": [], "audios": []}
        if function == "edit":
            return {"images": images, "videos": [], "audios": []}
        # minimax：三类都带上
        return {"images": images, "videos": videos, "audios": audios}

    # ---------- 对外 ----------
    def polish(self, prompt: str, strict: bool = False) -> str:
        """兼容旧接口：等价于「提示词润色」。"""
        return self.run("polish", prompt, [], strict=strict)["prompt"]

    def run(self, function: str, text: str, assets: list | None = None,
            template_id: str = "", workflow_id: str = "",
            strict: bool = True) -> dict:
        function = function if function in FUNCTION_KEYS else "polish"
        user_text = (text or "").strip()
        assets = [a for a in (assets or []) if isinstance(a, dict) and a.get("name")]
        media = self._split_assets(function, assets)

        if not user_text and not any(media.values()):
            raise ComfyError("请先输入提示词或选择素材")

        if not self.workflows or not self.comfy:
            raise ComfyError("提示词服务未就绪")
        resolved_id = self.workflow_id(workflow_id)
        if not resolved_id:
            raise ComfyError("没有可用的提示词工作流，请检查 workflows/ 下的 LLM 工作流")
        workflow = self.workflows.get_workflow(resolved_id)
        if workflow is None:
            raise ComfyError(f"找不到提示词工作流：{resolved_id}")

        template = self.template_for(function, template_id)
        cfg = self.settings()
        params = dict((cfg.get("prompt_params") or {}).get(resolved_id, {}))
        params["system_prompt"] = template.get("system", "")
        params["user_prompt"] = template.get("user", "")

        timeout = min(int(cfg.get("task_timeout") or 1800), DEFAULT_PROMPT_TIMEOUT)
        label = PROMPT_FUNCTIONS.get(function, "提示词生成")
        provider = getattr(workflow, "provider", "comfyui")
        job = self.tasks.begin_job(
            f"DeepSeek · {label}" if provider == "deepseek" else label
        ) if self.tasks else None
        error_text = ""
        try:
            if provider == "deepseek":
                if not user_text:
                    raise ComfyError("请先在输入框写下描述（DeepSeek 需要文字指令）")
                generated = self._call_deepseek(resolved_id, user_text, template,
                                                params, media["images"])
                cleaned = self._clean(generated)
                if not cleaned:
                    raise ComfyError("DeepSeek 没有返回内容")
            else:
                graph = self.workflows.build_llm(resolved_id, user_text, params,
                                                 images=media["images"],
                                                 videos=media["videos"],
                                                 audios=media["audios"])
                if graph is None:
                    raise ComfyError(f"找不到提示词工作流：{resolved_id}")
                prompt_id = self.comfy.submit(graph)
                if job:
                    self.tasks.attach_job(job["id"], prompt_id)
                generated = self._wait_text(prompt_id, timeout)
                cleaned = self._clean(generated)
                if not cleaned:
                    raise ComfyError("提示词工作流没有返回内容")
        except ComfyError as exc:
            error_text = str(exc)
            raise
        finally:
            if job:
                self.tasks.finish_job(job["id"], error_text)

        return {
            "prompt": cleaned,
            "raw": generated,
            "function": function,
            "template": {"id": template.get("id", ""), "name": template.get("name", "")},
            "workflow": resolved_id,
            "provider": provider,
            "assets": media,
        }

    # ---------- 内部 ----------
    @staticmethod
    def _image_mime(data: bytes) -> str:
        """按文件内容判断 MIME（DeepSeek 也是按内容识别格式）。"""
        if data.startswith(b"\x89PNG"):
            return "image/png"
        if data.startswith(b"GIF8"):
            return "image/gif"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        return "image/jpeg"

    def _call_deepseek(self, workflow_id: str, user_text: str,
                       template: dict, params: dict, images: list | None = None) -> str:
        """调用 DeepSeek 官方 chat 接口（OpenAI 兼容格式），返回生成文本。

        images 是 ComfyUI input 里的文件名列表；带图时 content 变成
        「文本块 + image_url(base64)」的数组，模型需为 deepseek-flash（vision）。
        """
        cfg = params  # prompt_params["deepseek-api"] 就是它的配置
        api_key = str(cfg.get("api_key") or "").strip()
        base = (str(cfg.get("base_url") or "https://api.deepseek.com")
                .strip().rstrip("/"))
        model = str(cfg.get("model") or "deepseek-chat").strip()
        if not api_key:
            raise ComfyError("还没有填写 DeepSeek API Key，请到 设置 → 提示词参数 → DeepSeek 官方参数 配置")

        messages = []
        system = (template.get("system") or "").strip()
        if system:
            messages.append({"role": "system", "content": system})

        body_size = 0
        if images:
            if "flash" not in model:
                raise ComfyError(
                    f"模型 {model} 不支持图片输入，请到 设置 → 提示词参数 → "
                    f"DeepSeek 官方参数 把模型换成 deepseek-flash（vision）")
            content = []
            if user_text:
                content.append({"type": "text", "text": user_text})
            for name in images:
                try:
                    data = self.files.read_bytes("input", name)
                except ComfyError as exc:
                    raise ComfyError(f"读取图片 {name} 失败：{exc}")
                if len(data) > DEEPSEEK_IMAGE_LIMIT:
                    raise ComfyError(f"图片 {name} 超过 32 MiB，DeepSeek 单图上限（base64 内联）")
                body_size += len(data) * 4 // 3 + 200
                b64 = base64.b64encode(data).decode("ascii")
                mime = self._image_mime(data)
                content.append({"type": "image_url",
                                "image_url": {"url": f"data:{mime};base64,{b64}"}})
            if body_size > DEEPSEEK_BODY_LIMIT:
                raise ComfyError("图片总大小超过 DeepSeek 请求体上限（48 MiB），请减少张数或压缩图片")
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_text})

        body = {"model": model, "messages": messages, "stream": False}
        try:
            temperature = float(cfg.get("temperature"))
            body["temperature"] = temperature
        except (TypeError, ValueError):
            pass
        try:
            body["max_tokens"] = int(float(cfg.get("max_length")))
        except (TypeError, ValueError):
            pass

        request = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                data = json.loads(response.read().decode("utf-8", "ignore"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                payload = json.loads(exc.read().decode("utf-8", "ignore"))
                detail = str((payload.get("error") or {}).get("message") or payload)[:200]
            except Exception:
                detail = exc.reason or ""
            hint = {401: "（API Key 无效或未填写）", 402: "（余额不足）",
                    422: "（参数不正确，图片请搭配 deepseek-flash）",
                    429: "（请求过于频繁）"}.get(exc.code, "")
            raise ComfyError(f"DeepSeek 接口返回 {exc.code}{hint}：{detail}")
        except (OSError, ValueError) as exc:
            raise ComfyError(f"连接 DeepSeek 失败：{exc}")

        choices = data.get("choices") or []
        text = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
        if not text:
            raise ComfyError("DeepSeek 没有返回内容")
        return text

    def _wait_text(self, prompt_id: str, timeout: int) -> str:
        deadline = time.time() + timeout
        interval = max(0.5, float(self.settings().get("poll_interval", 1.0)))
        while time.time() < deadline:
            entry = self.comfy.history(prompt_id).get(prompt_id, {})
            text = self._text_of(entry.get("outputs") or {})
            if text:
                return text
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise ComfyError("提示词工作流执行出错，请查看 ComfyUI 控制台")
            if status.get("completed"):
                raise ComfyError("提示词工作流已结束但没有文本输出")
            time.sleep(interval)
        raise ComfyError(f"提示词工作流等待超时（{timeout} 秒）")

    @staticmethod
    def _text_of(outputs: dict) -> str:
        """从 PreviewAny 之类的输出节点里取出纯文本。"""
        for node_output in outputs.values():
            value = node_output.get("text")
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str) and item.strip():
                        return item
        return ""

    @staticmethod
    def _clean(text: str) -> str:
        """去掉引号、代码块与「提示词：」之类的前缀，只留提示词本体。"""
        value = (text or "").strip()
        if value.startswith("```"):
            value = value.strip("`").strip()
            value = value.split("\n", 1)[-1] if value.lower().startswith("text") else value
        for prefix in ("提示词：", "提示词:", "优化后：", "优化后:", "Prompt:", "prompt:"):
            if value.startswith(prefix):
                value = value[len(prefix):].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'“”‘’":
            value = value[1:-1].strip()
        return value
