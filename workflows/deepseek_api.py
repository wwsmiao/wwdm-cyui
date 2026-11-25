"""DeepSeek 官方 API：不走 ComfyUI 图，直接调用 DeepSeek 的 chat 接口。

纯文字模型（deepseek-chat / deepseek-reasoner）不支持素材；带图片需把模型换成
deepseek-flash（vision），最多 10 张图片（JPEG/PNG/GIF/WebP，base64 内联）。
API Key、接口地址、模型在 设置 → 提示词参数 → DeepSeek 官方参数 里配置，
保存在 prompt_params["deepseek-api"]（与其它提示词工作流的参数同一个存储）。
"""


class DeepSeekApiWorkflow:
    """伪工作流：只承担元信息与参数默认值，真正的调用在 core/ai.py 里。"""

    id = "deepseek-api"
    name = "DeepSeek 官方 API"
    description = "纯文字，或最多 10 张图片（需 deepseek-flash 模型） · 需填 API Key"
    kind = "llm"
    provider = "deepseek"
    needs_image = False
    supports_size = False
    supports_batch = False
    max_images = 10
    max_videos = 0
    max_audios = 0

    # 设置页的预填默认值
    default_params = {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
    }

    param_map = {}
    lora = {}

    def limits(self) -> dict:
        return {"images": self.max_images, "videos": self.max_videos, "audios": self.max_audios}

    def list_item(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "node_count": 0,
            "kind": self.kind,
            "needs_image": self.needs_image,
            "supports_size": self.supports_size,
            "supports_batch": self.supports_batch,
            "limits": self.limits(),
        }

    def graph(self) -> dict | None:
        return None

    def node_count(self) -> int:
        return 0


WORKFLOW = DeepSeekApiWorkflow()
