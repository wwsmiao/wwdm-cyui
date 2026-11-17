# -*- coding: utf-8 -*-
"""会话 / 作品持久化（纯 JSON，无数据库依赖）"""
import io
import json
import os
import re
import shutil
import threading
import time
import uuid

from . import DATA_DIR, RESULTS_DIR

try:
    from .filelog import write as _flog
except ImportError:
    _flog = None


def _elog(msg, level="INFO"):
    """store 关键事件落盘（filelog 独立模块，无循环导入）"""
    if _flog:
        try:
            _flog(msg, level)
        except Exception:
            pass

# ---------- 回收站删除 ----------
# 用户要求：删除图片 = 送 Windows 回收站（可恢复），不做回滚手段。
# 文件被占用（Windows 文件锁）时删除失败不再静默——返回失败并带原因，
# 由 routes 汇总进响应，前端弹窗告知用户。

if os.name == "nt":
    import ctypes
    from ctypes import wintypes as _wt

    class _SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", _wt.HWND), ("wFunc", ctypes.c_uint),
                    ("pFrom", ctypes.c_wchar_p), ("pTo", ctypes.c_wchar_p),
                    ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", _wt.BOOL),
                    ("hNameMappings", ctypes.c_void_p),
                    ("lpszProgressTitle", ctypes.c_wchar_p)]

    _FO_DELETE = 3
    _FOF_ALLOWUNDO = 0x40       # 送回收站（而非直接销毁）
    _FOF_NOCONFIRMATION = 0x10  # 不弹系统确认
    _FOF_SILENT = 0x04          # 不显示系统进度框
    _FOF_NOERRORUI = 0x400      # 失败不弹系统 UI，由返回码自己处理


def to_recycle_bin(path):
    """把单个文件送入 Windows 回收站。

    返回 (True, None) 成功；(False, 原因) 失败——被占用 / 不存在 / 系统拒绝。
    非 Windows 平台退化为直接删除。
    """
    path = str(path or "")
    if os.name != "nt":
        try:
            os.remove(path)
            return True, None
        except OSError as e:
            return False, str(e)
    if not path or not os.path.isfile(path):
        return False, "文件不存在"
    op = _SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = _FO_DELETE
    op.pFrom = path + '\0'      # 双 NUL 终止路径列表
    op.pTo = None
    op.fFlags = _FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_SILENT | _FOF_NOERRORUI
    try:
        r = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    except Exception as e:
        return False, str(e)[:120]
    if r == 0 and not op.fAnyOperationsAborted:
        return True, None
    if op.fAnyOperationsAborted:
        return False, "操作被系统中止"
    # 常见错误码：120=DE_ACCESSDENIEDSRC（被占用/权限），117=DE_OPSOURCEERROR
    reason = {32: "文件正被其他程序占用", 120: "文件正被其他程序占用",
              117: "系统删除失败"}.get(r, "系统错误码 %d" % r)
    return False, reason

_FILE = os.path.join(DATA_DIR, "history.json")          # 旧版单文件（只读迁移来源）
_SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
_GALLERY_FILE = os.path.join(DATA_DIR, "gallery.json")
_LOCK_FILE = os.path.join(DATA_DIR, ".cyui.lock")
_BACKUP_KEEP = 3                                        # sessions 滚动备份份数
_lock = threading.Lock()
_state = {"sessions": [], "gallery": []}
# 同一份 data 目录只允许一个实例写入：
# 曾经有两个进程各自持有一份内存状态（其中一个是很久以前启动的旧进程，
# 内存里还是空数据），任一方保存就会把对方的数据整份覆盖掉。
_READONLY = False
_lock_fh = None
# init() 是否已把磁盘数据载入内存。没载入就写盘 = 用空/半截状态覆盖真实数据。
# 曾经脚本里直接 import store 后调 ensure_session（没走 init），
# _state 还是空的默认值，一保存就把 history.json 冲成一条测试会话。
_READY = False


def _acquire_instance_lock():
    """抢占数据目录独占锁；抢不到就只读，绝不再写 history.json"""
    global _READONLY, _lock_fh
    if _lock_fh is not None:
        return          # 同进程内重复 init（如测试里建多个 app）不重复抢锁
    try:
        fh = open(_LOCK_FILE, "a+")
    except Exception as e:
        print("[store] 无法创建实例锁文件，按只读处理: %s" % e, flush=True)
        _READONLY = True
        return
    try:
        try:
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        except ImportError:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_fh = fh          # 持有到进程退出，锁由操作系统自动释放
        try:
            fh.seek(0)
            fh.truncate()
            fh.write(str(os.getpid()))
            fh.flush()
        except Exception:
            pass
    except Exception:
        _READONLY = True
        try:
            fh.close()
        except Exception:
            pass
        print("[store] ⚠ 同一份 data 目录已被另一个 CYUI 实例占用，本实例以【只读】启动，"
              "不会写入 history.json。需要写入请先关掉另一个实例。", flush=True)


def _backup_sessions():
    """sessions.json 写盘前做滚动备份（保留最近 _BACKUP_KEEP 份）。

    图库（gallery.json）不备份：用户明确要求「删除就直接删除」，作品的生命周期
    以用户操作为准，不需要历史回滚；孤儿文件由 init 时的对账机制兜底。
    """
    try:
        if not os.path.exists(_SESSIONS_FILE) or os.path.getsize(_SESSIONS_FILE) <= 2:
            return
        # 轮换：bak3 ← bak2 ← bak1 ← 当前
        oldest = "%s.bak%d" % (_SESSIONS_FILE, _BACKUP_KEEP)
        if os.path.exists(oldest):
            os.remove(oldest)
        for i in range(_BACKUP_KEEP - 1, 0, -1):
            src = "%s.bak%d" % (_SESSIONS_FILE, i)
            if os.path.exists(src):
                os.replace(src, "%s.bak%d" % (_SESSIONS_FILE, i + 1))
        shutil.copy2(_SESSIONS_FILE, _SESSIONS_FILE + ".bak1")
    except Exception as e:
        print("[store] sessions 备份失败（继续保存）: %s" % e, flush=True)


def _load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)
    _acquire_instance_lock()
    global _state
    legacy_exists = os.path.exists(_FILE)
    _migrated = False
    if os.path.exists(_SESSIONS_FILE) or os.path.exists(_GALLERY_FILE):
        # 新版分文件存储：两份分别加载，一份损坏不影响另一份
        sessions, gallery = [], []
        for path, key, label in ((_SESSIONS_FILE, "sessions", "sessions.json"),
                                 (_GALLERY_FILE, "gallery", "gallery.json")):
            if not os.path.exists(path):
                continue
            try:
                loaded = _load_json(path).get(key, [])
                if key == "sessions":
                    sessions = loaded
                else:
                    gallery = loaded
            except Exception as e:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                keep = path + ".corrupt-" + stamp
                try:
                    shutil.copyfile(path, keep)
                except Exception:
                    keep = "(备份失败)"
                print("[store] ❌ %s 读取失败（%s），已另存为 %s 后按空数据继续。"
                      % (label, e, keep), flush=True)
                _elog("%s 读取失败：已另存 %s" % (label, keep), "ERROR")
        _state = {"sessions": sessions, "gallery": gallery}
    elif legacy_exists:
        # 旧版单文件 → 自动迁移成两个新文件，原文件改名保留
        try:
            data = _load_json(_FILE)
            _state = {
                "sessions": data.get("sessions", []),
                "gallery": data.get("gallery", []),
            }
            stamp = time.strftime("%Y%m%d-%H%M%S")
            os.replace(_FILE, _FILE + ".migrated-" + stamp)
            _migrated = True
        except Exception as e:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            keep = _FILE + ".corrupt-" + stamp
            try:
                shutil.copyfile(_FILE, keep)
            except Exception:
                keep = "(备份失败)"
            print("[store] ❌ history.json 读取失败（%s），已另存为 %s 后按空数据启动。"
                  "若确认原文件完好，请先修复它再启动。" % (e, keep), flush=True)
            _elog("history.json 读取失败：已另存 %s" % keep, "ERROR")
            _state = {"sessions": [], "gallery": []}
    elif not _READONLY:
        _save(force=True)      # 只读实例连空文件都不要创建，免得和持有锁的实例抢
    global _READY
    _READY = True          # 载入完成，之后才允许写盘
    if _migrated:
        # 迁移后立即落盘：旧文件已改名 .migrated-*，此刻崩溃的话数据只存在于内存
        _save()
        print("[store] 迁移数据已写入 sessions.json / gallery.json", flush=True)
    _dedupe_gallery()   # 清理历史遗留：前端轮询与后台回收线程竞态造成的重复记录
    n = reconcile_gallery_files()   # 双向对账：results 里有、索引里没有的图自动恢复显示
    if n:
        print("[store] 图库对账：从 data/results 恢复 %d 张未索引图片" % n, flush=True)
        _elog("图库对账恢复 %d 张孤儿图片" % n, "INFO")


# results 目录里认定为图片的扩展名（对账扫描用）
_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def reconcile_gallery_files():
    """双向对账（文件 → 图库）：data/results 里存在、但图库索引里没有的图片，
    自动补进图库显示。

    场景：图库索引被意外清空（文件完好却全不显示）、手工往 results 放图、
    历史上删索引时文件删除失败留下的孤儿。恢复条目只带最小元数据
    （文件名 / 修改时间 / 尺寸），prompt 与会话归属已不可考，skill 标为「导入」。
    返回恢复条数（0 = 无孤儿，不打扰日志）。
    """
    try:
        names = [n for n in os.listdir(RESULTS_DIR)
                 if os.path.splitext(n)[1].lower() in _IMG_EXTS
                 and os.path.isfile(os.path.join(RESULTS_DIR, n))]
    except OSError:
        return 0
    if not names:
        return 0
    known = set()
    for g in _state["gallery"]:
        u = str(g.get("url") or "")
        if u.startswith("/results/"):
            known.add(u[len("/results/"):])
    orphans = [n for n in names if n not in known]
    if not orphans:
        return 0
    try:
        from PIL import Image
    except ImportError:
        Image = None
    added = []
    for n in sorted(orphans):
        p = os.path.join(RESULTS_DIR, n)
        w = h = 0
        if Image:
            try:
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                pass
        added.append({
            "id": uuid.uuid4().hex[:10],
            "url": "/results/" + n,
            "name": os.path.splitext(n)[0][:32],
            "skill": "导入",
            "mode": "",
            "prompt": "",
            "params": {},
            "session_id": "",
            "ts": os.stat(p).st_mtime,
            "width": w, "height": h,
            "x": 0, "y": 0, "scale": 1,
        })
    with _lock:
        _state["gallery"].extend(added)
        # 按 ts 倒序融入整体时序（与 add_gallery 的 insert(0)「新图在前」语义一致）
        _state["gallery"].sort(key=lambda g: g.get("ts") or 0, reverse=True)
        _save()
    return len(added)


def _dedupe_gallery():
    """同一 prompt_id 只保留一条记录（重复记录是任务收拢竞态的产物）"""
    with _lock:
        seen = set()
        out = []
        changed = False
        for g in _state["gallery"]:
            pid = g.get("prompt_id")
            if pid:
                if pid in seen:
                    changed = True
                    continue
                seen.add(pid)
            out.append(g)
        if changed:
            _state["gallery"] = out
            _save()
            print("[store] 已清理重复图库记录", flush=True)


def _write_json(path, payload):
    """原子写一个 JSON 文件（临时文件名带 pid：两个实例同时写同一 .tmp 会互相锁住）"""
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _save(force=False):
    """写盘：sessions.json 与 gallery.json 分文件原子写入。

    只读实例跳过；未 init 不写；空状态不许覆盖有内容的文件；
    sessions 写前滚动备份；gallery 不备份（用户删除即真删）。
    """
    if _READONLY and not force:
        print("[store] 只读实例，跳过写入（避免覆盖另一个实例的数据）", flush=True)
        _elog("只读实例跳过写盘（另一实例持锁）", "WARN")
        return False
    if not _READY and not force:
        # 没有 init() 就没有从磁盘载入过真实数据，此处的内存状态是残缺的。
        # 写下去等于把用户所有会话与作品覆盖成半截内容，必须拒绝。
        print("[store] ⚠ 尚未 init()，拒绝写入（防止未加载状态覆盖数据文件）", flush=True)
        _elog("拒绝写盘：未 init", "WARN")
        return False
    empty = not _state.get("sessions") and not _state.get("gallery")
    if empty and not force:
        # 最后一道保险：内存空了但磁盘上有数据 —— 一定是加载失败或状态异常，
        # 这时候写下去就是「一键清空用户所有会话与作品」
        try:
            for p in (_SESSIONS_FILE, _GALLERY_FILE, _FILE):
                if os.path.exists(p) and os.path.getsize(p) > 64:
                    print("[store] ⚠ 拒绝写入空数据（磁盘上 %s 仍有内容），"
                          "请检查是否为多实例冲突" % os.path.basename(p), flush=True)
                    _elog("拒绝写盘：空状态保护（磁盘 %s 有内容）" % os.path.basename(p), "WARN")
                    return False
        except Exception:
            pass
    _backup_sessions()
    _write_json(_SESSIONS_FILE, {"sessions": _state.get("sessions") or []})
    _write_json(_GALLERY_FILE, {"gallery": _state.get("gallery") or []})
    return True


def _sid():
    return uuid.uuid4().hex[:10]


def new_session(title="新对话"):
    with _lock:
        s = {
            "id": _sid(),
            "title": title[:40],
            "created_at": time.time(),
            "updated_at": time.time(),
            "messages": [],
        }
        _state["sessions"].insert(0, s)
        _save()
        return dict(s)


def list_sessions():
    with _lock:
        return [
            {
                "id": s["id"],
                "title": s.get("title") or "新对话",
                "updated_at": s.get("updated_at") or s.get("created_at") or 0,
                "count": len(s.get("messages", [])),
            }
            for s in _state["sessions"]
        ]


def get_session(sid):
    with _lock:
        for s in _state["sessions"]:
            if s["id"] == sid:
                return json.loads(json.dumps(s))
    return None


def ensure_session(sid, title="新对话"):
    if sid and get_session(sid):
        return sid
    return new_session(title)["id"]


def add_message(sid, message, title=None):
    """message 为 dict，自动补 id / ts"""
    with _lock:
        for s in _state["sessions"]:
            if s["id"] == sid:
                m = dict(message)
                m.setdefault("id", uuid.uuid4().hex[:10])
                m.setdefault("ts", time.time())
                s["messages"].append(m)
                s["updated_at"] = time.time()
                if title and len(s["messages"]) <= 1:
                    s["title"] = title[:40]
                _save()
                return m
    return None


def update_message(sid, mid, patch):
    with _lock:
        for s in _state["sessions"]:
            if s["id"] == sid:
                for m in s["messages"]:
                    if m["id"] == mid:
                        m.update(patch)
                        s["updated_at"] = time.time()
                        _save()
                        return m
    return None


def last_ai_user(sid):
    """取会话里最后一条 source='ai' 的用户消息（只读，不改内容）。

    DeepSeek 链路：对话页必须保留用户自己打的那句话；扩写后的完整提示词
    存在生成卡的 prompt / final_prompt 里，由结果卡片的「完整提示词」展示。
    以前这里会把用户消息内容改写成扩写版，导致对话页显示的不是用户说的话。
    """
    if not sid:
        return None
    with _lock:
        for s in _state["sessions"]:
            if s["id"] == sid:
                for m in reversed(s["messages"]):
                    if m.get("role") == "user" and m.get("source") == "ai":
                        return m
    return None


def delete_session(sid):
    """删除会话，并联动删除该会话生成的作品（自由画布卡片）。

    返回 {"session": bool, "gallery": [被删作品 id]}，供前端同步刷新画布 / 图库。
    """
    with _lock:
        n = len(_state["sessions"])
        _state["sessions"] = [s for s in _state["sessions"] if s["id"] != sid]
        victims = [g for g in _state["gallery"] if g.get("session_id") == sid]
        if victims:
            _state["gallery"] = [g for g in _state["gallery"] if g.get("session_id") != sid]
            _save()
        # 联动删除必须落到磁盘：图库里删了，data/results 里的文件也要删（双向对账）
        for g in victims:
            _drop_result_file(g.get("url"))
        return {"session": n != len(_state["sessions"]), "gallery": [g["id"] for g in victims],
                "items": victims}


def delete_sessions(sids):
    """批量删除会话 + 联动作品。返回 {"sessions": [...], "gallery": [...]}"""
    ids = {str(x) for x in (sids or [])}
    if not ids:
        return {"sessions": [], "gallery": []}
    with _lock:
        hit = [s["id"] for s in _state["sessions"] if s["id"] in ids]
        _state["sessions"] = [s for s in _state["sessions"] if s["id"] not in ids]
        victims = [g for g in _state["gallery"] if g.get("session_id") in ids]
        if victims:
            _state["gallery"] = [g for g in _state["gallery"] if g.get("session_id") not in ids]
            _save()
        # 同 delete_session：联动删除落到磁盘，文件一并清掉
        for g in victims:
            _drop_result_file(g.get("url"))
        return {"sessions": hit, "gallery": [g["id"] for g in victims], "items": victims}


def rename_session(sid, title):
    with _lock:
        for s in _state["sessions"]:
            if s["id"] == sid:
                s["title"] = title[:40]
                _save()
                return True
    return False


def clear_sessions():
    """清空对话时，同样清掉这些对话产生的画布作品，保持二者相通。"""
    with _lock:
        ids = {s["id"] for s in _state["sessions"]}
        _state["sessions"] = []
        victims = [g for g in _state["gallery"] if g.get("session_id") in ids]
        if victims:
            _state["gallery"] = [g for g in _state["gallery"] if g.get("session_id") not in ids]
        _save()
        # 清空对话的联动删除同样落到磁盘
        for g in victims:
            _drop_result_file(g.get("url"))
        return {"sessions": len(ids), "gallery": [g["id"] for g in victims], "items": victims}


def add_gallery(items):
    """items: [{url, prompt_id, mode, prompt, params, ts, session_id}]

    自由画布需要 name / x / y / scale / session_id。name 在这里给默认值，
    坐标由前端首次进入画布时自动排布并回写（历史作品无坐标也能正常显示）。
    同一 prompt_id 只收一份：前端轮询与后台回收线程可能在完成瞬间竞态重复收拢。
    """
    with _lock:
        existing = {g.get("prompt_id") for g in _state["gallery"] if g.get("prompt_id")}
        for it in items:
            it = dict(it)
            it.setdefault("id", uuid.uuid4().hex[:10])
            pid = it.get("prompt_id")
            if pid and pid in existing:
                continue
            if pid:
                existing.add(pid)
            if not it.get("name"):
                base = (it.get("prompt") or "").strip().split("\n")[0] or "未命名作品"
                it["name"] = base[:32]
            _state["gallery"].insert(0, it)
        _state["gallery"] = _state["gallery"][:400]
        _save()


def list_gallery(limit=160):
    with _lock:
        return [dict(x) for x in _state["gallery"][:limit]]


# 结果卡片完成时后端自动写的那句文案，删图后要跟着改，避免「共 3 张」却没图
_AUTO_DONE_TEXT = re.compile(r"^(生成完成|高清放大完成|批量处理完成)，共 (\d+) 张$")


def _drop_result_file(url):
    """删除 data/results 下的本地副本（送 Windows 回收站，可恢复）。

    返回 (ok, failed_name, reason)：失败时 failed_name 为文件名、reason 给前端提示。
    """
    u = str(url or "")
    prefix = "/results/"
    if not u.startswith(prefix):
        return False, None, None
    name = u[len(prefix):]
    # 只接受纯文件名：带子目录、.. 、查询串的一律不动手，避免越界删除
    if not name or name != os.path.basename(name) or ".." in name:
        return False, None, None
    path = os.path.join(RESULTS_DIR, name)
    if not os.path.isfile(path):
        return True, None, None            # 本来就不在：视为成功
    ok, reason = to_recycle_bin(path)
    if ok:
        return True, None, None
    _elog("results 文件删除失败（%s）: %s" % (name, reason), "WARN")
    return False, name, reason


def delete_gallery_item(gid):
    """删除单张作品：图库 / 画布卡片 + data/results 里的本地图片。"""
    return delete_gallery_items([gid])


def delete_gallery_items(gids):
    """删除指定作品，返回 {"gallery": [...], "files": [...], "sessions": []}。

    只删这几张图本身——以前这里会连带删掉作品所属的**整个会话**以及该会话下的
    **所有作品**，于是「在图库删一张图」看起来像把对话和历史全清了。

    现在：图库卡片消失 + data/results 里的副本删除 + 对话里同一张图摘掉
    （文件已删，留着只会是一张破图），但**消息与会话都保留**。
    ComfyUI output 目录里的原图完全不碰。
    """
    targets = {str(x) for x in (gids or [])}
    if not targets:
        return {"gallery": [], "files": [], "sessions": []}
    with _lock:
        hit = [g for g in _state["gallery"] if g.get("id") in targets]
        if not hit:
            return {"gallery": [], "files": [], "sessions": []}
        removed = [g["id"] for g in hit]
        rm = set(removed)
        urls = {g.get("url") for g in hit if g.get("url")}
        _state["gallery"] = [g for g in _state["gallery"] if g.get("id") not in rm]

        # 对话里摘掉这几张图；消息本身和会话都留着
        for s in _state["sessions"]:
            touched = False
            for m in s.get("messages") or []:
                imgs = m.get("images") or []
                if not imgs:
                    continue
                keep = [i for i in imgs
                        if (i.get("url") if isinstance(i, dict) else i) not in urls]
                if len(keep) == len(imgs):
                    continue
                m["images"] = keep
                touched = True
                mt = _AUTO_DONE_TEXT.match((m.get("content") or "").strip())
                if not mt:
                    continue
                m["content"] = ("（图片已从图库删除）" if not keep
                                else "%s，共 %d 张" % (mt.group(1), len(keep)))
            if touched:
                s["updated_at"] = time.time()
        _save()

    failed = []
    files = []
    for u in urls:
        ok, fname, reason = _drop_result_file(u)
        if ok:
            files.append(u)
        elif fname:
            failed.append({"name": fname, "reason": reason})
    return {"gallery": removed, "files": files, "sessions": [], "items": hit,
            "failed_files": failed}


# 允许前端改写的白名单字段，避免把 url / prompt_id 等结构字段覆盖掉
_CANVAS_FIELDS = ("name", "x", "y", "scale", "group")


def update_gallery_item(gid, patch):
    """自由画布：改名、拖拽坐标、卡片缩放、打组。返回是否命中。"""
    with _lock:
        for g in _state["gallery"]:
            if g.get("id") != gid:
                continue
            for k in _CANVAS_FIELDS:
                if k not in patch:
                    continue
                v = patch[k]
                try:
                    if k == "name":
                        g[k] = str(v).strip()[:80] or "未命名作品"
                    elif k == "group":
                        g[k] = str(v).strip()[:40]   # 空字符串 = 解组
                    elif k == "scale":
                        g[k] = max(0.5, min(2.0, float(v)))
                    else:
                        g[k] = max(0, min(20000, float(v)))
                except (TypeError, ValueError):
                    continue
            _save()
            return True
    return False
