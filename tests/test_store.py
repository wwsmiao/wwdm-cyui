# -*- coding: utf-8 -*-
"""store 存储层测试套件：迁移 / 分文件 / 备份 / 删除联动 / 对账 / 写保护。

背景：图库数据曾三次意外丢失（索引与文件不一致、静默失败、备份被覆盖），
这些用例把当时的修复固化下来，每次发版前跑一遍，防止回归。
运行：D:/python312/python.exe -m pytest tests/ -v
"""
import json
import os

import pytest

from conftest import REPO


def _write_legacy_history(data_dir, sessions, gallery):
    """造一份旧版 history.json（迁移测试的输入）"""
    data = {"sessions": sessions, "gallery": gallery}
    (data_dir / "history.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _gallery_item(gid="g1", url="/results/a.png", pid="p1", sid=""):
    return {"id": gid, "url": url, "prompt_id": pid, "mode": "text2img",
            "prompt": "测试图", "params": {}, "session_id": sid,
            "skill": "文生图", "name": "测试图", "ts": 1000.0,
            "width": 64, "height": 64, "remote": None, "subfolder": "cyui"}


def _touch_results(data_dir, name):
    p = data_dir / "results" / name
    p.write_bytes(b"png")
    return str(p)


# ---------- 迁移 ----------

def test_legacy_migration_creates_split_files(data_dir, store):
    _write_legacy_history(data_dir, [{"id": "s1", "title": "旧会话", "messages": []}],
                          [_gallery_item()])
    store.init()
    assert os.path.exists(data_dir / "sessions.json")
    assert os.path.exists(data_dir / "gallery.json")
    assert len(store.list_sessions()) == 1
    assert len(store.list_gallery(400)) == 1


def test_legacy_file_renamed_not_deleted(data_dir, store):
    _write_legacy_history(data_dir, [], [])
    store.init()
    migrated = [f for f in os.listdir(data_dir) if ".migrated-" in f]
    assert migrated, "旧 history.json 必须改名保留，不能删除"


def test_migration_writes_immediately(data_dir, store):
    """迁移后必须立即落盘：旧文件已改名，若不落盘崩溃即丢数据"""
    _write_legacy_history(data_dir, [{"id": "s1", "title": "旧", "messages": []}], [])
    store.init()
    data = json.loads((data_dir / "sessions.json").read_text(encoding="utf-8"))
    assert data.get("sessions"), "迁移后 sessions.json 必须有内容"


# ---------- 分文件 / 备份 ----------

def test_split_files_written_separately(data_dir, store):
    store.init()
    store.new_session("测试")
    store.add_gallery([_gallery_item()])
    assert os.path.exists(data_dir / "sessions.json")
    assert os.path.exists(data_dir / "gallery.json")
    # gallery.json 里不应混入 sessions（字段隔离）
    g = json.loads((data_dir / "gallery.json").read_text(encoding="utf-8"))
    assert set(g.keys()) == {"gallery"}


def test_sessions_rolling_backup_max3(data_dir, store):
    store.init()
    for i in range(6):                      # 写盘 6 次，备份只留 3 份
        store.new_session("会话%d" % i)
    baks = sorted(f for f in os.listdir(data_dir) if f.startswith("sessions.json.bak"))
    assert len(baks) == 3, "sessions 备份应滚动保留 3 份，实际 %s" % baks


def test_gallery_never_backed_up(data_dir, store):
    """用户决策：图库不备份，删除即真删"""
    store.init()
    store.add_gallery([_gallery_item()])
    store.new_session("触发一次写盘")
    gbaks = [f for f in os.listdir(data_dir) if "gallery.json.bak" in f]
    assert not gbaks, "gallery 不应有任何备份文件"


# ---------- 删除联动 ----------

def test_gallery_delete_removes_result_file(data_dir, store):
    store.init()
    _touch_results(data_dir, "a.png")
    store.add_gallery([_gallery_item(url="/results/a.png")])
    res = store.delete_gallery_items(["g1"])
    assert res["gallery"] == ["g1"]
    assert not (data_dir / "results" / "a.png").exists(), "删图必须删 results 副本"
    assert res.get("items"), "响应必须带完整被删条目（routes 用来删 ComfyUI 原图）"


def test_gallery_delete_failed_file_collected(data_dir, store):
    """results 文件不存在时视为成功（不是失败），failed_files 为空"""
    store.init()
    store.add_gallery([_gallery_item(url="/results/ghost.png")])   # 无对应文件
    res = store.delete_gallery_items(["g1"])
    assert res["gallery"] == ["g1"]
    assert res.get("failed_files") == []


def test_session_delete_removes_gallery_and_files(data_dir, store):
    store.init()
    _touch_results(data_dir, "a.png")
    store.new_session("会话")
    sid = store.list_sessions()[0]["id"]
    store.add_gallery([_gallery_item(sid=sid, url="/results/a.png")])
    res = store.delete_sessions([sid])
    assert res["sessions"] == [sid]
    assert not (data_dir / "results" / "a.png").exists(), "删会话必须连带删作品副本"
    assert store.list_gallery(400) == []


# ---------- 对账 ----------

def test_reconcile_recovers_orphans(data_dir, store):
    """results 里有、索引里没有的图片 → init 时自动恢复进图库"""
    _touch_results(data_dir, "orphan.png")
    _write_legacy_history(data_dir, [], [])
    store.init()
    items = store.list_gallery(400)
    assert len(items) == 1
    assert items[0]["url"] == "/results/orphan.png"
    assert items[0].get("skill") == "导入"


def test_reconcile_no_duplicates(data_dir, store):
    """索引里已有的文件不会被重复收录"""
    _touch_results(data_dir, "a.png")
    _write_legacy_history(data_dir, [], [_gallery_item(url="/results/a.png")])
    store.init()
    assert len(store.list_gallery(400)) == 1


# ---------- 写保护 ----------

def test_empty_state_write_refused(data_dir, store):
    """内存空 + 磁盘有内容：必须拒绝写盘（防未加载状态覆盖真实数据）"""
    _write_legacy_history(data_dir, [{"id": "s1", "title": "真数据", "messages": []}], [])
    store.init()
    # 模拟加载失败后的空内存：直接改 _state 再保存
    store._state["sessions"] = []
    store._state["gallery"] = []
    ok = store._save()
    assert ok is False, "空状态覆盖有数据的磁盘必须被拒绝"
    migrated = [f for f in os.listdir(data_dir) if ".migrated-" in f]
    assert migrated and (data_dir / migrated[0]).stat().st_size > 2, "真实数据必须还在"


def test_write_refused_before_init(data_dir, store):
    """未 init 就保存：拒绝（防脚本误用覆盖数据）"""
    _write_legacy_history(data_dir, [{"id": "s1", "messages": []}], [])
    store._state = {"sessions": [], "gallery": []}
    assert store._save() is False


# ---------- 图库上限 ----------

def test_gallery_cap_400(data_dir, store):
    store.init()
    items = []
    for i in range(405):
        items.append(_gallery_item(gid="g%d" % i, pid="p%d" % i))
    store.add_gallery(items)
    assert len(store.list_gallery(400)) <= 400
