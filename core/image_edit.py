"""本地图片编辑：裁剪 / 旋转翻转 / 色调调整，直接出成一张新作品（不经过 ComfyUI）。

卡片右键的「快速编辑」用这里的能力，处理完会新建一条 done 任务，
所以卡片模式、画布模式、本项目目录都会立刻多出一张图，行为和生成出图一致。
"""
import time
import uuid
from urllib.parse import quote

from PIL import Image, ImageEnhance

from config import DATA_DIR, OUTPUT_DIR
from core.naming import output_name
from core.projects import _now

# 裁剪比例（宽:高），「原图」表示不裁
CROP_RATIOS = {
    "原图": None,
    "1:1": (1, 1),
    "4:3": (4, 3),
    "3:4": (3, 4),
    "16:9": (16, 9),
    "9:16": (9, 16),
    "3:2": (3, 2),
    "2:3": (2, 3),
}

ROTATE_MODES = {
    "left": ("左转 90°", Image.Transpose.ROTATE_90),
    "right": ("右转 90°", Image.Transpose.ROTATE_270),
    "180": ("翻转 180°", Image.Transpose.ROTATE_180),
    "flip-h": ("水平镜像", Image.Transpose.FLIP_LEFT_RIGHT),
    "flip-v": ("垂直镜像", Image.Transpose.FLIP_TOP_BOTTOM),
}


class ImageEditError(Exception):
    """本地编辑失败（来源不支持 / 参数不合法）。"""


class ImageEditor:
    def __init__(self, projects):
        self.projects = projects

    # ---------- 对外 ----------
    def edit(self, url: str, op: str, options: dict | None = None) -> dict:
        options = options or {}
        source = self._open(url)
        image, label = self._apply(source, op, options)
        return self._save(image, label, op, options, url)

    # ---------- 读图 ----------
    @staticmethod
    def _open(url: str) -> Image.Image:
        text = str(url or "")
        if not text:
            raise ImageEditError("没有拿到图片地址")
        target = None
        if text.startswith("/api/output/"):
            relative = text[len("/api/output/"):]
            target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p])
        elif text.startswith("/static/outputs/"):
            relative = text[len("/static/outputs/"):]
            target = OUTPUT_DIR.joinpath(*[p for p in relative.split("/") if p])
        if target is None:
            raise ImageEditError("这个来源的图片暂不支持本地编辑，请先「添加到资产库」再处理")
        if not target.is_file():
            raise ImageEditError("原图文件不在了（可能已被删除），可以先用右键「拿最新图片」找回")
        try:
            image = Image.open(target)
            image.load()
        except Exception as exc:                      # 损坏 / 格式不支持
            raise ImageEditError(f"图片读取失败：{exc}") from exc
        return image

    # ---------- 处理 ----------
    def _apply(self, image: Image.Image, op: str, options: dict):
        if op == "crop":
            return self._crop(image, options)
        if op == "rotate":
            return self._rotate(image, options)
        if op == "tone":
            return self._tone(image, options)
        raise ImageEditError(f"不支持的编辑操作：{op}")

    @staticmethod
    def _crop(image: Image.Image, options: dict):
        width, height = image.size
        # 前端裁剪框给的像素矩形（x/y/w/h 相对于原图）：优先按它裁
        rect = options.get("rect")
        if isinstance(rect, dict):
            try:
                left = int(round(float(rect.get("x", 0))))
                top = int(round(float(rect.get("y", 0))))
                want_w = int(round(float(rect.get("w", width))))
                want_h = int(round(float(rect.get("h", height))))
            except (TypeError, ValueError):
                raise ImageEditError("裁剪区域参数不合法")
            left = max(0, min(width - 8, left))
            top = max(0, min(height - 8, top))
            want_w = max(8, min(width - left, want_w))
            want_h = max(8, min(height - top, want_h))
            return (image.crop((left, top, left + want_w, top + want_h)),
                    f"裁剪 · {want_w}×{want_h}")

        # 兼容旧调用：只给比例时取居中最大矩形
        ratio_name = str(options.get("ratio") or "原图")
        if ratio_name not in CROP_RATIOS:
            raise ImageEditError(f"不支持的裁剪比例：{ratio_name}")
        pair = CROP_RATIOS[ratio_name]
        if pair is None:
            return image, "裁剪 · 原图"
        want_w, want_h = pair
        if width * want_h > height * want_w:
            new_w = int(round(height * want_w / want_h))
            new_h = height
        else:
            new_w = width
            new_h = int(round(width * want_h / want_w))
        new_w = max(8, min(width, new_w))
        new_h = max(8, min(height, new_h))
        left = (width - new_w) // 2
        top = (height - new_h) // 2
        return image.crop((left, top, left + new_w, top + new_h)), f"裁剪 · {ratio_name}"

    @staticmethod
    def _rotate(image: Image.Image, options: dict):
        mode = str(options.get("mode") or "left")
        if mode not in ROTATE_MODES:
            raise ImageEditError(f"不支持的旋转方式：{mode}")
        label, method = ROTATE_MODES[mode]
        return image.transpose(method), f"旋转 · {label}"

    @staticmethod
    def _tone(image: Image.Image, options: dict):
        def num(key, default, low, high):
            try:
                value = float(options.get(key, default))
            except (TypeError, ValueError):
                value = default
            return max(low, min(high, value))

        brightness = num("brightness", 1.0, 0.4, 1.8)
        contrast = num("contrast", 1.0, 0.4, 1.8)
        saturation = num("saturation", 1.0, 0.0, 2.0)
        warmth = num("warmth", 0.0, -1.0, 1.0)

        result = image.convert("RGB")
        if brightness != 1.0:
            result = ImageEnhance.Brightness(result).enhance(brightness)
        if contrast != 1.0:
            result = ImageEnhance.Contrast(result).enhance(contrast)
        if saturation != 1.0:
            result = ImageEnhance.Color(result).enhance(saturation)
        if warmth:
            r, g, b = result.split()
            gain = 0.25 * warmth                       # 暖调抬红压蓝，冷调反过来
            r = r.point(lambda v: max(0, min(255, int(v * (1 + gain)))))
            b = b.point(lambda v: max(0, min(255, int(v * (1 - gain)))))
            result = Image.merge("RGB", (r, g, b))
        parts = []
        if brightness != 1.0:
            parts.append(f"亮度 {brightness:.2f}")
        if contrast != 1.0:
            parts.append(f"对比 {contrast:.2f}")
        if saturation != 1.0:
            parts.append(f"饱和 {saturation:.2f}")
        if warmth:
            parts.append(f"{'暖' if warmth > 0 else '冷'} {abs(warmth):.2f}")
        return result, "色调 · " + (" · ".join(parts) if parts else "未改动")

    # ---------- 存成新作品 ----------
    def _save(self, image: Image.Image, label: str, op: str, options: dict, source_url: str) -> dict:
        project = self.projects.active()
        task_id = "t_" + uuid.uuid4().hex[:10]
        base = self.projects.output_folder(project["id"])
        folder = base / task_id
        folder.mkdir(parents=True, exist_ok=True)
        now = int(time.time())
        filename = output_name(label, 0, 1, ".png", now)
        image.save(folder / filename)
        url = f"/api/output/{quote(base.name)}/{task_id}/{filename}"
        task = {
            "id": task_id,
            "project_id": project["id"],
            "prompt": label,
            "workflow": "local-edit",
            "kind": "image",
            "model": "",
            "negative": "",
            "loras": [],
            "width": image.width,
            "height": image.height,
            "params": {"op": op, "options": options, "source": source_url},
            "status": "done",
            "progress": 100,
            "node": "",
            "prompt_id": "",
            "images": [url],
            "error": "",
            "created_at": now,
            "updated_at": _now(),
        }
        self.projects.add_task(task)
        return task
