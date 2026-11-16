# -*- coding: utf-8 -*-
"""发布打包脚本：生成更新包 zip + sha256，供网盘上传。

用法（在项目根目录）：
    D:/python312/python.exe make_release.py            # 用 app/version.py 里当前版本号
    D:/python312/python.exe make_release.py --version 1.0.1
    D:/python312/python.exe make_release.py --list     # 只看会打包什么，不写文件

产物：dist_update/wwdm-cyui_<版本>_update.zip 与同名 .sha256
更新范围与 app/updater.py 的 ALLOWED_TOP 白名单严格一致：
    app/  static/  templates/  docs/  run.py  requirements.txt
永不打包：data/（用户图库）、venv/、backups/、__pycache__、临时文件。
"""

import argparse
import hashlib
import io
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, "dist_update")

INCLUDE_DIRS = ["app", "static", "templates", "docs"]
INCLUDE_FILES = ["run.py", "requirements.txt"]
EXCLUDE_PARTS = {"__pycache__", ".git", "venv", "backups", "data", "dist_update"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".log", ".bak")


def read_version():
    with io.open(os.path.join(ROOT, "app", "version.py"), encoding="utf-8") as f:
        m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', f.read())
    if not m:
        raise SystemExit("无法从 app/version.py 读取 APP_VERSION")
    return m.group(1)


def collect():
    files = []
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in EXCLUDE_PARTS]
            for fn in filenames:
                if fn.endswith(EXCLUDE_SUFFIX) or fn.startswith("_"):
                    continue
                files.append(os.path.relpath(os.path.join(dirpath, fn), ROOT))
    for fn in INCLUDE_FILES:
        p = os.path.join(ROOT, fn)
        if os.path.exists(p):
            files.append(fn)
    return sorted(set(files))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", help="覆盖版本号（不改 version.py，只影响文件名）")
    ap.add_argument("--list", action="store_true", help="只列出打包内容")
    args = ap.parse_args()

    ver = args.version or read_version()
    files = collect()
    if args.list:
        print("共 %d 个文件：" % len(files))
        for f in files:
            print("  " + f)
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    zpath = os.path.join(OUT_DIR, "wwdm-cyui_%s_update.zip" % ver)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in files:
            zf.write(os.path.join(ROOT, rel), rel.replace("\\", "/"))

    h = hashlib.sha256()
    with open(zpath, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    with io.open(zpath + ".sha256", "w", encoding="utf-8") as f:
        f.write(digest + "  " + os.path.basename(zpath) + "\n")

    size_mb = os.path.getsize(zpath) / 1048576.0
    print("已生成：%s（%.2f MB，%d 个文件）" % (zpath, size_mb, len(files)))
    print("sha256：%s" % digest)
    print()
    print("发版三步：")
    print("  1. 确认 app/version.py 的 APP_VERSION 已改为 %s" % ver)
    print("  2. 把 zip 上传网盘，拿到直链，更新 app/version.py 的 DOWNLOAD_URL")
    print("  3. 买家：帮助页 → 下载 zip → 「选择更新包并应用」→ 重启")


if __name__ == "__main__":
    main()
