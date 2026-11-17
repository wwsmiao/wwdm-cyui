# -*- coding: utf-8 -*-
"""store 存储层测试的公共夹具：每个用例一个干净的临时 data 目录。

CYUI_DATA_DIR 必须在 import app.* 之前设置（DATA_DIR 在包导入时固化），
因此这里把 app 及相关模块从 sys.modules 中弹出后重新导入，保证
DATA_DIR / _FILE 等模块级常量指向用例自己的临时目录。
"""
import json
import os
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)


@pytest.fixture()
def store_env(tmp_path, monkeypatch):
    """独立临时 data 目录 + 全新加载的 store 模块，yield (路径, 模块)"""
    d = tmp_path / "data"
    (d / "results").mkdir(parents=True)
    monkeypatch.setenv("CYUI_DATA_DIR", str(d))
    # 弹出后重新 import：app 包与 store 的模块级常量随环境变量重算
    for mod in list(sys.modules):
        if mod == "app" or mod.startswith("app."):
            sys.modules.pop(mod, None)
    import importlib
    importlib.invalidate_caches()
    from app import store
    yield d, store
    # 释放实例锁（文件句柄），避免 Windows 上目录删不掉
    if getattr(store, "_lock_fh", None):
        try:
            store._lock_fh.close()
        except Exception:
            pass


@pytest.fixture()
def data_dir(store_env):
    return store_env[0]


@pytest.fixture()
def store(store_env):
    return store_env[1]
