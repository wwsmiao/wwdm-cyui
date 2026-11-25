"""全局配置：所有路径与默认值集中在这里，其他模块只从这里取值。"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = STATIC_DIR / "outputs"
# 每个项目的输出目录：data/<项目名>_opt（旧作品仍在 static/outputs 下，读取时兼容两种地址）
PROJECT_OUTPUT_SUFFIX = "_opt"
_INVALID_FOLDER = '<>:"/\\|?*'


def project_folder_name(name: str) -> str:
    """项目名 → 安全的文件夹名：去掉非法字符，空名回退 Untitled。"""
    clean = "".join(ch for ch in str(name or "") if ch not in _INVALID_FOLDER and ord(ch) >= 32)
    clean = clean.strip().strip(".") or "Untitled"
    return f"{clean[:60]}{PROJECT_OUTPUT_SUFFIX}"


def project_output_dir(name: str) -> Path:
    return DATA_DIR / project_folder_name(name)
WORKFLOW_DIR = BASE_DIR / "workflows"

PROJECTS_FILE = DATA_DIR / "projects.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_COMFY_URL = "http://127.0.0.1:8188"

# 提示词功能：四种用法，各自绑定一个模版
PROMPT_FUNCTIONS = {
    "polish": "提示词润色",
    "reverse": "单图反推",
    "edit": "图片编辑润色",
    "minimax": "minimax-h3提示词润色",
}

DEFAULT_PROMPT_TEMPLATES = [
    {
        "id": "tpl_polish",
        "name": "通用提示词润色",
        "builtin": True,
        "system": "你是资深 AI 绘画提示词工程师。你只输出改写后的中文提示词，不解释、不寒暄、不加标题。",
        "user": "把下面的描述改写成画面感强的中文提示词，按「主体、动作、环境、构图、光线与色调、风格、画质」组织成一段连贯文字，只输出结果：\n{prompt}",
    },
    {
        "id": "tpl_reverse",
        "name": "单图反推提示词",
        "builtin": True,
        "system": "你是图像解析与提示词反推助手。你只输出中文提示词本体，不描述分析过程。",
        "user": "仔细观察这张图片，反推出一段可直接用于文生图的中文提示词，覆盖主体特征、动作神态、服装配饰、环境背景、构图机位、光线与色调、画面风格与画质，只输出结果：\n{prompt}",
    },
    {
        "id": "tpl_edit",
        "name": "图片编辑指令",
        "builtin": True,
        "system": "你是图像编辑指令专家。你只输出可执行的编辑指令，保持原有主体与风格一致。",
        "user": "参考这些图片，把下面的编辑需求改写成明确的中文编辑指令：说明要改什么、改成什么、哪些部分必须保持不变，只输出结果：\n{prompt}",
    },
    {
        "id": "tpl_minimax",
        "name": "MiniMax H3 视频提示词",
        "builtin": True,
        "system": "你是 AI 视频提示词助手，擅长为图生视频模型写镜头脚本。你只输出提示词本体。",
        "user": "结合给定的图片、视频与音频素材，写一段适合 MiniMax H3 图生视频的中文提示词：交代主体与场景、镜头运动、动作节奏、光线氛围与音效提示，一段话写完，只输出结果：\n{prompt}",
    },
]

DEFAULT_PROMPT_FUNCTION_TEMPLATES = {
    "polish": "tpl_polish",
    "reverse": "tpl_reverse",
    "edit": "tpl_edit",
    "minimax": "tpl_minimax",
}

DEFAULT_SETTINGS = {
    "comfy_url": DEFAULT_COMFY_URL,
    "comfy_dir": "",
    "client_id": "wwdm-comfy-proxy",
    "task_timeout": 1800,
    "poll_interval": 1.0,
    "ai_api_url": "",
    "ai_api_key": "",
    "ai_model": "",
    # AI Agent：独立的对话助手配置（设置 → AI Agent 里维护）
    "agent": {
        "enabled": True,
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "model": "deepseek-chat",
        "temperature": 0.7,
        "system_prompt": "",
    },
    "workflow_params": {},
    "prompt_workflow": "llm-qwen3vl-提示词",
    "prompt_params": {},
    "prompt_templates": DEFAULT_PROMPT_TEMPLATES,
    "prompt_function_templates": DEFAULT_PROMPT_FUNCTION_TEMPLATES,
}

ASPECT_RATIOS = {
    "1:1": (1, 1),
    "16:9": (16, 9),
    "9:16": (9, 16),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "3:2": (3, 2),
    "2:3": (2, 3),
    "21:9": (21, 9),
    "9:21": (9, 21),
}
RESOLUTIONS = {"1k": 1024, "1.5k": 1536, "2k": 2048}
BATCH_OPTIONS = (1, 2, 4)

DEFAULT_PARAMS = {
    "ratio": "1:1",
    "resolution": "1k",
    "batch": 1,
    "custom": False,
    "custom_width": 1024,
    "custom_height": 1024,
}


def ensure_dirs() -> None:
    for directory in (DATA_DIR, OUTPUT_DIR, WORKFLOW_DIR, WORKFLOW_DIR / "graphs"):
        directory.mkdir(parents=True, exist_ok=True)
