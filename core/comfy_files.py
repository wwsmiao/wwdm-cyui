"""ComfyUI 素材目录：浏览输入/输出、导入参考图、落地上传。

目录定位顺序：设置里的 comfy_dir → 通过监听端口反查 ComfyUI 进程的工作目录。
两者都拿不到（或 ComfyUI 是远程实例）时退回 ComfyUI 接口：
  输入目录走 /object_info/LoadImage·LoadVideo·LoadAudio，输出目录走 /history，
  读取走 /view，上传走 /upload/image —— 远程实例下整个素材流程照常可用。
"""
import socket
from pathlib import Path
from urllib.parse import urlencode, urlparse

import psutil

from config import DATA_DIR, OUTPUT_DIR
from core.comfy import ComfyError
from core.store import JsonStore

MEDIA_KINDS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".bmp": "image", ".gif": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video",
    ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio", ".m4a": "audio",
}
MAX_ITEMS = 400
REF_ROOT = "wwdm_ref"

# 本项目上传/导入过的素材索引：远程实例枚举不到 input 子目录，靠这份记录补齐「本项目」页签
UPLOAD_DB = DATA_DIR / "uploads.json"


class UploadIndex:
    """{项目ID: [{name, kind, size, mtime, origin}]}，name 相对 ComfyUI input。"""

    def __init__(self):
        self.store = JsonStore(UPLOAD_DB, {"uploads": {}})

    def add(self, project_id: str, name: str, kind: str, size: int = 0, origin: str = "") -> None:
        import time
        if not project_id or not name:
            return
        name = str(name).replace("\\", "/")

        def edit(db):
            rows = db["uploads"].setdefault(project_id, [])
            for row in rows:
                if row["name"] == name:
                    # 同名重传：把大小 / 时间刷成最新，远程列表才不会显示旧尺寸
                    row["size"] = int(size or 0)
                    row["mtime"] = int(time.time())
                    row["kind"] = kind or row.get("kind") or "image"
                    if origin:
                        row["origin"] = origin
                    return
            rows.append({
                "name": name,
                "kind": kind,
                "size": int(size or 0),
                "mtime": int(time.time()),
                "origin": origin or "",
            })

        self.store.update(edit)

    def drop_project(self, project_id: str) -> None:
        """删除项目时清掉它的上传索引。"""
        def edit(db):
            (db.get("uploads") or {}).pop(project_id, None)
        self.store.update(edit)

    def remove(self, name: str) -> None:
        """文件被删掉后，把上传索引里的记录一并清掉（跨项目扫描）。"""
        target = str(name).replace("\\", "/")

        def edit(db):
            for rows in (db.get("uploads") or {}).values():
                rows[:] = [row for row in rows if row.get("name") != target]

        self.store.update(edit)

    def for_project(self, project_id: str) -> list:
        rows = self.store.read()["uploads"].get(project_id) or []
        return sorted(rows, key=lambda row: row.get("mtime") or 0, reverse=True)

# 图片宽高缓存：瀑布流和卡片都要用，避免每次列表都重新读文件头
_SIZE_CACHE: dict = {}


def _image_size(path: Path, mtime: int, size: int) -> tuple:
    key = (str(path), mtime, size)
    cached = _SIZE_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        from PIL import Image
        with Image.open(path) as handle:
            result = handle.size
    except Exception:  # 损坏的图或缺少 Pillow
        result = (0, 0)
    if len(_SIZE_CACHE) > 2000:
        _SIZE_CACHE.clear()
    _SIZE_CACHE[key] = result
    return result


class ComfyFiles:
    def __init__(self, comfy, settings_getter):
        self.comfy = comfy
        self.settings = settings_getter
        self._root = None
        self.uploads = UploadIndex()

    # ---------- 目录 ----------
    def is_local(self) -> bool:
        """ComfyUI 是否就在本机：显式配置 comfy_dir 视为本机，否则按地址判断。"""
        if str(self.settings().get("comfy_dir") or "").strip():
            return True
        host = (urlparse(self.comfy.base).hostname or "").lower()
        if host in ("127.0.0.1", "localhost", "::1", ""):
            return True
        try:
            ips = {socket.gethostbyname(socket.gethostname())}
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ips.add(info[4][0])
        except (OSError, socket.gaierror):
            ips = set()
        return host in {str(ip).lower() for ip in ips if ip}

    def root(self) -> Path | None:
        if not self.is_local():
            # 远程实例：本地目录与本机进程都没有意义，全部走 HTTP 接口
            return None
        configured = str(self.settings().get("comfy_dir") or "").strip()
        if configured:
            path = Path(configured)
            if (path / "input").is_dir() or (path / "output").is_dir():
                return path
        if self._root and self._root.is_dir():
            return self._root
        self._root = self._detect_root()
        return self._root

    def folder(self, source: str) -> Path | None:
        root = self.root()
        if not root:
            return None
        folder = root / ("output" if source == "output" else "input")
        return folder if folder.is_dir() else None

    def _detect_root(self) -> Path | None:
        port = urlparse(self.comfy.base).port or 8188
        candidates = []
        try:
            for conn in psutil.net_connections(kind="inet"):
                if conn.laddr and conn.laddr.port == port and conn.pid:
                    candidates.append(conn.pid)
        except (psutil.Error, OSError):
            pass
        try:
            for proc in psutil.process_iter(["cmdline"]):
                args = proc.info.get("cmdline") or []
                if any(str(a).replace("\\", "/").endswith("main.py") for a in args):
                    candidates.append(proc.pid)
        except (psutil.Error, OSError):
            pass
        for pid in candidates:
            path = self._root_of(pid)
            if path:
                return path
        return None

    @staticmethod
    def _root_of(pid: int) -> Path | None:
        try:
            proc = psutil.Process(pid)
            cwd = Path(proc.cwd())
            if (cwd / "input").is_dir() or (cwd / "output").is_dir():
                return cwd
            for arg in proc.cmdline():
                text = str(arg).replace("\\", "/")
                if text.endswith("main.py"):
                    base = (cwd / text).resolve().parent
                    if (base / "input").is_dir() or (base / "output").is_dir():
                        return base
        except (psutil.Error, OSError, ValueError):
            return None
        return None

    # ---------- 列表 ----------
    def scan(self, folder: Path, relative_to: Path, source: str, prefix: str = "") -> list:
        items = []
        if not folder or not folder.is_dir():
            return items
        for entry in folder.rglob("*"):
            if not entry.is_file():
                continue
            kind = MEDIA_KINDS.get(entry.suffix.lower())
            if not kind:
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            name = entry.relative_to(relative_to).as_posix()
            # wwdm_ref 是我们自己往 ComfyUI input 里放的项目素材，交给「本项目」页签管理
            if name.startswith(f"{REF_ROOT}/"):
                continue
            width = height = 0
            if kind == "image":
                width, height = _image_size(entry, int(stat.st_mtime), stat.st_size)
            items.append({
                "key": f"{source}:{prefix}{name}",
                "name": name,
                "kind": kind,
                "source": source,
                "prefix": prefix,
                "size": stat.st_size,
                "width": width,
                "height": height,
                "mtime": int(stat.st_mtime),
            })
        return items

    def list_source(self, source: str) -> list:
        source = "output" if source == "output" else "input"
        folder = self.folder(source)
        if folder:
            # 能找到本地目录就以目录为准（哪怕为空）：避免 ComfyUI /history 里
            # 早就被清掉的历史条目变成点不开的幽灵素材
            return self.scan(folder, folder, source)
        return self._api_items(source)

    def list_all(self) -> dict:
        items = self.list_source("input") + self.list_source("output")
        items.sort(key=lambda item: item["mtime"], reverse=True)
        return {"items": items[:MAX_ITEMS], "total": len(items), "fallback": not self.folder("input")}

    def list_uploads(self, project_id: str) -> list:
        """本项目上传/导入过的素材：本地读目录并顺手回填索引，远程直接读索引。"""
        prefix = f"{REF_ROOT}/{project_id}/"
        folder = self.folder("input")
        if folder:
            target = folder / REF_ROOT / project_id
            if target.is_dir():
                rows = self.scan(target, target, "input", prefix=prefix)
                for row in rows:
                    # 本机模式时把扫描结果回填进索引，切到远程实例后「本项目」页签仍有数据
                    self.uploads.add(project_id, prefix + row["name"], row["kind"], row["size"])
                return rows

        rows = []
        for row in self.uploads.for_project(project_id):
            name = str(row["name"]).replace("\\", "/")
            relative = name[len(prefix):] if name.startswith(prefix) else name
            rows.append({
                "key": f"input:{prefix}{relative}",
                "name": relative,
                "kind": row.get("kind") or "image",
                "source": "input",
                "prefix": prefix,
                "size": row.get("size") or 0,
                "width": 0,
                "height": 0,
                "mtime": row.get("mtime") or 0,
            })
        if rows:
            return rows
        # 索引里还没有（老版本导入的素材）时，退化到选项列表按前缀过滤
        return [self._with_prefix(item, prefix)
                for item in self._api_items("input")
                if item["name"].startswith(prefix)]

    @staticmethod
    def _with_prefix(item: dict, prefix: str) -> dict:
        """远程模式下 name 是完整相对路径，拆成 prefix + 相对名，保持与本地扫描一致的形状。"""
        entry = dict(item)
        entry["name"] = item["name"][len(prefix):]
        entry["prefix"] = prefix
        return entry

    def _api_items(self, source: str) -> list:
        if source == "input":
            items: list = []
            for node, field, kind in (
                ("LoadImage", "image", "image"),
                ("LoadVideo", "file", "video"),
                ("LoadAudio", "audio", "audio"),
            ):
                try:
                    info = self.comfy.request("GET", f"/object_info/{node}", timeout=10).json()
                    names = (info.get(node, {}).get("input", {})
                             .get("required", {}).get(field, [[]]))[0]
                    if isinstance(names, str):
                        # 有些节点返回 "COMBO" 这种类型标记而不是文件列表，直接跳过
                        if names.strip().upper() in ("COMBO", "STRING"):
                            continue
                        names = [part.strip() for part in names.split(",") if part.strip()]
                    if not isinstance(names, (list, tuple)):
                        continue
                except ComfyError:
                    continue
                for name in names:
                    clean = str(name).replace("\\", "/")
                    if clean.startswith(f"{REF_ROOT}/"):
                        continue   # 项目素材由「本项目」管理
                    items.append({
                        "key": f"input:{clean}",
                        "name": clean,
                        "kind": kind,
                        "source": "input",
                        "prefix": "",
                        "size": 0,
                        "width": 0,
                        "height": 0,
                        "mtime": 0,
                    })
            return items
        history = self.comfy.request("GET", "/history?max_items=400", timeout=15).json()
        found = {}
        for entry in history.values():
            for output in (entry.get("outputs") or {}).values():
                for image in output.get("images") or []:
                    if image.get("type") != "output":
                        continue
                    subfolder = image.get("subfolder") or ""
                    name = f"{subfolder}/{image['filename']}" if subfolder else image["filename"]
                    name = name.replace("\\", "/")
                    if name.startswith(f"{REF_ROOT}/"):
                        continue
                    kind = MEDIA_KINDS.get(Path(name).suffix.lower(), "image")
                    meta = image.get("metadata") or {}
                    found[name] = {
                        "key": f"output:{name}", "name": name, "kind": kind,
                        "source": "output", "prefix": "", "size": 0,
                        "width": int(meta.get("width") or 0),
                        "height": int(meta.get("height") or 0),
                        "mtime": 0,
                    }
        return list(found.values())

    # ---------- 读取 ----------
    def _local_path(self, source: str, name: str) -> Path | None:
        folder = self.folder(source)
        if not folder:
            return None
        parts = [part for part in str(name).replace("\\", "/").split("/") if part]
        target = folder.joinpath(*parts).resolve()
        if folder.resolve() not in target.parents or not target.is_file():
            return None
        return target

    def read_bytes(self, source: str, name: str) -> bytes:
        local = self._local_path(source, name)
        if local:
            try:
                return local.read_bytes()
            except OSError as exc:
                raise ComfyError(f"读取图片失败：{exc}") from exc
        clean = str(name).replace("\\", "/")
        subfolder, _, filename = clean.rpartition("/")
        query = {"filename": filename or clean, "type": "output" if source == "output" else "input"}
        if subfolder:
            query["subfolder"] = subfolder
        return self.comfy.request("GET", "/view?" + urlencode(query), timeout=60).content

    def read_output_file(self, url: str) -> bytes:
        """项目作品地址（/api/output/... 或旧的 /static/outputs/...）→ 本地字节。"""
        from config import DATA_DIR
        text = str(url)
        if text.startswith("/api/output/"):
            from urllib.parse import unquote
            relative = unquote(text[len("/api/output/"):])
            target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p]).resolve()
            if DATA_DIR.resolve() not in target.parents or not target.is_file():
                raise ComfyError(f"找不到作品文件：{url}")
            return target.read_bytes()
        relative = url.split("/static/outputs/", 1)[-1]
        target = OUTPUT_DIR.joinpath(*[p for p in relative.split("/") if p]).resolve()
        if OUTPUT_DIR.resolve() not in target.parents or not target.is_file():
            raise ComfyError(f"找不到作品文件：{url}")
        return target.read_bytes()

    # ---------- 写入 ComfyUI 输入目录 ----------
    def _upload(self, project_id: str, filename: str, data: bytes) -> str:
        subfolder = f"{REF_ROOT}/{project_id}" if project_id else REF_ROOT
        safe_name = self._dedupe_name(project_id, Path(filename).name, len(data))
        response = self.comfy.request(
            "POST", "/upload/image", timeout=180,
            files={"image": (safe_name, data, "image/png")},
            data={"type": "input", "subfolder": subfolder, "overwrite": "true"},
        ).json()
        uploaded = response.get("name") or safe_name
        folder = response.get("subfolder") or subfolder
        name = f"{folder}/{uploaded}"
        if project_id:
            self.uploads.add(project_id, name, self._kind_of_name(name), len(data),
                             origin=filename)
        return name

    def _dedupe_name(self, project_id: str, filename: str, size: int) -> str:
        """同名不同内容时换一个名字：以前 1.png 会把上一张参考图直接覆盖掉。"""
        import time

        if not project_id:
            return filename
        rows = {Path(str(row.get("name") or "")).name: row
                for row in self.uploads.for_project(project_id)}
        row = rows.get(filename)
        if not row or int(row.get("size") or 0) == int(size or 0):
            return filename
        stem, dot, ext = filename.rpartition(".")
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        return f"{stem}-{stamp}.{ext}" if dot else f"{filename}-{stamp}"

    @staticmethod
    def _kind_of_name(name: str) -> str:
        return MEDIA_KINDS.get(Path(str(name).replace("\\", "/")).suffix.lower(), "image")

    def delete_file(self, source: str, name: str) -> bool:
        """删除 ComfyUI 输入/输出目录里的文件（远程实例没有本地目录，不支持）。"""
        folder = self.folder(source)
        if not folder:
            raise ComfyError("远程 ComfyUI 不支持删除文件，请到 ComfyUI 的输入/输出目录手动清理")
        target = self._local_path(source, name)
        if not target:
            raise ComfyError("文件不存在或路径不合法")
        try:
            target.unlink()
        except OSError as exc:
            raise ComfyError(f"删除失败：{exc}") from exc
        if source != "output":
            self.uploads.remove(str(name))
        return True

    def prepare_reference(self, source: str, name: str, project_id: str = "") -> str:
        """返回可直接写进 LoadImage / LoadVideo / LoadAudio 的名字。"""
        clean = str(name).replace("\\", "/")
        # wwdm_ref/ 是我们自己的 input 子目录，名字本身就说明它在 input 里；
        # 旧记录可能把 source 标成 output，按名字纠正，避免去 /view?type=output 拿图 404
        if clean.startswith(f"{REF_ROOT}/"):
            if project_id:
                self.uploads.add(project_id, clean, self._kind_of_name(clean))
            return clean
        if source == "input":
            if project_id:
                self.uploads.add(project_id, clean, self._kind_of_name(clean))
            return clean
        # upload / 早先导入过的名字本身就是 input 下的相对路径：直接用，别再去 output 里找
        if source != "output" and self._local_path("input", clean):
            if project_id:
                self.uploads.add(project_id, clean, self._kind_of_name(clean))
            return clean
        if source == "output":
            data = self.read_bytes("output", clean)
        else:  # project：来自本项目作品
            data = self.read_output_file(clean)
        return self._upload(project_id, self._reference_name(clean, source), data)

    @staticmethod
    def _reference_name(clean: str, source: str) -> str:
        """参考图在 input 里的文件名：本项目作品带上任务号，避免多张 1.png 互相覆盖。"""
        parts = [part for part in str(clean).replace("\\", "/").split("/") if part]
        base = parts[-1] if parts else "image.png"
        if source == "project" and len(parts) >= 2:
            task_id = parts[-2]
            if task_id.startswith("t_"):
                return f"{task_id}_{base}"
        return base

    def upload_local(self, project_id: str, filename: str, data: bytes) -> str:
        return self._upload(project_id, Path(filename).name, data)
