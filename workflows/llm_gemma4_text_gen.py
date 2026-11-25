"""Gemma4 提示词工作流：文字进、文字出，最多 1 图 + 1 视频 + 1 音频。

节点分工（改映射前先看这里）：
  3  CLIPLoader（gemma4_e4b）→ 1 TextGenerate.clip
  2  LoadImage（单图）→ 1.image
  6  LoadVideo（单视频）→ 7 GetVideoComponents → 1.video
  5  LoadAudio（单音频）→ 1.audio
  1  TextGenerate.prompt 直接接收拼接好的文本
  4  PreviewAny → 从 history 里取生成文本

注意：本工作流**最多只能传一张图、一个视频、一个音频**（多选时只取第一个）；
且没有独立的系统提示词输入口，系统提示词会拼接在用户提示词开头一起送入。
"""
from workflows.base import PromptWorkflow, set_value

TEXT_NODE = "1"
IMAGE_NODE = "2"
VIDEO_NODE = "6"
VIDEO_PARTS = "7"
AUDIO_NODE = "5"


class LlmGemma4TextGen(PromptWorkflow):
    id = "llm-gemma4-提示词"
    name = "Gemma4 提示词生成"
    description = "文本生成 · 最多 1 图 + 1 视频 + 1 音频（多选只取第一个）"
    graph_file = "llm-gemma4-提示词.json"
    max_images = 1
    max_videos = 1
    max_audios = 1

    param_map = {
        "temperature": ["1", "inputs", "sampling_mode.temperature"],
        "max_length": ["1", "inputs", "max_length"],
        "seed": ["1", "inputs", "sampling_mode.seed"],
        "thinking": ["1", "inputs", "thinking"],
        "top_p": ["1", "inputs", "sampling_mode.top_p"],
        "top_k": ["1", "inputs", "sampling_mode.top_k"],
        "min_p": ["1", "inputs", "sampling_mode.min_p"],
        "repetition_penalty": ["1", "inputs", "sampling_mode.repetition_penalty"],
        "presence_penalty": ["1", "inputs", "sampling_mode.presence_penalty"],
        "clip": ["3", "inputs", "clip_name"],
    }

    # ---------- 素材槽位（各最多一个） ----------
    def apply_media(self, nodes: dict, images=None, videos=None, audios=None) -> None:
        inputs = nodes[TEXT_NODE]["inputs"]

        image = (images or [None])[0]
        if image:
            nodes[IMAGE_NODE]["inputs"]["image"] = image
            inputs["image"] = [IMAGE_NODE, 0]
        else:
            nodes.pop(IMAGE_NODE, None)
            inputs.pop("image", None)

        video = (videos or [None])[0]
        if video:
            nodes[VIDEO_NODE]["inputs"]["file"] = video
            inputs["video"] = [VIDEO_PARTS, 0]
        else:
            nodes.pop(VIDEO_NODE, None)
            nodes.pop(VIDEO_PARTS, None)
            inputs.pop("video", None)

        audio = (audios or [None])[0]
        if audio:
            nodes[AUDIO_NODE]["inputs"]["audio"] = audio
            inputs["audio"] = [AUDIO_NODE, 0]
        else:
            nodes.pop(AUDIO_NODE, None)
            inputs.pop("audio", None)

    # ---------- 组装 ----------
    def build_prompt(self, user_text: str, prompt_params: dict | None = None,
                     images=None, videos=None, audios=None) -> dict | None:
        graph = self.graph()
        if graph is None:
            return None
        params = dict(prompt_params or {})

        # 本工作流没有 system_prompt 输入口：系统提示词拼在用户提示词开头
        system = str(params.pop("system_prompt", "") or "").strip()
        template = str(params.pop("user_prompt", "") or "").strip()
        if template:
            text = (template.replace("{prompt}", user_text)
                    if "{prompt}" in template else f"{template}\n\n{user_text}")
        else:
            text = user_text
        if system:
            text = f"{system}\n\n{text}"

        nodes = graph
        nodes[TEXT_NODE]["inputs"]["prompt"] = text

        for key, raw in params.items():
            path = self.param_map.get(key)
            if not path or raw is None or raw == "":
                continue
            value = self.coerce_llm(key, raw)
            if value is not None:
                set_value(nodes, path, value)

        self.apply_media(nodes, images, videos, audios)
        return graph


WORKFLOW = LlmGemma4TextGen()
