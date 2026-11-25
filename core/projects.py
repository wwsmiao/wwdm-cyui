"""项目与任务记录的增删改查。数据落盘在 data/projects.json。"""
import time
import uuid

from config import PROJECTS_FILE
from core.store import JsonStore

DEFAULT_DB = {
    "active_id": "",
    "projects": [],
    "tasks": {},
}


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _now() -> int:
    return int(time.time())


def _image_size(path):
    """读图片宽高；视频 / 损坏文件返回 None。"""
    try:
        from PIL import Image
        with Image.open(path) as handle:
            return handle.size
    except Exception:
        return None


class ProjectManager:
    def __init__(self):
        self.store = JsonStore(PROJECTS_FILE, DEFAULT_DB)
        db = self.store.read()
        if not db["projects"]:
            project = self._new_project("Untitled")
            db["projects"].append(project)
            db["active_id"] = project["id"]
            self.store.write(db)

    @staticmethod
    def _new_project(name: str) -> dict:
        return {
            "id": _uid("p"),
            "name": name,
            "notes": "",
            "created_at": _now(),
            "updated_at": _now(),
            "progress_cleared_at": 0,
        }

    # ---------- 项目 ----------
    def list(self) -> list:
        db = self.store.read()
        return [{**p, "notes": p.get("notes", ""), "task_count": sum(
            1 for t in db["tasks"].values() if t["project_id"] == p["id"]
        )} for p in db["projects"]]

    def active(self) -> dict:
        db = self.store.read()
        for project in db["projects"]:
            if project["id"] == db["active_id"]:
                return project
        return db["projects"][0]

    def set_active(self, project_id: str) -> dict | None:
        def edit(db):
            if any(p["id"] == project_id for p in db["projects"]):
                db["active_id"] = project_id
        self.store.update(edit)
        return self.active()

    def create(self, name: str = "Untitled") -> dict:
        project = self._new_project(name or "Untitled")

        def edit(db):
            db["projects"].insert(0, project)
            db["active_id"] = project["id"]

        self.store.update(edit)
        return project

    def duplicate(self, project_id: str) -> dict | None:
        new_project = None

        def edit(db):
            nonlocal new_project
            source = next((p for p in db["projects"] if p["id"] == project_id), None)
            if not source:
                return
            new_project = self._new_project(f"{source['name']} 副本")
            new_project["notes"] = source.get("notes", "")
            db["projects"].insert(0, new_project)
            for old in [t for t in db["tasks"].values() if t["project_id"] == project_id]:
                task = dict(old)
                task["id"] = _uid("t")
                task["project_id"] = new_project["id"]
                task["created_at"] = _now()
                db["tasks"][task["id"]] = task
            db["active_id"] = new_project["id"]

        self.store.update(edit)
        return new_project

    def get(self, project_id: str) -> dict | None:
        for project in self.list():
            if project.get("id") == project_id:
                return project
        return None

    def output_folder(self, project_id: str):
        """项目输出目录：data/<项目名>_opt（不存在就建）。"""
        from config import project_output_dir
        project = self.get(project_id) or self.active()
        folder = project_output_dir(project.get("name", "Untitled"))
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def rename(self, project_id: str, name: str) -> dict | None:
        from config import project_output_dir
        old_name = (self.get(project_id) or {}).get("name", "")
        name = (name or "").strip()[:60] or "Untitled"
        result = None

        def edit(db):
            nonlocal result
            for project in db["projects"]:
                if project["id"] == project_id:
                    project["name"] = name
                    project["updated_at"] = _now()
                    result = project

        self.store.update(edit)
        # 项目改名后，把旧的 <旧名>_opt 目录改名，保证作品链接不失效
        try:
            if old_name and old_name != name and result:
                src = project_output_dir(old_name)
                dst = project_output_dir(name)
                if src.is_dir() and not dst.exists():
                    src.rename(dst)
        except OSError:
            pass
        return result

    def set_notes(self, project_id: str, notes: str) -> dict | None:
        """保存文本模式的笔记，跟着项目走。"""
        text = str(notes or "")[:200000]
        result = None

        def edit(db):
            nonlocal result
            for project in db["projects"]:
                if project["id"] == project_id:
                    project["notes"] = text
                    project["updated_at"] = _now()
                    result = project

        self.store.update(edit)
        return result

    def delete(self, project_id: str) -> bool:
        import shutil
        from config import project_output_dir

        name = (self.get(project_id) or {}).get("name", "")
        removed_tasks = []

        def edit(db):
            if len(db["projects"]) <= 1:
                return
            db["projects"] = [p for p in db["projects"] if p["id"] != project_id]
            for task in list(db["tasks"].values()):
                if task["project_id"] == project_id:
                    removed_tasks.append(task["id"])
                    db["tasks"].pop(task["id"], None)
            if db["active_id"] == project_id:
                db["active_id"] = db["projects"][0]["id"]

        self.store.update(edit)
        # 项目文件夹 data/<项目名>_opt 整个删掉
        if name:
            shutil.rmtree(project_output_dir(name), ignore_errors=True)
        # 旧目录 static/outputs 下属于该项目的任务文件夹也清理
        from config import OUTPUT_DIR
        for task_id in removed_tasks:
            shutil.rmtree(OUTPUT_DIR / task_id, ignore_errors=True)
        return True

    # ---------- 任务 ----------
    def add_task(self, task: dict) -> None:
        self.store.update(lambda db: db["tasks"].__setitem__(task["id"], task))

    def update_task(self, task_id: str, **changes) -> dict | None:
        result = None

        def edit(db):
            nonlocal result
            task = db["tasks"].get(task_id)
            if task:
                task.update(changes)
                task["updated_at"] = _now()
                result = dict(task)

        self.store.update(edit)
        return result

    def get_task(self, task_id: str) -> dict | None:
        return self.store.read()["tasks"].get(task_id)

    def tasks_for(self, project_id: str) -> list:
        db = self.store.read()
        tasks = [t for t in db["tasks"].values() if t["project_id"] == project_id]
        tasks.sort(key=lambda t: t["created_at"], reverse=True)
        # 记录里没图、但作品目录里躺着文件（进程被杀 / 旧版本写库失败 / 手动挪过文件）：
        # 自动按文件名补回 images，避免刷新后卡片和画布节点空掉
        for task in tasks:
            if task.get("status") == "done" and not (task.get("images") or []):
                self._recover_images(task)
        return tasks

    MEDIA_SUFFIX = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
                    ".mp4", ".webm", ".mov", ".mkv",
                    ".mp3", ".wav", ".flac", ".ogg", ".m4a"}

    def _recover_images(self, task: dict) -> None:
        """作品目录里有文件但任务记录没记上：把地址补回记录。"""
        from urllib.parse import quote
        from config import project_output_dir

        project = self.get(task.get("project_id", "")) or self.active()
        folder = project_output_dir(project.get("name", "Untitled")) / task["id"]
        if not folder.is_dir():
            return
        files = sorted(
            (f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in self.MEDIA_SUFFIX),
            key=lambda f: f.name,
        )
        if not files:
            return
        urls = [f"/api/output/{quote(folder.parent.name)}/{task['id']}/{quote(f.name)}"
                for f in files]
        changes = {"images": urls}
        size = _image_size(files[0])
        if size:
            changes["width"], changes["height"] = size
        self.update_task(task["id"], **changes)
        task.update(changes)
        print(f"[补图] {task['id']} 记录里没有图片，已从磁盘补回 {len(urls)} 个", flush=True)

    def delete_task(self, task_id: str) -> bool:
        self.store.update(lambda db: db["tasks"].pop(task_id, None))
        return True

    def delete_batch(self, project_ids) -> int:
        """批量删除项目；至少保留一个。"""
        removed = 0

        def edit(db):
            nonlocal removed
            ids = set(project_ids) & {p["id"] for p in db["projects"]}
            if len(ids) >= len(db["projects"]):
                ids = set(list(ids)[:len(db["projects"]) - 1])
            if not ids:
                return
            db["projects"] = [p for p in db["projects"] if p["id"] not in ids]
            for task_id in [t["id"] for t in db["tasks"].values()
                            if t["project_id"] in ids]:
                db["tasks"].pop(task_id, None)
            if db["active_id"] in ids:
                db["active_id"] = db["projects"][0]["id"]
            removed = len(ids)

        self.store.update(edit)
        return removed

    def clear_finished_tasks(self, project_id: str) -> int:
        """只隐藏已结束的进度记录；任务与图片卡完整保留。"""
        finished = {"done", "error", "cancelled"}
        cleared_at = _now()
        count = 0

        def edit(db):
            nonlocal count
            for project in db["projects"]:
                if project["id"] == project_id:
                    last = int(project.get("progress_cleared_at", 0))
                    count = sum(
                        1 for task in db["tasks"].values()
                        if task["project_id"] == project_id
                        and task["status"] in finished
                        and task["created_at"] > last
                    )
                    project["progress_cleared_at"] = cleared_at
                    project["updated_at"] = cleared_at

        self.store.update(edit)
        return count
