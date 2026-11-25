"""画布布局持久化：每个项目一份，存后端而不是只放浏览器 localStorage。

以前布局只写 localStorage：换浏览器 / 换域名（127.0.0.1 与 localhost）/ 清缓存之后，
画布上的节点和已经生成的结果就都没了。现在以服务端为准，localStorage 只当首屏缓存：

  · 打开页面先用本地缓存立刻渲染，再拉服务端覆盖（解决白屏跳动）
  · 任何改动防抖写回服务端，刷新 / 换浏览器都能看到同样的画布
  · 服务端没有、本地有时（老版本数据）自动把本地推上去做迁移
"""
import json

from config import DATA_DIR
from core.store import JsonStore

MAX_BYTES = 8 * 1024 * 1024      # 单个项目布局上限，防止异常数据把文件撑爆


class CanvasLayouts:
    def __init__(self, path=None):
        self.store = JsonStore(path or (DATA_DIR / "canvas_layouts.json"), {"layouts": {}})

    def get(self, project_id: str) -> dict:
        if not project_id:
            return {}
        data = (self.store.read().get("layouts") or {}).get(project_id)
        return data if isinstance(data, dict) else {}

    def has(self, project_id: str) -> bool:
        """这个项目有没有在服务端存过布局（区分「没存过」和「存过但内容为空」）。"""
        if not project_id:
            return False
        return project_id in (self.store.read().get("layouts") or {})

    def save(self, project_id: str, layout: dict) -> bool:
        if not project_id or not isinstance(layout, dict):
            return False
        try:
            size = len(json.dumps(layout, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            return False
        if size > MAX_BYTES:
            return False

        def edit(db):
            db.setdefault("layouts", {})[project_id] = layout

        self.store.update(edit)
        return True

    def drop(self, project_id: str) -> None:
        if not project_id:
            return

        def edit(db):
            (db.get("layouts") or {}).pop(project_id, None)

        self.store.update(edit)

    def drop_many(self, project_ids) -> None:
        ids = set(project_ids or [])
        if not ids:
            return

        def edit(db):
            layouts = db.get("layouts") or {}
            for pid in ids:
                layouts.pop(pid, None)

        self.store.update(edit)
