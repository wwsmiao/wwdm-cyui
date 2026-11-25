"""网格拼接引擎：纯 Python（PIL），完全不经过 ComfyUI。

输入是一组参考图（按创作区里的顺序），输出一张 a×b 的网格长图：
  · 4 张图 + 1×4 → 一行四列的横向长图；3×2 就是三行两列
  · 每张图按原始像素贴进格子，不缩放、不重采样、不压 JPEG（存 PNG），画质不变
  · 格子等大：宽取所有图里最宽的那张、高取最高的那张 —— a×b 一定是规整网格；
    图在格子里居中，尺寸差出来的地方留透明，绝不做拉伸
  · 图不够填满时留透明格；图比格子多时只用前 a×b 张，并在 label 里说明

和 core/image_edit.py 一样，跑完直接落一条 done 任务，卡片模式 / 画布模式立刻多一张图。
"""
import io
import time
from urllib.parse import quote

from PIL import Image

from core.naming import output_name

# 单张画布最多多少像素（超大拼接容易吃满内存，RGBA 下 1 亿像素 ≈ 400MB）
MAX_PIXELS = 100_000_000


class GridStitchError(Exception):
    """拼接失败（读图失败 / 参数不合法 / 画布过大）。"""


class GridStitcher:
    def __init__(self, projects, files, library=None):
        self.projects = projects
        self.files = files
        self.library = library

    # ---------- 对外 ----------
    def run(self, task: dict) -> dict:
        """读参考图 → 拼接 → 存成作品，返回 {url, width, height, label}。"""
        params = task.get("params") or {}
        refs = [ref for ref in (params.get("refs") or []) if isinstance(ref, dict)]
        if not refs:
            raise GridStitchError("没有可拼接的参考图：先从左下角「参考图」加几张图")

        rows, cols = self._grid_of(params)
        images = []
        for ref in refs:
            images.append(self._open(ref))

        canvas, used = self._compose(images, rows, cols)
        label = self._label(rows, cols, used, len(images))
        url = self._save(canvas, task, label)
        return {
            "url": url,
            "width": canvas.width,
            "height": canvas.height,
            "label": label,
            "rows": rows,
            "cols": cols,
            "used": used,
            "total": len(images),
        }

    # ---------- 参数 ----------
    @staticmethod
    def _grid_of(params: dict) -> tuple:
        def number(key, default, high):
            try:
                value = int(float(params.get(key, default)))
            except (TypeError, ValueError):
                value = default
            return max(1, min(high, value))

        return number("grid_rows", 1, 24), number("grid_cols", 1, 48)

    @staticmethod
    def _label(rows: int, cols: int, used: int, total: int) -> str:
        text = f"网格拼接 {rows}×{cols}"
        if used < rows * cols:
            text += f"（{used} 图，空 {rows * cols - used} 格）"
        elif total > used:
            text += f"（用前 {used} 张）"
        return text

    # ---------- 读图 ----------
    def _open(self, ref: dict) -> Image.Image:
        data = self._bytes_of(ref)
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception as exc:                       # 损坏 / 格式不支持
            raise GridStitchError(f"图片解码失败：{ref.get('name') or ref.get('origin') or '未知'}（{exc}）") from exc
        return image.convert("RGBA")

    def _bytes_of(self, ref: dict) -> bytes:
        source = str(ref.get("source") or "project").strip() or "project"
        name = str(ref.get("name") or "").strip()
        if not name:
            raise GridStitchError("有一张参考图没有文件名（可能是素材记录坏了，重新选一次）")
        try:
            if source == "project":
                return self.files.read_output_file(name)
            if source == "library" and self.library is not None:
                category, _, filename = name.rpartition("/")
                return self.library.read_bytes(category, filename or name)
            if source in ("input", "output"):
                return self.files.read_bytes(source, name)
            # upload / 老记录：先看是不是作品地址，其余按 input 里的名字找
            if name.startswith(("/api/output/", "/static/outputs/")):
                return self.files.read_output_file(name)
            return self.files.read_bytes("input", name)
        except GridStitchError:
            raise
        except Exception as exc:
            raise GridStitchError(
                f"读取参考图失败：{ref.get('origin') or name}（{exc}）") from exc

    # ---------- 拼接 ----------
    def _compose(self, images: list, rows: int, cols: int):
        cells = rows * cols
        used = images[:cells]
        if not used:
            raise GridStitchError("没有可拼接的图片")

        # 所有格子等大：宽取最宽那张、高取最高那张 —— 这样 a×b 是规整的网格；
        # 图本身按原始像素居中放进格子，绝不缩放（尺寸差出来的地方留透明）
        cell_w = max(image.width for image in used)
        cell_h = max(image.height for image in used)

        width = cell_w * cols
        height = cell_h * rows
        if width * height > MAX_PIXELS:
            raise GridStitchError(
                f"拼出来太大了（{width}×{height}，上限 1 亿像素），少放几张图或者缩小网格再试")

        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for index, image in enumerate(used):
            r, c = divmod(index, cols)
            x = c * cell_w + (cell_w - image.width) // 2
            y = r * cell_h + (cell_h - image.height) // 2
            canvas.alpha_composite(image, (x, y))

        # 没有透明区域（图都铺满且都不透明）就存成 RGB，文件小一半
        if canvas.getchannel("A").getextrema()[0] == 255:
            canvas = canvas.convert("RGB")
        return canvas, len(used)

    # ---------- 存成作品 ----------
    def _save(self, image: Image.Image, task: dict, label: str) -> str:
        project_id = task.get("project_id") or self.projects.active()["id"]
        task_id = task.get("id") or ("t_" + str(int(time.time())))
        base = self.projects.output_folder(project_id)
        folder = base / task_id
        folder.mkdir(parents=True, exist_ok=True)
        filename = output_name(label, 0, 1, ".png", task.get("created_at"))
        image.save(folder / filename, format="PNG")
        return f"/api/output/{quote(base.name)}/{task_id}/{filename}"
