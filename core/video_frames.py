"""视频尾帧提取：取视频最后一帧，存成一张新的图片作品。

独立实现，不经过 ComfyUI，也不依赖任何工作流 —— 调用本机 ffmpeg 解一帧即可。
卡片模式和画布模式共用同一个接口：

    POST /api/video/last-frame  {url, project_id}
    → {ok, task}    task 是新建的图片作品（和正常生图一样有卡片、能下载、能继续加工）
"""
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import quote, unquote

from PIL import Image

from config import DATA_DIR, OUTPUT_DIR
from core.naming import output_name


class VideoFrameError(Exception):
    pass


# 常见 ffmpeg 位置：环境变量 → 之前装机留下的目录 → PATH
_FFMPEG_CANDIDATES = (
    os.environ.get("FFMPEG_BIN", ""),
    r"D:/ffmpeg-master-latest-win64-gpl-shared/bin/ffmpeg.exe",
    r"C:/ffmpeg/bin/ffmpeg.exe",
    r"C:/Program Files/ffmpeg/bin/ffmpeg.exe",
)


def _ffmpeg() -> str:
    for candidate in _FFMPEG_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise VideoFrameError("找不到 ffmpeg：请把 ffmpeg 放到 PATH，或用环境变量 FFMPEG_BIN 指定路径")


def _ffprobe(ffmpeg: str) -> str:
    """同目录的 ffprobe；没有就返回空，后面用 sseof 兜底。"""
    sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if sibling.is_file():
        return str(sibling)
    return shutil.which("ffprobe") or ""


class VideoFrames:
    def __init__(self, projects):
        self.projects = projects

    # ---------- 对外 ----------
    def last_frame(self, url: str, project_id: str = "") -> dict:
        """视频地址 → 新图片作品。"""
        source = self._local_path(url)
        project = self.projects.get(project_id) or self.projects.active()
        task_id = "t_" + uuid.uuid4().hex[:10]
        base = self.projects.output_folder(project["id"])
        folder = base / task_id
        folder.mkdir(parents=True, exist_ok=True)

        ffmpeg = _ffmpeg()
        frame_path = folder / "_frame.png"
        try:
            self._grab(ffmpeg, source, frame_path)
            self._normalize(frame_path)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise

        now = int(time.time())
        stem = Path(unquote(str(url)).split("?")[0]).stem or "视频"
        label = f"视频尾帧 · {stem}"
        filename = output_name(label, 0, 1, ".png", now)
        final = folder / filename
        frame_path.replace(final)

        with Image.open(final) as image:
            width, height = image.size
        task = {
            "id": task_id,
            "project_id": project["id"],
            "prompt": label,
            "workflow": "video-last-frame",
            "kind": "image",
            "model": "",
            "negative": "",
            "loras": [],
            "width": width,
            "height": height,
            "params": {"source": url},
            "status": "done",
            "progress": 100,
            "node": "",
            "prompt_id": "",
            "images": [f"/api/output/{quote(base.name)}/{task_id}/{filename}"],
            "error": "",
            "created_at": now,
            "updated_at": now,
        }
        self.projects.add_task(task)
        return task

    # ---------- 内部 ----------
    @staticmethod
    def _local_path(url: str) -> Path:
        text = str(url or "")
        if not text:
            raise VideoFrameError("没有拿到视频地址")
        if text.startswith("/api/output/"):
            relative = unquote(text[len("/api/output/"):])
            target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p])
        elif text.startswith("/static/outputs/"):
            relative = unquote(text[len("/static/outputs/"):])
            target = OUTPUT_DIR.joinpath(*[p for p in relative.split("/") if p])
        else:
            raise VideoFrameError("只支持本项目的视频（外部地址请先下载到项目里）")
        if not target.is_file():
            raise VideoFrameError("视频文件不在了（可能已被删除）")
        return target

    @staticmethod
    def _run(cmd: list, timeout: int = 180) -> subprocess.CompletedProcess:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            return subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=flags)
        except FileNotFoundError as exc:
            raise VideoFrameError("ffmpeg 调用失败：找不到可执行文件") from exc
        except subprocess.TimeoutExpired as exc:
            raise VideoFrameError("ffmpeg 超时，视频可能太大或已损坏") from exc

    def _grab(self, ffmpeg: str, video: Path, out: Path) -> None:
        """取最后一帧：先按「结尾前 0.5 秒」，不行再按探测到的时长定位。"""
        attempts = [["-sseof", "-0.5"]]
        duration = self._duration(ffmpeg, video)
        if duration:
            attempts.append(["-ss", f"{max(0.0, duration - 0.15):.3f}"])
        last_error = ""
        for seek in attempts:
            if out.exists():
                out.unlink()
            cmd = [ffmpeg, "-y", "-v", "error", *seek, "-i", str(video),
                   "-frames:v", "1", "-update", "1", str(out)]
            result = self._run(cmd)
            if out.is_file() and out.stat().st_size > 0:
                return
            last_error = (result.stderr or b"").decode("utf-8", "ignore").strip()
        raise VideoFrameError("取尾帧失败：" + (last_error[:200] or "ffmpeg 没有输出图片"))

    @staticmethod
    def _duration(ffmpeg: str, video: Path) -> float:
        probe = _ffprobe(ffmpeg)
        if not probe:
            return 0.0
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            result = subprocess.run(
                [probe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(video)],
                capture_output=True, timeout=60, creationflags=flags,
            )
            return float((result.stdout or b"").decode().strip() or 0)
        except (ValueError, OSError, subprocess.SubprocessError):
            return 0.0

    @staticmethod
    def _normalize(path: Path) -> None:
        """统一转成 RGB PNG：ffmpeg 有时给出 16bit / 带 alpha 的帧，浏览器会嫌大。"""
        try:
            with Image.open(path) as image:
                image.load()
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA")
                image.save(path, "PNG")
        except Exception as exc:
            raise VideoFrameError(f"尾帧图片读取失败：{exc}") from exc
