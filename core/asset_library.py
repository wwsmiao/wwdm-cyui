"""资产库：data/Asset Library 下每个子文件夹就是一个分类，资产文件直接拷贝进来。

- 分类 = 文件夹，可新建 / 重命名 / 删除（默认分类「未分类」不可删）
- 资产 = 文件夹里的媒体文件；支持从 ComfyUI 输出/输入、本项目作品加入
- 分类内文件名保持原文件名，重名自动加时间戳后缀
"""
from __future__ import annotations

import shutil
import time
from pathlib import Path

from config import DATA_DIR
from core.comfy import ComfyError

ROOT = DATA_DIR / "Asset Library"
DEFAULT_CATEGORY = "未分类"
PROMPT_CATEGORY = "提示词"   # 提示词工作流每次生成的文本都存一份到这里

MEDIA_KINDS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".bmp": "image", ".gif": "image",
    ".txt": "text",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video",
    ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio", ".m4a": "audio",
}


class AssetLibrary:
    def __init__(self, files=None):
        self.files = files          # ComfyFiles：从 ComfyUI / 本项目读源文件
        self.root = ROOT
        self.ensure()

    # ---------- 基础 ----------
    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / DEFAULT_CATEGORY).mkdir(exist_ok=True)

    def _dir(self, category: str) -> Path:
        name = (category or DEFAULT_CATEGORY).strip()
        if not name or name in (".", "..") or "/" in name or "\\" in name:
            raise ComfyError("分类名不合法")
        return self.root / name

    @staticmethod
    def _kind(name: str) -> str:
        return MEDIA_KINDS.get(Path(name).suffix.lower(), "")

    @classmethod
    def _size(cls, path: Path) -> tuple:
        """图片宽高（素材卡要显示分辨率），非图片或读不了就返回 0,0。"""
        if cls._kind(path.name) != "image":
            return 0, 0
        try:
            from PIL import Image
            with Image.open(path) as handle:
                return handle.size
        except Exception:
            return 0, 0

    def _media_files(self, folder: Path) -> list[Path]:
        if not folder.is_dir():
            return []
        rows = [f for f in folder.iterdir() if f.is_file() and self._kind(f.name)]
        return sorted(rows, key=lambda p: p.stat().st_mtime, reverse=True)

    # ---------- 分类 ----------
    def categories(self) -> list:
        self.ensure()
        rows = []
        for folder in sorted(self.root.iterdir(), key=lambda p: (p.name != DEFAULT_CATEGORY, p.name)):
            if not folder.is_dir():
                continue
            files = self._media_files(folder)
            rows.append({
                "name": folder.name,
                "count": len(files),
                "cover": files[0].name if files else "",
                "cover_url": self._url(folder.name, files[0].name) if files else "",
            })
        return rows

    def create_category(self, name: str) -> dict:
        target = self._dir(name)
        if target.exists():
            raise ComfyError("这个分类已经有了")
        target.mkdir(parents=True)
        return {"name": target.name}

    def rename_category(self, name: str, to: str) -> dict:
        source = self._dir(name)
        target = self._dir(to)
        if source.name == DEFAULT_CATEGORY:
            raise ComfyError("默认分类不能改名")
        if not source.is_dir():
            raise ComfyError("分类不存在")
        if target.exists():
            raise ComfyError("目标分类已存在")
        source.rename(target)
        return {"name": target.name}

    def delete_category(self, name: str) -> dict:
        target = self._dir(name)
        if target.name == DEFAULT_CATEGORY:
            raise ComfyError("默认分类不能删除")
        if not target.is_dir():
            raise ComfyError("分类不存在")
        shutil.rmtree(target)
        return {"name": target.name}

    # ---------- 资产 ----------
    def _url(self, category: str, name: str) -> str:
        from urllib.parse import quote
        return f"/api/library/file?category={quote(category)}&name={quote(name)}"

    def items(self, category: str = "") -> list:
        self.ensure()
        rows = []
        folders = [self._dir(category)] if category else [
            f for f in sorted(self.root.iterdir(), key=lambda p: p.name) if f.is_dir()
        ]
        for folder in folders:
            for file in self._media_files(folder):
                stat = file.stat()
                width, height = self._size(file)
                rows.append({
                    "key": f"library:{folder.name}/{file.name}",
                    "name": file.name,
                    "category": folder.name,
                    "kind": self._kind(file.name),
                    "source": "library",
                    "size": stat.st_size,
                    "width": width,
                    "height": height,
                    "mtime": int(stat.st_mtime),
                    "url": self._url(folder.name, file.name),
                    "ref": {"source": "library", "name": f"{folder.name}/{file.name}"},
                })
        rows.sort(key=lambda item: item["mtime"], reverse=True)
        return rows

    def read_source(self, source: str, name: str) -> bytes:
        """读取要入库的源文件字节：project=本项目作品，output/input=ComfyUI 目录。"""
        if not self.files:
            raise ComfyError("素材服务未就绪")
        if source == "project":
            return self.files.read_output_file(name)
        return self.files.read_bytes(source, name)

    def add(self, source: str, name: str, category: str = "", title: str = "") -> dict:
        from core.naming import safe_stem

        clean = str(name).replace("\\", "/")
        data = self.read_source(source, clean)
        if not data:
            raise ComfyError("没有读到资产内容")
        folder = self._dir(category)
        folder.mkdir(parents=True, exist_ok=True)
        base = Path(clean).name
        ext = Path(base).suffix or ".png"
        # 入库名优先用作品标题（提示词摘要），否则沿用原文件名：不再一律叫 1.png
        stem = str(title or "").strip()
        if stem and Path(stem).suffix.lower() in MEDIA_KINDS:
            stem = Path(stem).stem
        stem = safe_stem(stem, 40)
        filename = f"{stem}{ext}" if stem else base
        target = folder / filename
        if target.exists():
            target = folder / f"{target.stem}-{int(time.time())}{target.suffix}"
        target.write_bytes(data)
        return {"name": target.name, "category": folder.name, "url": self._url(folder.name, target.name)}

    def save_text(self, text: str, title: str = "") -> dict:
        """把生成的提示词存成 .txt 放进「提示词」分类：图库关闭后也能翻回来复制。"""
        from core.naming import safe_stem, stamp_of

        body = str(text or "").strip()
        if not body:
            raise ComfyError("没有可保存的提示词")
        folder = self._dir(PROMPT_CATEGORY)
        folder.mkdir(parents=True, exist_ok=True)
        stem = safe_stem(title, 20) or "提示词"
        base = f"{stamp_of()}_{stem}"
        target = folder / f"{base}.txt"
        index = 2
        while target.exists():
            target = folder / f"{base}-{index}.txt"
            index += 1
        target.write_text(body, encoding="utf-8")
        return {"name": target.name, "category": folder.name,
                "kind": "text", "url": self._url(folder.name, target.name)}

    def rename_item(self, category: str, name: str, to: str) -> dict:
        """重命名分类里的文件；用户没写扩展名时沿用原扩展名。"""
        folder = self._dir(category)
        source = folder / Path(name).name
        if not source.is_file():
            raise ComfyError("资产不存在")
        new_name = Path(str(to or "")).name.strip()
        if not new_name:
            raise ComfyError("新文件名不能为空")
        if not Path(new_name).suffix:
            new_name = f"{new_name}{source.suffix}"
        target = folder / new_name
        if target == source:
            return {"name": source.name, "category": folder.name}
        if target.exists():
            raise ComfyError("这个分类里已经有同名文件")
        try:
            source.rename(target)
        except OSError as exc:
            raise ComfyError(f"重命名失败：{exc}") from exc
        return {"name": target.name, "category": folder.name}

    def move(self, category: str, name: str, to: str) -> dict:
        source = self._dir(category) / Path(name).name
        if not source.is_file():
            raise ComfyError("资产不存在")
        target_dir = self._dir(to)
        if target_dir.name == source.parent.name:
            return {"name": source.name, "category": target_dir.name}
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        if target.exists():
            target = target_dir / f"{target.stem}-{int(time.time())}{target.suffix}"
        shutil.move(str(source), str(target))
        return {"name": target.name, "category": target_dir.name, "from": category}

    def copy_item(self, category: str, name: str, to: str) -> dict:
        source = self._dir(category) / Path(name).name
        if not source.is_file():
            raise ComfyError("资产不存在")
        target_dir = self._dir(to)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        if target.exists():
            target = target_dir / f"{target.stem}-{int(time.time())}{target.suffix}"
        shutil.copy2(source, target)
        return {"name": target.name, "category": target_dir.name, "from": category}

    def copy_category(self, name: str, to: str) -> dict:
        source = self._dir(name)
        target = self._dir(to)
        if not source.is_dir():
            raise ComfyError("分类不存在")
        if target.exists():
            raise ComfyError("目标分类已存在")
        shutil.copytree(source, target)
        return {"name": target.name, "from": source.name}

    def remove(self, category: str, name: str) -> dict:
        target = self._dir(category) / Path(name).name
        if not target.is_file():
            raise ComfyError("资产不存在")
        target.unlink()
        return {"name": target.name}

    def file_path(self, category: str, name: str) -> Path:
        target = self._dir(category) / Path(name).name
        if not target.is_file():
            raise ComfyError("资产不存在")
        return target

    def read_bytes(self, category: str, name: str) -> bytes:
        return self.file_path(category, name).read_bytes()
