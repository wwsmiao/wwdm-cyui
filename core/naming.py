"""作品文件名：时间戳 + 提示词摘要，避免所有输出都堆成 1.png / 2.png。

作品真正的唯一标识是任务 ID（在文件夹和 URL 里），文件名只负责「看得懂、分得开」：
  · 同一个任务的多张图：序号 _01 _02 区分
  · 不同任务同一个提示词：时间戳区分
  · 提示词里的 Windows 非法字符（\\ / : * ? " < > |）统一换成空格
"""
import re
import time

BAD_CHARS = re.compile(r'[\\/:*?"<>|#%\x00-\x1f]+')
SPACES = re.compile(r"\s+")
RESERVED = {"CON", "PRN", "AUX", "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}


def safe_stem(text: str, limit: int = 24) -> str:
    """把一段文字揉成能当文件名的短摘要；全是不合法字符时返回空串。"""
    stem = BAD_CHARS.sub(" ", str(text or ""))
    stem = SPACES.sub(" ", stem).strip(" ._-#")
    if not stem:
        return ""
    stem = stem[:limit].strip(" ._-#")
    return "" if stem.upper() in RESERVED else stem


def stamp_of(created_at: float | None = None) -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime(created_at or time.time()))


def output_name(prompt: str, index: int = 0, total: int = 1,
                suffix: str = ".png", created_at: float | None = None) -> str:
    """作品落盘文件名，例：20261122-080124_改白色连衣裙_01.png"""
    stem = safe_stem(prompt) or "作品"
    serial = f"_{index + 1:02d}" if total > 1 else ""
    ext = suffix if str(suffix).startswith(".") else f".{suffix}"
    return f"{stamp_of(created_at)}_{stem}{serial}{ext or '.png'}"


def is_generic(name: str) -> bool:
    """1.png / 12.jpeg 这种纯序号文件名：说明它来自旧版本，展示时最好换成人能认的标题。"""
    return bool(re.fullmatch(r"\d+\.[A-Za-z0-9]{2,5}", str(name or "").strip()))
