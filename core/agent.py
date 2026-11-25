"""AI Agent：独立的对话助手服务。

设计上和其他模块解耦：配置单独存在 settings["agent"]，
接口地址只要是 OpenAI 兼容的 /chat/completions + /models 就能用
（DeepSeek、通义、月之暗面、本地 Ollama / LM Studio 都可以）。
"""
import json
import urllib.error
import urllib.request

DEFAULT_AGENT = {
    "enabled": True,
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "",
    "model": "deepseek-chat",
    "temperature": 0.7,
    "system_prompt": "",
    "allow_canvas": True,
}

DEFAULT_SYSTEM_PROMPT = (
    "你是「薇薇」，这个创作台里的 AI 创作搭档兼画布导演。\n\n"

    "【你是谁】\n"
    "- 名字叫薇薇，说话像一起干活的同事：亲切但不腻，专业但不端着，不卖萌也不客套。\n"
    "- 你懂画面语言（构图、光位、镜头、色彩、材质）与 ComfyUI 的机制（工作流、LoRA、采样参数）。\n"
    "- 你能直接操作画布：建提示词节点、建创作节点、连线、挑工作流、配 LoRA 与参数、提交生成、整理布局。\n\n"

    "【审美原则】\n"
    "- 写提示词按「主体 → 动作姿态 → 环境 → 光影 → 镜头 → 材质 → 风格」组织，别堆同义词，别写空话。\n"
    "- 光影优先于形容词：先定光位与明暗关系，再补细节。\n"
    "- 人像默认中近景、浅景深、85mm、柔和自然光、皮肤质感真实；避免过度锐化和塑料感。\n"
    "- 产品静物用干净背景 + 主光/辅光/轮廓光三段式，材质反光要真实。\n"
    "- 构图给具体选择（三分线、中心、留白、视线方向），不要只说「好看」「高级」。\n"
    "- 参数服务于画面：要氛围就降对比、暖色温；要细节就提步数、稳住 CFG。\n\n"

    "【做事风格】\n"
    "- 简洁：默认 3 句内说完，必要信息用短列表；不复述工具名、不贴 JSON、不念过程。\n"
    "- 能一次做完的就做完，不要每一步都来确认；只在该问的时候问。\n"
    "- 顺序：看现场 → 搭结构 → 配资源 → 提交 → 一句话汇报（做了什么、在哪、结果如何）。\n\n"

    "【什么时候必须先问】\n"
    "- 主体或风格毫无线索时；比例、张数、用哪张参考图会明显改变结果而用户没说时；\n"
    "- 要改已有节点/参数但不确定指哪一个时；要删除、覆盖、批量改动时。\n"
    "- 问法：一次只问最关键的 1-2 个问题，同时给出你建议的默认值，用户点头就继续。\n\n"

    "【工具与底线】\n"
    "- 所有 id（工作流、节点、LoRA 文件名）必须来自工具返回，绝不编造；不确定就先查"
    "（get_workspace / get_workflow_params / get_recent_works）。\n"
    "- 比例 / 分辨率 / 张数是节点生成参数：用 params={ratio, resolution, batch}，可选值见 generation_options。\n"
    "- LoRA 有触发词时必须写进提示词，否则风格不生效。\n"
    "- 提交前自检：提示词非空、工作流与节点类型匹配、需要参考图的已连线。\n"
    "- 失败如实说原因并给下一步建议，不要假装成功。"
)

MAX_MESSAGES = 40          # 单次对话最多带回的历史条数
MAX_CHARS = 12000          # 单条消息最多字符数
REQUEST_TIMEOUT = 180


class AgentError(Exception):
    """Agent 调用失败（配置缺失 / 接口报错）。"""


class Agent:
    def __init__(self, settings_store):
        self.store = settings_store

    # ---------- 配置 ----------
    def config(self, with_secret: bool = False) -> dict:
        saved = (self.store.read().get("agent") or {})
        conf = dict(DEFAULT_AGENT)
        for key in DEFAULT_AGENT:
            if key in saved:
                conf[key] = saved[key]
        conf["temperature"] = self._temperature(conf.get("temperature"))
        conf["enabled"] = bool(conf.get("enabled", True))
        conf["allow_canvas"] = bool(conf.get("allow_canvas", True))
        secret = str(conf.get("api_key") or "")
        # 前端要能一眼看出「已经存过」：给一个固定形式的脱敏预览，而不是让输入框里的点变少
        conf["api_key_set"] = bool(secret)
        conf["api_key_hint"] = self._mask_key(secret)
        if not with_secret and secret:
            conf["api_key"] = "******"
        return conf

    @staticmethod
    def _mask_key(key: str) -> str:
        """脱敏预览：sk-••••••••3f9a。长度固定，不会因为密钥长短让点数变化。"""
        key = str(key or "")
        if not key:
            return ""
        if len(key) <= 10:
            return "•" * 10
        head = key[:3] if len(key) > 16 else ""
        return f"{head}••••••••{key[-4:]}"

    def save(self, patch: dict) -> dict:
        """只接受白名单字段；api_key 传 ****** 视为「不修改」。"""
        if not isinstance(patch, dict):
            raise AgentError("配置格式不正确")
        changes = {}
        for key in DEFAULT_AGENT:
            if key not in patch:
                continue
            value = patch[key]
            if key in ("enabled", "allow_canvas"):
                changes[key] = bool(value)
            elif key == "temperature":
                changes[key] = self._temperature(value)
            else:
                changes[key] = str(value or "").strip()
        if changes.get("api_key") == "******":
            changes.pop("api_key")
        changes["base_url"] = (changes.get("base_url") or "").rstrip("/")

        def edit(store):
            current = dict(store.get("agent") or {})
            current.update(changes)
            store["agent"] = {**DEFAULT_AGENT, **current}

        self.store.update(edit)
        return self.config()

    # ---------- 对外能力 ----------
    def models(self, override: dict | None = None) -> list:
        conf = self._require(override)
        url = f"{conf['base_url']}/models"
        request = urllib.request.Request(url, headers=self._headers(conf["api_key"]))
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8", "ignore"))
        except urllib.error.HTTPError as exc:
            raise AgentError(self._http_error(exc, "拉取模型列表"))
        except (OSError, ValueError) as exc:
            raise AgentError(f"连接 {conf['base_url']} 失败：{exc}")
        items = data.get("data") if isinstance(data, dict) else data
        names = []
        for item in items or []:
            if isinstance(item, dict):
                name = item.get("id") or item.get("name")
            else:
                name = str(item)
            if name:
                names.append(str(name))
        return sorted(set(names))

    def chat(self, messages: list, override: dict | None = None,
             tools: list | None = None) -> dict:
        conf = self._require(override)
        msgs = self._clean(messages)
        system = (conf.get("system_prompt") or "").strip() or DEFAULT_SYSTEM_PROMPT
        if not any(m.get("role") == "system" for m in msgs):
            msgs.insert(0, {"role": "system", "content": system})

        body = {
            "model": conf["model"],
            "messages": msgs,
            "temperature": conf["temperature"],
            "stream": False,
        }
        # 工具声明由前端给（工具本体也在前端执行），这里只负责透传给模型
        if isinstance(tools, list) and tools:
            body["tools"] = tools[:24]
            body["tool_choice"] = "auto"
        data = self._post(f"{conf['base_url']}/chat/completions", body, conf["api_key"])
        choices = data.get("choices") or []
        if not choices:
            raise AgentError("模型没有返回内容，请稍后再试")
        message = choices[0].get("message") or {}
        text = (message.get("content") or "").strip()
        calls = []
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            func = call.get("function") or {}
            name = str(func.get("name") or "").strip()
            if not name:
                continue
            calls.append({
                "id": str(call.get("id") or f"call_{len(calls)}"),
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": func.get("arguments") or "{}",
                },
            })
        if not text and not calls:
            raise AgentError("模型返回了空内容")
        usage = data.get("usage") or {}
        return {
            "reply": text,
            "tool_calls": calls,
            "model": data.get("model") or conf["model"],
            "usage": {
                "prompt": usage.get("prompt_tokens"),
                "completion": usage.get("completion_tokens"),
                "total": usage.get("total_tokens"),
            },
        }

    def test(self, override: dict | None = None) -> dict:
        """测试连接：先试 /models，不行再用一次最小对话兜底（有些网关不开放 models）。"""
        conf = self._require(override)
        try:
            names = self.models(override)
            return {"ok": True, "via": "models", "models": names[:60], "count": len(names)}
        except AgentError as exc:
            first_error = str(exc)
        data = self._post(
            f"{conf['base_url']}/chat/completions",
            {"model": conf["model"], "messages": [{"role": "user", "content": "ping"}],
             "max_tokens": 8, "stream": False},
            conf["api_key"],
        )
        return {
            "ok": True, "via": "chat",
            "reply": ((data.get("choices") or [{}])[0].get("message") or {}).get("content", ""),
            "note": f"models 接口不可用（{first_error}），已用对话接口验证通过",
        }

    # ---------- 内部 ----------
    def _require(self, override: dict | None = None) -> dict:
        conf = self.config(with_secret=True)
        # 允许「还没保存就先试一下」：临时覆盖接口地址 / Key / 模型
        for key in ("base_url", "api_key", "model"):
            value = (override or {}).get(key)
            if isinstance(value, str) and value.strip() and value.strip() != "******":
                conf[key] = value.strip().rstrip("/")
        if not conf.get("base_url"):
            raise AgentError("还没配置接口地址，请到 设置 → AI Agent 里填写")
        if not conf.get("api_key"):
            raise AgentError("还没填 API Key，请到 设置 → AI Agent 里填写")
        if not conf.get("model"):
            raise AgentError("还没选模型，请到 设置 → AI Agent 里选择或手填")
        return conf

    @staticmethod
    def _headers(api_key: str) -> dict:
        return {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    def _post(self, url: str, body: dict, api_key: str) -> dict:
        request = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST", headers=self._headers(api_key),
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8", "ignore"))
        except urllib.error.HTTPError as exc:
            raise AgentError(self._http_error(exc, "对话接口"))
        except (OSError, ValueError) as exc:
            raise AgentError(f"请求失败：{exc}")

    @staticmethod
    def _http_error(exc: urllib.error.HTTPError, where: str) -> str:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8", "ignore"))
            detail = str((payload.get("error") or {}).get("message") or payload)[:220]
        except Exception:
            detail = str(exc.reason or "")
        hint = {401: "（API Key 无效）", 402: "（余额不足）", 403: "（无权访问该模型）",
                404: "（接口地址或模型名不对）", 429: "（请求太频繁）"}.get(exc.code, "")
        return f"{where}返回 {exc.code}{hint}：{detail}"

    @staticmethod
    def _temperature(value) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return DEFAULT_AGENT["temperature"]
        return max(0.0, min(2.0, round(number, 2)))

    @staticmethod
    def _clean(messages) -> list:
        if not isinstance(messages, list):
            raise AgentError("消息格式不正确")
        cleaned = []
        for item in messages[-MAX_MESSAGES:]:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            # tool 是本项目 Agent 的多轮工具结果回传
            if role not in ("user", "assistant", "system", "tool"):
                continue
            if role == "tool":
                cleaned.append({
                    "role": "tool",
                    "tool_call_id": str(item.get("tool_call_id") or ""),
                    "content": str(item.get("content") or "")[:MAX_CHARS],
                })
                continue
            calls = item.get("tool_calls")
            if role == "assistant" and isinstance(calls, list) and calls:
                cleaned.append({
                    "role": "assistant",
                    "content": str(item.get("content") or ""),
                    "tool_calls": [c for c in calls[:6] if isinstance(c, dict)][:6],
                })
                continue
            content = item.get("content")
            if isinstance(content, str):
                text = content.strip()[:MAX_CHARS]
                if not text:
                    continue
                cleaned.append({"role": role, "content": text})
            elif isinstance(content, list):
                # 兼容 OpenAI vision 结构：文本 + 图片 data url
                parts = []
                for part in content[:8]:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        parts.append({"type": "text", "text": str(part.get("text") or "")[:MAX_CHARS]})
                    elif part.get("type") == "image_url":
                        url = str(((part.get("image_url") or {}).get("url")) or "")
                        if url.startswith("data:image/"):
                            parts.append({"type": "image_url", "image_url": {"url": url}})
                if parts:
                    cleaned.append({"role": role, "content": parts})
        if not any(item["role"] == "user" for item in cleaned):
            raise AgentError("没有可发送的消息")
        return cleaned
