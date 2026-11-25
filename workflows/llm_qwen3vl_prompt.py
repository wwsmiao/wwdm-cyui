"""Qwen3-VL 提示词工作流：文字进、文字出，可带图片 / 视频 / 音频素材。

节点分工（改映射前先看这里）：
  5  CLIPLoader（qwen3vl_4b）→ 10 TextGenerateV2.clip
  12 PrimitiveStringMultiline 系统提示词 → 10.system_prompt
  13 PrimitiveStringMultiline 用户提示词 → 10.prompt
  10 的可变输入：images.image1~5 → 8/16/17/18/19 LoadImage
                  videos.video1~3 → 25/27/29 GetVideoComponents ← 24/26/28 LoadVideo
                  audios.audio1~3 → 21/22/23 LoadAudio
  7  PreviewAny → 从 history 里取生成文本

没传的素材槽位会连同节点一起从图里摘掉，所以「只传文字」也是干净的图。
"""
from workflows.base import PromptWorkflow, set_value

TEXT_NODE = "10"
SYSTEM_NODE = "12"
USER_NODE = "13"

IMAGE_SLOTS = ["8", "16", "17", "18", "19"]
# (LoadVideo 节点, GetVideoComponents 节点)
VIDEO_SLOTS = [("24", "25"), ("26", "27"), ("28", "29")]
AUDIO_SLOTS = ["21", "22", "23"]


class LlmQwen3VlPrompt(PromptWorkflow):
    id = "llm-qwen3vl-提示词"
    name = "Qwen3-VL 提示词生成"
    description = "文本生成 · 最多 5 图 + 3 视频 + 3 音频"
    graph_file = "llm-qwen3vl-提示词.json"
    max_images = 5
    max_videos = 3
    max_audios = 3

    param_map = {
        "temperature": ["10", "inputs", "sampling_mode.temperature"],
        "max_length": ["10", "inputs", "max_length"],
        "seed": ["10", "inputs", "sampling_mode.seed"],
        "thinking": ["10", "inputs", "thinking"],
        "top_p": ["10", "inputs", "sampling_mode.top_p"],
        "top_k": ["10", "inputs", "sampling_mode.top_k"],
        "min_p": ["10", "inputs", "sampling_mode.min_p"],
        "repetition_penalty": ["10", "inputs", "sampling_mode.repetition_penalty"],
        "presence_penalty": ["10", "inputs", "sampling_mode.presence_penalty"],
        "system_prompt": [SYSTEM_NODE, "inputs", "value"],
        "user_prompt": [USER_NODE, "inputs", "value"],
        "clip": ["5", "inputs", "clip_name"],
    }

    # ---------- 素材槽位 ----------
    @staticmethod
    def _drop(nodes: dict, node_id: str, key: str) -> None:
        nodes.pop(node_id, None)
        nodes[TEXT_NODE]["inputs"].pop(key, None)

    def apply_media(self, nodes: dict, images=None, videos=None, audios=None) -> None:
        inputs = nodes[TEXT_NODE]["inputs"]

        for index, node_id in enumerate(IMAGE_SLOTS, 1):
            key = f"images.image{index}"
            if index <= len(images or []):
                nodes[node_id]["inputs"]["image"] = images[index - 1]
                inputs[key] = [node_id, 0]
            else:
                self._drop(nodes, node_id, key)

        for index, (loader, parts) in enumerate(VIDEO_SLOTS, 1):
            key = f"videos.video{index}"
            if index <= len(videos or []):
                nodes[loader]["inputs"]["file"] = videos[index - 1]
                inputs[key] = [parts, 0]
            else:
                self._drop(nodes, loader, key)
                nodes.pop(parts, None)

        for index, node_id in enumerate(AUDIO_SLOTS, 1):
            key = f"audios.audio{index}"
            if index <= len(audios or []):
                nodes[node_id]["inputs"]["audio"] = audios[index - 1]
                inputs[key] = [node_id, 0]
            else:
                self._drop(nodes, node_id, key)

    # ---------- 组装 ----------
    def build_prompt(self, user_text: str, prompt_params: dict | None = None,
                     images=None, videos=None, audios=None) -> dict | None:
        graph = self.graph()
        if graph is None:
            return None
        params = dict(prompt_params or {})

        system = str(params.pop("system_prompt", "") or "").strip()
        template = str(params.pop("user_prompt", "") or "").strip()
        if template:
            text = (template.replace("{prompt}", user_text)
                    if "{prompt}" in template else f"{template}\n\n{user_text}")
        else:
            text = user_text

        nodes = graph
        nodes[SYSTEM_NODE]["inputs"]["value"] = system
        nodes[USER_NODE]["inputs"]["value"] = text
        # 只有走模型自带的 chat template，系统提示词才会生效
        nodes[TEXT_NODE]["inputs"]["use_default_template"] = True

        for key, raw in params.items():
            path = self.param_map.get(key)
            if not path or raw is None or raw == "":
                continue
            value = self.coerce_llm(key, raw)
            if value is not None:
                set_value(nodes, path, value)

        self.apply_media(nodes, images, videos, audios)
        return graph


WORKFLOW = LlmQwen3VlPrompt()
