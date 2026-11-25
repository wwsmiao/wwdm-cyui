"""核心服务装配：在这里把各个独立模块接线成一台机器。"""
from config import DEFAULT_SETTINGS, SETTINGS_FILE, ensure_dirs
from core.agent import Agent
from core.ai import Assistant
from core.asset_library import AssetLibrary
from core.comfy import ComfyClient
from core.comfy_files import ComfyFiles
from core.grid_stitch import GridStitcher
from core.image_edit import ImageEditor
from core.instance import InstanceInfo
from core.layouts import CanvasLayouts
from core.images import ImageManager
from core.monitor import SystemMonitor
from core.progress import ComfyEventBus
from core.projects import ProjectManager
from core.store import JsonStore
from core.tasks import TaskManager
from core.workflows import WorkflowManager


def migrate_project_outputs(projects) -> int:
    """把旧作品目录 static/outputs/<task> 搬到 data/<项目名>_opt/<task>，并改写地址。"""
    import shutil
    from urllib.parse import quote
    from config import DATA_DIR, OUTPUT_DIR, project_folder_name

    db = projects.store.read()
    names = {p["id"]: p.get("name", "Untitled") for p in db.get("projects") or []}
    moved = 0

    def edit(state):
        nonlocal moved
        for task in (state.get("tasks") or {}).values():
            images = task.get("images") or []
            changed = False
            rewritten = []
            for url in images:
                text = str(url)
                if not text.startswith("/static/outputs/"):
                    rewritten.append(url)
                    continue
                rest = text[len("/static/outputs/"):]
                task_dir, _, filename = rest.partition("/")
                if not task_dir or not filename:
                    rewritten.append(url)
                    continue
                project_name = names.get(task.get("project_id"))
                if not project_name:
                    rewritten.append(url)
                    continue
                folder_name = project_folder_name(project_name)
                src = OUTPUT_DIR / task_dir
                dst = DATA_DIR / folder_name / task_dir
                if src.is_dir() and not dst.exists():
                    try:
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(src), str(dst))
                        moved += 1
                    except OSError:
                        rewritten.append(url)
                        continue
                if not (dst / filename).is_file():
                    rewritten.append(url)
                    continue
                rewritten.append(f"/api/output/{quote(folder_name)}/{task_dir}/{filename}")
                changed = True
            if changed:
                task["images"] = rewritten

    projects.store.update(edit)
    return moved


def build_services() -> dict:
    ensure_dirs()
    settings_store = JsonStore(SETTINGS_FILE, DEFAULT_SETTINGS)

    def settings() -> dict:
        return settings_store.read()

    def comfy_url() -> str:
        return settings()["comfy_url"]

    def client_id() -> str:
        return settings()["client_id"]

    projects = ProjectManager()
    # 旧作品目录迁移一次（幂等）：static/outputs → data/<项目名>_opt（失败不影响启动，也不打印）
    try:
        migrate_project_outputs(projects)
    except Exception:
        pass
    workflows = WorkflowManager()
    comfy = ComfyClient(comfy_url, client_id)
    files = ComfyFiles(comfy, settings)

    # 工作流改名迁移：旧的 minimax-h3-图生视频 已拆成 首帧/尾帧 两个工作流
    try:
        saved = settings_store.read()
        wp = saved.get("workflow_params") or {}
        if "minimax-h3-图生视频" in wp:
            wp["minimax-h3-首帧生视频"] = wp.pop("minimax-h3-图生视频")

            def _migrate(db):
                # update 只合并不删除，必须整体替换才能清掉旧键
                db["workflow_params"].clear()
                db["workflow_params"].update(wp)

            settings_store.update(_migrate)
    except Exception:
        pass

    library = AssetLibrary(files)
    # 实例能力探测：按 comfy_url 缓存可用节点 / 模型，远程实例缺什么一目了然
    instance = InstanceInfo(comfy)
    layouts = CanvasLayouts()
    tasks = TaskManager(projects, workflows, comfy, settings)
    tasks.instance = instance
    # 纯 Python 工作流（网格拼接）用的本地执行器：任务路由到 _run_python 时用它
    stitcher = GridStitcher(projects, files, library)
    tasks.stitcher = stitcher
    ai = Assistant(settings, workflows, comfy, tasks, files)
    images = ImageManager(projects)
    agent = Agent(settings_store)
    editor = ImageEditor(projects)
    monitor = SystemMonitor(comfy)
    bus = ComfyEventBus(comfy_url, client_id, tasks.on_event)
    bus.start()

    # 服务重启后找回没跑完的任务（结果已在 ComfyUI 里就直接落盘，仍在跑就重新挂进度）
    try:
        tasks.recover()
    except Exception:
        pass

    return {
        "settings_store": settings_store,
        "projects": projects,
        "workflows": workflows,
        "comfy": comfy,
        "tasks": tasks,
        "images": images,
        "editor": editor,
        "stitcher": stitcher,
        "instance": instance,
        "layouts": layouts,
        "files": files,
        "library": library,
        "monitor": monitor,
        "ai": ai,
        "agent": agent,
        "bus": bus,
    }
