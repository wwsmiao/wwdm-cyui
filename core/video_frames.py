"""视频尾帧提取：取视频最后一帧，存成一张新的图片作品。

独立实现，不经过 ComfyUI，也不依赖任何工作流 —— 调用本机 ffmpeg 解一帧即可。
卡片模式和画布模式共用同一个接口：

    POST /api/video/last-frame  {url, project_id, ref?}
    → {ok, task}    task 是新建的图片作品（和正常生图一样有卡片、能下载、能继续加工）

视频来源支持四种，和创作时引用素材的规则一致（见 core/grid_stitch.py）：
  · project  本项目作品（/api/output/...）：直接用原文件，不复制
  · input / output  ComfyUI 输入 / 输出目录（本地读磁盘，远程走 /view 取回）
  · library  资产库里的视频
  · upload / 老记录：按 input 目录找
"""
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

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
    def __init__(self, projects, files=None, library=None):
        self.projects = projects
        self.files = files          # ComfyFiles：读 input / output 目录（远程走 /view）
        self.library = library      # AssetLibrary：读资产库里的视频

    # ---------- 对外 ----------
    def last_frame(self, url: str, project_id: str = "", ref: dict | None = None) -> dict:
        """视频地址 → 新图片作品。ref 是节点上的素材引用（source + name），没有也能靠地址判断。"""
        project = self.projects.get(project_id) or self.projects.active()
        task_id = "t_" + uuid.uuid4().hex[:10]
        base = self.projects.output_folder(project["id"])
        folder = base / task_id
        folder.mkdir(parents=True, exist_ok=True)

        ffmpeg = _ffmpeg()
        frame_path = folder / "_frame.png"
        copied = None
        stem = "视频"
        try:
            source, copied, stem = self._source_of(url, ref, folder)
            self._grab(ffmpeg, source, frame_path)
            self._normalize(frame_path)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        finally:
            # 从 ComfyUI / 资产库取回来的临时副本，解完就删，别留在作品目录里
            if copied is not None:
                try:
                    copied.unlink(missing_ok=True)
                except OSError:
                    pass

        now = int(time.time())
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
    def _source_of(self, url: str, ref: dict | None, folder: Path):
        """把「地址 + 素材引用」变成一个能交给 ffmpeg 的本地文件。

        返回 (路径, 临时副本 or None, 用来命名的标题)。
        项目作品直接用原文件；其它来源（ComfyUI 目录 / 资产库 / 上传）先取回字节落一份临时副本。
        """
        text = self._path_of(url)
        ref = ref if isinstance(ref, dict) else {}
        # 引用里也可能直接是作品地址：source=project + name=/api/output/...
        ref_source = str(ref.get("source") or "").strip()
        ref_name = str(ref.get("name") or "").strip()
        project_ref = self._path_of(ref_name) if ref_source == "project" else ""

        # 1) 项目作品：直接用原文件，不复制、不额外占空间
        for candidate in (text, project_ref):
            if candidate.startswith(("/api/output/", "/static/outputs/")):
                return self._project_path(candidate), None, self._stem_of(candidate)

        # 2) 归一成 (source, name)：先看地址里的查询参数，再看前端传来的 ref
        source, name = self._split(text, ref)
        if not name:
            raise VideoFrameError("读不到这个视频（只支持本项目作品、ComfyUI 素材目录或资产库里的视频）")
        stem = self._stem_of(name)

        try:
            if source == "library":
                if self.library is None:
                    raise VideoFrameError("资产库不可用")
                category, _, filename = name.rpartition("/")
                data = self.library.read_bytes(category, filename or name)
            elif source in ("input", "output"):
                if self.files is None:
                    raise VideoFrameError("读取 ComfyUI 素材目录的功能不可用")
                data = self.files.read_bytes(source, name)
            else:
                # upload（拖文件进画布）/ 老记录 / 认不出来的：都落在 ComfyUI input 目录
                if self.files is None:
                    raise VideoFrameError("读取 ComfyUI 素材目录的功能不可用")
                data = self.files.read_bytes("input", name)
        except VideoFrameError:
            raise
        except Exception as exc:
            detail = str(exc)
            if "404" in detail or "Not Found" in detail:
                raise VideoFrameError(f"ComfyUI 上找不到这个视频：{name}") from exc
            raise VideoFrameError(f"读取视频失败：{name}（{detail}）") from exc

        if not data:
            raise VideoFrameError(f"视频取回来是空的：{name}")
        # 远程实例找不到文件时会回一段 JSON / HTML，别把这种东西当视频喂给 ffmpeg
        head = data[:400].lstrip().lower()
        if len(data) < 512 or head[:1] in (b"{", b"[") or head.startswith(b"<!doctype"):
            raise VideoFrameError(f"ComfyUI / 资产库里找不到这个视频：{name}")
        suffix = Path(name).suffix or ".mp4"
        temp = folder / f"_source{suffix}"
        temp.write_bytes(data)
        return temp, temp, stem

    @staticmethod
    def _split(url: str, ref: dict) -> tuple:
        """(source, name)：兼容 /api/comfy/file、/api/library/file 两种素材地址。"""
        text = VideoFrames._path_of(url)
        ref_source = str(ref.get("source") or "").strip()
        ref_name = str(ref.get("name") or "").strip()
        if text.startswith("/api/comfy/file"):
            query = parse_qs(urlparse(text).query)
            source = query.get("source", [""])[0] or ref_source or "input"
            name = query.get("name", [""])[0] or ref_name
            return source, name
        if text.startswith("/api/library/file"):
            query = parse_qs(urlparse(text).query)
            category = query.get("category", [""])[0]
            name = query.get("name", [""])[0] or ref_name.rpartition("/")[2]
            category = category or ref_name.rpartition("/")[0]
            return "library", (f"{category}/{name}" if category and name else name)
        source = ref_source
        name = ref_name
        if source == "project" and name and not name.startswith("/"):
            source = "input"          # 老记录：只存了 input 里的文件名
        return source, name

    @staticmethod
    def _path_of(url: str) -> str:
        """相对地址原样用；http(s) 绝对地址只取路径 + 查询（前端有时会带上 base）。"""
        text = str(url or "").strip()
        if text.startswith(("http://", "https://")):
            parsed = urlparse(text)
            return parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return text

    @staticmethod
    def _stem_of(value: str) -> str:
        """给作品起名用：去掉查询串、URL 编码和作品文件名前面的时间戳。"""
        name = Path(unquote(str(value or "").split("?")[0])).stem
        stem = re.sub(r"^\d{8}-\d{6}_", "", name).strip(" ._-")
        return stem or "视频"

    @staticmethod
    def _project_path(url: str) -> Path:
        text = str(url or "")
        if text.startswith("/api/output/"):
            relative = unquote(text[len("/api/output/"):])
            target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p])
        elif text.startswith("/static/outputs/"):
            relative = unquote(text[len("/static/outputs/"):])
            target = OUTPUT_DIR.joinpath(*[p for p in relative.split("/") if p])
        else:
            raise VideoFrameError("只支持本项目作品、ComfyUI 素材目录或资产库里的视频")
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
