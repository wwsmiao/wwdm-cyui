"""图库图片删除：同时清理任务记录中的条目与本地图片文件。"""
from collections import defaultdict

from config import OUTPUT_DIR
from core.projects import _now


class ImageManager:
    def __init__(self, projects):
        self.projects = projects

    def delete(self, items) -> int:
        """items: [{"task_id": "...", "index": 0, "url": "..."}]，index 不认识时按 url 兜底。"""
        grouped = defaultdict(list)
        urls = defaultdict(list)
        for item in items or []:
            task_id = str(item.get("task_id", ""))
            if not task_id:
                continue
            try:
                index = int(item.get("index", -1))
            except (TypeError, ValueError):
                index = -1
            grouped[task_id].append(index)
            if item.get("url"):
                urls[task_id].append(str(item["url"]))

        removed_paths = []
        removed_tasks = []
        orphans = [str(item.get("url") or "") for item in items or []
                   if not str(item.get("task_id") or "").strip()]

        def edit(db):
            for task_id, indices in grouped.items():
                task = db["tasks"].get(task_id)
                if not task:
                    continue
                images = task.get("images", [])
                targets = {index for index in indices if 0 <= index < len(images)}
                # 前端拿不到准确下标时（列表顺序变了 / 任务不在当前页）按地址再找一遍
                for url in urls.get(task_id) or []:
                    if url in images:
                        targets.add(images.index(url))
                for index in sorted(targets, reverse=True):
                    if 0 <= index < len(images):
                        removed_paths.append(images.pop(index))
                task["updated_at"] = _now()
                # 图片全删光后，任务记录也一起删掉：卡片模式不会留下空卡片
                if not images:
                    removed_tasks.append((task_id, task.get("project_id") or ""))
                    db["tasks"].pop(task_id, None)

        self.projects.store.update(edit)

        removed = 0
        for src in removed_paths:
            self._unlink(src)
            removed += 1
        # 没有任务记录的文件（卡片已删）：直接删文件
        for src in orphans:
            if self._unlink(src):
                removed += 1
        for task_id, _project_id in removed_tasks:
            self._remove_task_folder(task_id)
        return removed

    @staticmethod
    def _remove_task_folder(task_id: str) -> None:
        """任务记录删除后，把它对应的作品文件夹（新地址 / 旧地址）也清掉。"""
        import shutil
        from config import DATA_DIR

        try:
            if OUTPUT_DIR.is_dir():
                old = OUTPUT_DIR / task_id
                if old.is_dir():
                    shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
        try:
            for project_dir in DATA_DIR.glob("*_opt"):
                target = project_dir / task_id
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
        except OSError:
            pass

    @staticmethod
    def _unlink(src: str) -> bool:
        """只删除输出目录之内的文件：新地址 /api/output/<项目_opt>/...，旧地址 /static/outputs/..."""
        from config import DATA_DIR
        try:
            if str(src).startswith("/api/output/"):
                from urllib.parse import unquote
                relative = unquote(str(src)[len("/api/output/"):])
                target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p]).resolve()
                if DATA_DIR.resolve() not in target.parents:
                    return False
                if target.is_file():
                    target.unlink()
                    ImageManager._prune_empty(target.parent)
                    return True
                return False
            parts = src.strip("/").split("/")
            if len(parts) < 3 or parts[0] != "static" or parts[1] != "outputs":
                return False
            target = OUTPUT_DIR.joinpath(*parts[2:]).resolve()
            if OUTPUT_DIR.resolve() not in target.parents:
                return False
            if target.is_file():
                target.unlink()
                ImageManager._prune_empty(target.parent)
                return True
        except OSError:
            pass
        return False

    @staticmethod
    def _prune_empty(folder) -> None:
        """删完文件后把空的 <任务> 目录一起收掉，作品目录不留空壳。"""
        try:
            if folder.is_dir() and not any(folder.iterdir()):
                folder.rmdir()
        except OSError:
            pass
