"""生成任务调度：提交 → 进度跟踪 → 取图落盘，全程在后台线程里跑。"""
import random
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from config import DEFAULT_PARAMS, OUTPUT_DIR
from core.comfy import ComfyError
from core.models import resolve
from core.naming import output_name
from core.workflows import resolve_params_size


class TaskManager:
    def __init__(self, projects, workflows, comfy, settings_getter):
        self.projects = projects
        self.workflows = workflows
        self.comfy = comfy
        self.settings = settings_getter
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gen")
        self._cancelled = set()
        self._by_prompt = {}
        # 进度换算：每个 prompt 的节点总数 / 已完成节点 / 当前节点执行到第几步
        self._graph_nodes = {}
        self._done_nodes = {}
        self._node_step = {}
        # 提示词这类不落库的短任务，只在内存里跟着进度走
        self._jobs = {}
        self._job_prompt = {}

    # ---------- 轻量任务（提示词生成） ----------
    def begin_job(self, label: str, kind: str = "prompt") -> dict:
        job = {
            "id": "j_" + uuid.uuid4().hex[:8],
            "label": label,
            "kind": kind,
            "status": "queued",
            "progress": 2,
            "node": "",
            "error": "",
            "prompt_id": "",
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
        self._jobs[job["id"]] = job
        self._prune_jobs()
        return dict(job)

    def attach_job(self, job_id: str, prompt_id: str) -> None:
        job = self._jobs.get(job_id)
        if not job or not prompt_id:
            return
        job["prompt_id"] = prompt_id
        job["status"] = "running"
        job["progress"] = max(job["progress"], 6)
        job["updated_at"] = int(time.time())
        self._job_prompt[prompt_id] = job_id

    def finish_job(self, job_id: str, error: str = "") -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        job["status"] = "error" if error else "done"
        job["progress"] = 0 if error else 100
        job["error"] = error
        job["node"] = ""
        job["updated_at"] = int(time.time())
        self._job_prompt.pop(job.get("prompt_id", ""), None)

    def list_jobs(self) -> list:
        now = int(time.time())
        self._prune_jobs()
        jobs = [j for j in self._jobs.values() if now - j["updated_at"] < 300]
        return sorted(jobs, key=lambda j: j["created_at"], reverse=True)[:5]

    def _prune_jobs(self) -> None:
        if len(self._jobs) <= 12:
            return
        for key in sorted(self._jobs, key=lambda k: self._jobs[k]["created_at"])[:-8]:
            self._jobs.pop(key, None)

    # ---------- 对外 ----------
    def submit(self, project_id: str, prompt: str, workflow_id: str,
               params: dict | None = None, workflow_params: dict | None = None) -> dict:
        """workflow_params：可选。传了就用这份快照跑（「按原图再生成一张」），
        不传就用设置里当前保存的参数。快照会存进任务，之后执行期间改设置也不影响这条任务。"""
        params = {**DEFAULT_PARAMS, **(params or {})}
        # 尺寸张数这类参数不吃的工作流（如图生图）先留空，出图后按真实文件回填；
        # 尺寸由专门节点算的工作流（视频的比例+百万像素）也不做前端估算
        supports = self.workflows.supports_of(workflow_id)
        if supports["size"] and supports.get("estimate", True):
            width, height = resolve_params_size(params)
        else:
            width, height = 0, 0
        saved = (self.settings().get("workflow_params") or {}).get(workflow_id, {})
        # 快照：传了就在当前设置之上覆盖（完整快照=完全复现；旧作品只传 LoRA 也能生效）
        effective = dict(saved)
        if isinstance(workflow_params, dict):
            effective.update(workflow_params)
        # 换过 ComfyUI 实例后，设置里存的模型名可能对不上：能映射的先换成本实例的名字，
        # 实例里确实没有的 LoRA 直接跳过（底模缺了会在提交时报错，不会悄悄换模型）
        effective, warnings = self._fit_to_instance(workflow_id, effective)
        task = {
            "id": "t_" + uuid.uuid4().hex[:10],
            "project_id": project_id,
            "prompt": prompt.strip(),
            "workflow": workflow_id,
            "kind": self.workflows.kind_of(workflow_id),
            "model": effective.get("unet") or self.workflows.model_of(workflow_id),
            "negative": effective.get("negative") or self.workflows.negative_of(workflow_id),
            "loras": self.workflows.loras_of(workflow_id, effective),
            "width": width,
            "height": height,
            "params": params,
            "workflow_params": effective,
            "warnings": warnings,
            "status": "queued",
            "progress": 0,
            "node": "",
            "prompt_id": "",
            "images": [],
            "error": "",
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
        self.projects.add_task(task)
        # 纯 Python 工作流（网格拼接等）：直接本地算，不提交 ComfyUI
        wf_obj = self.workflows.get_workflow(workflow_id)
        if getattr(wf_obj, "engine", "comfy") == "python":
            self.pool.submit(self._run_python, task["id"])
        else:
            self.pool.submit(self._run, task["id"])
        return task

    # ---------- 实例适配 ----------
    def _fit_to_instance(self, workflow_id: str, params: dict) -> tuple:
        """把设置里的模型名 / LoRA 名对到当前 ComfyUI 实例上。

        本地 ↔ 远程来回切换时，同一个模型的文件名常常不同（量化后缀、子目录前缀、
        大小写），这里能映射的就换成实例里的名字；实例里确实没有的 LoRA 直接置空
        （节点会被整段摘掉），并给任务带一条提示。
        """
        instance = getattr(self, "instance", None)
        if instance is None or not params:
            return params, []
        out = dict(params)
        warnings = []
        for key, kind in (("ckpt", "ckpt"), ("unet", "unet"), ("clip", "clip"), ("vae", "vae")):
            value = out.get(key)
            if not value:
                continue
            options = instance.options_of(kind)
            if not options:
                continue          # 实例连不上或没有这个节点，留给提交时报错
            fixed = resolve(kind, value, options)
            if fixed:
                out[key] = fixed
        lora_options = instance.options_of("lora")
        if lora_options:
            index = 1
            while f"lora_{index}" in out or f"lora_{index}_strength" in out:
                name = str(out.get(f"lora_{index}") or "").strip()
                if name:
                    fixed = resolve("lora", name, lora_options)
                    if fixed:
                        out[f"lora_{index}"] = fixed
                    else:
                        out[f"lora_{index}"] = ""
                        out.pop(f"lora_{index}_strength", None)
                        warnings.append(f"LoRA「{name}」在当前 ComfyUI 实例里没有，这次跳过")
                index += 1
        return out, warnings

    # ---------- 本地（纯 Python）任务 ----------
    def _run_python(self, task_id: str) -> None:
        """不走 ComfyUI 的工作流：交给 stitcher 之类的本地引擎算，出图直接落成作品。"""
        if task_id in self._cancelled:
            self._cancelled.discard(task_id)
            self.projects.update_task(task_id, status="cancelled", progress=0)
            return
        task = self.projects.get_task(task_id)
        if not task:
            return
        stitcher = getattr(self, "stitcher", None)
        try:
            if stitcher is None:
                raise ComfyError("本地执行器还没装配好（重启一下创作台）")
            # 行列参数兜底：前端没传就用工作流自己声明的默认值，
            # 否则会退化成 1×1、只输出第一张图
            wf = self.workflows.get_workflow(task.get("workflow"))
            grid = getattr(wf, "grid", None) or {}
            params = dict(task.get("params") or {})
            if grid:
                params.setdefault("grid_rows", grid.get("rows", 1))
                params.setdefault("grid_cols", grid.get("cols", 1))
            task = {**task, "params": params}
            self.projects.update_task(task_id, status="running", progress=20)
            result = stitcher.run(task)
            label = result.get("label") or task.get("prompt") or ""
            self.projects.update_task(
                task_id,
                status="done", progress=100, node="",
                prompt=task.get("prompt") or label,
                images=[result["url"]],
                width=result["width"], height=result["height"],
            )
            # 作品记录里补一份说明，卡片 / 生图信息弹窗能看到怎么拼的
            current = self.projects.get_task(task_id) or {}
            params = dict(current.get("params") or {})
            params["stitch"] = {
                "rows": result.get("rows"), "cols": result.get("cols"),
                "images": result.get("used"), "label": label,
            }
            self.projects.update_task(task_id, params=params)
        except Exception as exc:
            if task_id in self._cancelled:
                return
            self.projects.update_task(
                task_id, status="error", error=str(exc), progress=0)
        finally:
            self._cancelled.discard(task_id)

    def interrupt(self) -> bool:
        """中断 ComfyUI 当前执行（提示词运行等没有任务号的场景用）。"""
        try:
            self.comfy.interrupt()
            return True
        except ComfyError:
            return False

    def cancel(self, task_id: str) -> bool:
        self._cancelled.add(task_id)
        try:
            self.comfy.interrupt()
        except ComfyError:
            pass
        self.projects.update_task(task_id, status="cancelled", progress=0)
        return True

    # ---------- 进度换算 ----------
    def register_graph(self, prompt_id: str, graph: dict) -> None:
        """记住这张工作流有多少节点，用来把「跑到第几个节点」换算成百分比。"""
        self._graph_nodes[prompt_id] = max(1, len(graph or {}))
        self._done_nodes[prompt_id] = set()
        self._node_step[prompt_id] = 0.0

    def clear_graph(self, prompt_id: str) -> None:
        self._graph_nodes.pop(prompt_id, None)
        self._done_nodes.pop(prompt_id, None)
        self._node_step.pop(prompt_id, None)

    def _pre_percent(self, prompt_id: str) -> int:
        """采样开始前的进度：按已完成节点数走 5% ~ 30%。"""
        total = self._graph_nodes.get(prompt_id) or 0
        if total <= 0:
            return 5
        done = len(self._done_nodes.get(prompt_id) or ())
        return max(5, min(30, 5 + int(round(25 * done / total))))

    def _step_percent(self, prompt_id: str, fraction: float) -> int:
        """采样阶段：把当前节点的步数比例映射到 30% ~ 96%。"""
        fraction = max(0.0, min(1.0, float(fraction or 0)))
        self._node_step[prompt_id] = fraction
        return max(30, min(96, 30 + int(round(66 * fraction))))

    def _percent_of(self, prompt_id: str, running_frac: float | None = None) -> int | None:
        """兼容旧调用：没有步数比例时按节点完成度算，否则按步数比例算。"""
        if running_frac is None:
            return self._pre_percent(prompt_id)
        return self._step_percent(prompt_id, running_frac)

    def on_event(self, event: dict) -> None:
        """来自 WebSocket 的进度事件：任务（作品）和轻量任务（提示词）都走这里。"""
        kind = event.get("type", "")
        data = event.get("data", {}) or {}
        prompt_id = data.get("prompt_id", "")
        task_id = self._by_prompt.get(prompt_id)
        job_id = self._job_prompt.get(prompt_id)
        if not task_id and not job_id:
            return

        def bump(percent, node: str = "") -> None:
            """进度只往前走，避免节点之间来回跳。"""
            try:
                percent = int(percent)
            except (TypeError, ValueError):
                return
            if task_id:
                task = self.projects.get_task(task_id) or {}
                changes = {"status": "running",
                           "progress": max(int(task.get("progress") or 0), percent)}
                if node:
                    changes["node"] = node
                self.projects.update_task(task_id, **changes)
            if job_id:
                job = self._jobs.get(job_id)
                if job:
                    job.update(progress=max(job["progress"], percent), status="running",
                               updated_at=int(time.time()))
                    if node:
                        job["node"] = node

        if kind == "execution_cached":
            # 缓存命中的节点不用重跑，直接算已完成
            done = self._done_nodes.setdefault(prompt_id, set())
            for node in data.get("nodes") or []:
                done.add(str(node))
            bump(self._pre_percent(prompt_id))

        elif kind == "progress":
            total = data.get("max") or 1
            value = data.get("value", 0) or 0
            node = str(data.get("node", "") or "")
            percent = self._step_percent(prompt_id, value / total if total else 0)
            bump(percent, node)

        elif kind == "progress_state":
            # 新版 ComfyUI 会给每个节点单独报 value/max，采样时也走这里
            nodes = data.get("nodes") or {}
            running = None
            node_id = ""
            for nid, info in nodes.items():
                if not isinstance(info, dict):
                    continue
                state = info.get("state")
                if state == "running":
                    running = info
                    node_id = str(nid)
                elif state == "finished":
                    self._done_nodes.setdefault(prompt_id, set()).add(str(nid))
            if running and float(running.get("max") or 1) > 1:
                top = float(running.get("max") or 1) or 1.0
                bump(self._step_percent(prompt_id, float(running.get("value") or 0) / top), node_id)
            else:
                bump(self._pre_percent(prompt_id), node_id)

        elif kind == "executing":
            node = str(data.get("node") or "")
            if not node:      # node 为空表示这一轮执行结束
                return
            self._done_nodes.setdefault(prompt_id, set())
            bump(self._pre_percent(prompt_id), node)

        elif kind == "executed":
            node = str(data.get("node") or "")
            if node:
                self._done_nodes.setdefault(prompt_id, set()).add(node)
            percent = self._pre_percent(prompt_id)
            # 采样跑完后还有解码 / 保存，收尾阶段压到 96% 附近
            if (self._node_step.get(prompt_id) or 0) > 0:
                percent = max(percent, 96)
            bump(percent, "")

        elif kind == "execution_error":
            message = str(data.get("exception_message", "执行出错"))
            if task_id:
                self.projects.update_task(task_id, status="error", error=message)
            if job_id:
                self.finish_job(job_id, message)

    # ---------- 重启找回 / 手动找回 ----------
    @staticmethod
    def _collect_files(outputs: dict) -> list:
        files = []
        for node_output in (outputs or {}).values():
            # 图片节点给 images，视频节点给 gifs / videos，统一当文件处理
            for key in ("images", "gifs", "videos"):
                files.extend(node_output.get(key) or [])
        return files

    def _save_and_finish(self, task_id: str, files: list) -> None:
        try:
            images = self._save_files(task_id, files)
            self.projects.update_task(task_id, status="done", progress=100,
                                      images=images, node="")
        except Exception as exc:
            self.projects.update_task(task_id, status="error", error=str(exc))
        finally:
            prompt_id = (self.projects.get_task(task_id) or {}).get("prompt_id") or ""
            if prompt_id:
                self.clear_graph(prompt_id)

    def _track(self, task_id: str, prompt_id: str, cfg: dict, timeout: int) -> None:
        try:
            images = self._wait_for_images(task_id, prompt_id, cfg, timeout=timeout)
            self.projects.update_task(task_id, status="done", progress=100,
                                      images=images, node="")
        except Exception as exc:
            if task_id in self._cancelled:
                return
            self.projects.update_task(task_id, status="error", error=str(exc))
        finally:
            self._cancelled.discard(task_id)
            self.clear_graph(prompt_id)

    def recover(self) -> dict:
        """服务重启后：结果已在 ComfyUI 里的直接落盘，仍在跑的重新挂上进度。"""
        stats = {"completed": 0, "resumed": 0, "failed": 0}
        try:
            queue = self.comfy.status()
        except ComfyError as exc:
            return {"error": f"ComfyUI 未连接（{exc}），任务保持原状，连接后可点「找回」"}
        running_ids = set()
        for group in (queue.get("queue_running") or [], queue.get("queue_pending") or []):
            for item in group:
                if isinstance(item, dict) and item.get("prompt_id"):
                    running_ids.add(item["prompt_id"])
                elif isinstance(item, (list, tuple)) and len(item) > 1:
                    running_ids.add(item[1])
        for task in list(self.projects.store.read()["tasks"].values()):
            if task["status"] not in ("queued", "submitting", "running"):
                continue
            task_id = task["id"]
            prompt_id = task.get("prompt_id") or ""
            if prompt_id:
                try:
                    entry = self.comfy.history(prompt_id).get(prompt_id, {})
                    files = self._collect_files(entry.get("outputs") or {})
                    if files:
                        self.pool.submit(self._save_and_finish, task_id, files)
                        stats["completed"] += 1
                        continue
                except ComfyError:
                    pass
                if prompt_id in running_ids:
                    cfg = self.settings()
                    timeout = int(cfg.get("task_timeout") or 1800)
                    if task.get("kind") == "video":
                        timeout = max(timeout, 3600)
                    self._by_prompt[prompt_id] = task_id
                    self.projects.update_task(task_id, status="running", progress=max(
                        task.get("progress") or 0, 3))
                    self.pool.submit(self._track, task_id, prompt_id, cfg, timeout)
                    stats["resumed"] += 1
                    continue
            self.projects.update_task(task_id, status="error",
                                      error="服务重启时任务中断，请重新生成")
            stats["failed"] += 1
        return stats

    @staticmethod
    def _url_exists(url: str) -> bool:
        """作品地址对应的本地文件是否还在（拿图失败时用来判断要不要重新取一遍）。"""
        from config import DATA_DIR

        text = str(url or "")
        if not text:
            return False
        if text.startswith("/api/output/"):
            from urllib.parse import unquote
            relative = unquote(text[len("/api/output/"):])
            target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p])
            return target.is_file()
        if text.startswith("/static/outputs/"):
            target = OUTPUT_DIR.joinpath(*[p for p in text[len("/static/outputs/"):].split("/") if p])
            return target.is_file()
        return True   # 外部地址（http/https）不判断

    def reclaim(self, task_id: str) -> dict:
        """手动找回：超时 / 中断 / 文件丢失的任务，ComfyUI 那边结果还在就能重新取回。"""
        task = self.projects.get_task(task_id)
        if not task:
            return {"ok": False, "error": "任务不存在"}
        images = task.get("images") or []
        if task["status"] == "done" and images and all(self._url_exists(url) for url in images):
            return {"ok": True, "status": "done", "images": images}
        prompt_id = task.get("prompt_id") or ""
        if not prompt_id:
            return {"ok": False, "error": "这条任务没有提交过 ComfyUI，无法找回"}
        try:
            entry = self.comfy.history(prompt_id).get(prompt_id, {})
        except ComfyError as exc:
            return {"ok": False, "error": str(exc)}
        files = self._collect_files(entry.get("outputs") or {})
        if files:
            self.pool.submit(self._save_and_finish, task_id, files)
            return {"ok": True, "status": "running"}
        if entry.get("status", {}).get("completed"):
            return {"ok": False, "error": "ComfyUI 已结束但没有产出文件"}
        if not entry:
            # 结果还没出来：先看它是不是还在队列里（远程实例排一两个小时都正常），
            # 还在排队就重新挂上进度，别让用户以为丢了只能重跑
            try:
                in_queue = prompt_id in self.comfy.queue_ids()
            except ComfyError:
                in_queue = False
            if in_queue:
                cfg = self.settings()
                timeout = int(cfg.get("task_timeout") or 1800)
                if task.get("kind") == "video":
                    timeout = max(timeout, 3600)
                self._by_prompt[prompt_id] = task_id
                self.projects.update_task(task_id, status="running",
                                          error="", progress=max(task.get("progress") or 0, 3))
                self.pool.submit(self._track, task_id, prompt_id, cfg, timeout)
                return {"ok": True, "status": "running", "queued": True}
            return {"ok": False, "error": "ComfyUI 历史里没有这条任务的结果（可能已被清理），请重新生成"}
        cfg = self.settings()
        timeout = int(cfg.get("task_timeout") or 1800)
        if task.get("kind") == "video":
            timeout = max(timeout, 3600)
        self._by_prompt[prompt_id] = task_id
        self.pool.submit(self._track, task_id, prompt_id, cfg, timeout)
        self.projects.update_task(task_id, status="running",
                                  progress=max(task.get("progress") or 0, 3))
        return {"ok": True, "status": "running"}

    # ---------- 内部 ----------
    def _run(self, task_id: str) -> None:
        task = self.projects.get_task(task_id)
        if not task:
            return
        if task_id in self._cancelled:   # 排队期间已被取消：直接落终态，不再提交 ComfyUI
            self._cancelled.discard(task_id)
            self.projects.update_task(task_id, status="cancelled", progress=0)
            return
        cfg = self.settings()
        try:
            prompt = task["prompt"]

            # 优先用提交时存下的参数快照：之后在设置里改 LoRA / 模型 / 步数都不影响这条任务
            workflow_params = task.get("workflow_params")
            if not isinstance(workflow_params, dict) or not workflow_params:
                workflow_params = (cfg.get("workflow_params") or {}).get(task["workflow"], {})
            try:
                configured_seed = int(workflow_params.get("seed", -1))
            except (TypeError, ValueError):
                configured_seed = -1
            seed = configured_seed if configured_seed >= 0 else random.randint(1, 2 ** 31 - 1)

            graph = self.workflows.build(
                task["workflow"], prompt,
                params=task["params"], seed=seed,
                negative=task.get("negative") or None,
                workflow_params=workflow_params,
            )
            if graph is None:
                raise ComfyError(f"找不到工作流：{task['workflow']}")

            params = task.get("params") or {}
            if self.workflows.needs_image_of(task["workflow"]) and not params.get("image"):
                raise ComfyError("这个工作流需要一张参考图（首帧 / 尾帧），请先选图再提交")
            wf_obj = self.workflows.get_workflow(task["workflow"])
            if wf_obj is not None and wf_obj.needs_image:
                # 实际给了几张参考图（image / image2 … image10）
                given = sum(1 for key in ("image",) + tuple(f"image{i}" for i in range(2, 11))
                            if str(params.get(key) or "").strip())
                need = max(1, int(getattr(wf_obj, "min_images", 1) or 1))
                if given < need:
                    raise ComfyError(f"「{wf_obj.name}」至少需要 {need} 张参考图，现在只有 {given} 张")
            self.projects.update_task(task_id, status="submitting", progress=2)
            prompt_id = self.comfy.submit(graph)
            self._by_prompt[prompt_id] = task_id
            self.register_graph(prompt_id, graph)
            self.projects.update_task(task_id, status="running", progress=5,
                                      prompt_id=prompt_id)

            timeout = int(cfg.get("task_timeout") or 1800)
            if task.get("kind") == "video":
                # 视频跑得久（模型加载 + 采样 + 编码），给足两倍时间
                timeout = max(timeout, 3600)
            self._track(task_id, prompt_id, cfg, timeout)
        except Exception as exc:
            if task_id in self._cancelled:
                return
            self.projects.update_task(
                task_id, status="error", error=str(exc), progress=0
            )
        finally:
            self._cancelled.discard(task_id)

    def _wait_for_images(self, task_id: str, prompt_id: str, cfg: dict,
                         timeout: int | None = None) -> list:
        deadline = time.time() + (timeout or int(cfg.get("task_timeout", 1800)))
        interval = max(0.5, float(cfg.get("poll_interval", 1.0)))
        misses = 0          # 连续连不上 ComfyUI 的次数（远程实例偶尔会慢过读取超时）
        while time.time() < deadline:
            if task_id in self._cancelled:
                raise ComfyError("任务已取消")
            try:
                history = self.comfy.history(prompt_id)
            except ComfyError as exc:
                misses += 1
                if misses >= 12:
                    raise ComfyError(f"连着 {misses} 次取不到 ComfyUI 的结果（{exc}）"
                                     f"，任务可能还在跑，可在作品卡上点「找回」") from exc
                time.sleep(min(8, interval + misses))
                continue
            misses = 0
            entry = history.get(prompt_id, {})
            outputs = entry.get("outputs", {})
            files = []
            for node_output in outputs.values():
                # 图片节点给 images，视频节点给 gifs / videos，统一当文件处理
                for key in ("images", "gifs", "videos"):
                    files.extend(node_output.get(key) or [])
            if files:
                return self._save_files(task_id, files)
            status = entry.get("status", {})
            if status.get("completed"):
                raise ComfyError("工作流已结束但没有产出文件，请检查 ComfyUI 节点")
            if status.get("status_str") == "error":
                raise ComfyError("ComfyUI 执行出错，请查看 ComfyUI 控制台")
            time.sleep(interval)
        raise ComfyError(f"等待超时（{(timeout or int(cfg.get('task_timeout', 1800)))} 秒），"
                         f"可在作品卡上点「找回」重新取结果")

    def _save_files(self, task_id: str, files: list) -> list:
        from urllib.parse import quote
        task = self.projects.get_task(task_id) or {}
        project_id = task.get("project_id") or ""
        folder_name = ""
        if project_id:
            base = self.projects.output_folder(project_id)
            folder_name = base.name
            folder = base / task_id
        else:
            folder = OUTPUT_DIR / task_id
        folder.mkdir(parents=True, exist_ok=True)
        saved = []
        size = None
        duration = None
        for index, item in enumerate(files):
            suffix = Path(item.get("filename", "image.png")).suffix or ".png"
            # 文件名带时间戳 + 提示词摘要：多张图靠序号区分，不同任务不重名
            filename = output_name(task.get("prompt") or "", index, len(files), suffix,
                                   task.get("created_at"))
            data = self.comfy.view_bytes(item)
            target = folder / filename
            target.write_bytes(data)
            meta = item.get("metadata") or {}
            if size is None and meta.get("width") and meta.get("height"):
                # 视频节点会在 metadata 里带上真实宽高与时长
                size = (int(meta["width"]), int(meta["height"]))
                if meta.get("duration"):
                    duration = round(float(meta["duration"]), 2)
            elif size is None and suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
                size = self._image_size(target)
            if folder_name:
                saved.append(f"/api/output/{quote(folder_name)}/{task_id}/{filename}")
            else:
                saved.append(f"/static/outputs/{task_id}/{filename}")
        # 图生图/图生视频的实际尺寸由参考图决定，用真实像素覆盖提交时的估算值
        changes = {}
        if size:
            changes["width"], changes["height"] = size[0], size[1]
        if duration:
            changes["duration"] = duration
        if changes:
            self.projects.update_task(task_id, **changes)
        return saved

    @staticmethod
    def _image_size(path: Path):
        try:
            from PIL import Image
            with Image.open(path) as handle:
                return handle.size
        except Exception:
            return None
