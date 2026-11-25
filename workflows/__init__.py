"""工作流注册表：自动发现同目录下的每个工作流模块。

新增工作流只要在本目录放一个 .py，模块里给 `WORKFLOW` 赋值即可，不用改这里。
"""
import importlib
import pkgutil

# 非工作流模块，跳过
_SKIP = {"base"}


def discover() -> dict:
    registry = {}
    for info in pkgutil.iter_modules(__path__):
        if info.name in _SKIP or info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{__name__}.{info.name}")
        workflow = getattr(module, "WORKFLOW", None)
        if workflow is not None and getattr(workflow, "id", ""):
            registry[workflow.id] = workflow
    return registry


WORKFLOWS = discover()
