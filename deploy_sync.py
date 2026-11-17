# -*- coding: utf-8 -*-
"""部署同步脚本：把本仓库的代码同步到便携部署目录。

典型部署形态（跨电脑便携包，见 deploy/README 说明）：

    <包根>/                       ← start.bat 所在目录
    ├─ python312/                 ← 便携 Python
    └─ ComfyUI/
       ├─ launch.py               ← deploy/launch.py
       └─ wwdm-cyui/              ← CYUI 代码（本脚本的目标）

用法（在 D:\\wwdm-cyui 仓库根目录）：
    python deploy_sync.py <部署目录>
    python deploy_sync.py G:\\wwdm-cyui\\ComfyUI\\wwdm-cyui
    python deploy_sync.py --list <部署目录>      # 只看会同步什么

安全红线：
  * data/（用户图库、会话、配置）永不复制、永不覆盖 —— 新部署目录会自动建空 data/
  * venv/、__pycache__、dist_update、backups 一律排除
  * 复制前把目标里被覆盖的代码备份到 <部署目录>/../code_backup_<时间戳>/
"""

import argparse
import os
import shutil
import sys
import time

REPO = os.path.dirname(os.path.abspath(__file__))

SYNC_DIRS = ["app", "static", "templates", "docs"]
SYNC_FILES = ["run.py", "requirements.txt", "make_release.py", "README.md", ".gitignore"]
EXCLUDE_DIR_NAMES = {"__pycache__", "venv", "data", "backups", "dist_update", ".git", "deploy"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".log")


def collect():
    files = []
    for d in SYNC_DIRS:
        base = os.path.join(REPO, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in EXCLUDE_DIR_NAMES]
            for fn in filenames:
                if fn.endswith(EXCLUDE_SUFFIX) or fn.startswith("_"):
                    continue
                files.append(os.path.relpath(os.path.join(dirpath, fn), REPO))
    for fn in SYNC_FILES:
        if os.path.exists(os.path.join(REPO, fn)):
            files.append(fn)
    return sorted(set(files))


def backup_target(dest_root, rel_files):
    ts = time.strftime("%Y%m%d_%H%M%S")
    bdir = os.path.join(os.path.dirname(dest_root.rstrip("\\/")),
                        "code_backup_%s" % ts)
    backed = 0
    for rel in rel_files:
        src = os.path.join(dest_root, rel)
        if os.path.exists(src):
            dst = os.path.join(bdir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            backed += 1
    return bdir, backed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", help="部署目录（如 G:\\wwdm-cyui\\ComfyUI\\wwdm-cyui）")
    ap.add_argument("--list", action="store_true", help="只列出会同步的文件")
    args = ap.parse_args()

    dest = os.path.abspath(args.dest)
    files = collect()
    if args.list:
        print("将同步 %d 个文件 → %s" % (len(files), dest))
        for f in files:
            print("  " + f)
        return

    if not os.path.isdir(dest):
        os.makedirs(dest, exist_ok=True)

    # 1) 备份目标里将被覆盖的旧代码
    will_overwrite = [f for f in files if os.path.exists(os.path.join(dest, f))]
    if will_overwrite:
        bdir, backed = backup_target(dest, will_overwrite)
        print("已备份 %d 个旧文件 → %s" % (backed, bdir))

    # 2) 复制（data/ 不在清单里，物理上不可能被覆盖）
    for rel in files:
        src = os.path.join(REPO, rel)
        dst = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

    # 3) 部署目录保证有 data/（首次部署自动建）
    os.makedirs(os.path.join(dest, "data", "results"), exist_ok=True)

    print("同步完成：%d 个文件 → %s" % (len(files), dest))
    print("data/ 未触碰。重启 CYUI（start.bat）后生效。")


if __name__ == "__main__":
    main()
