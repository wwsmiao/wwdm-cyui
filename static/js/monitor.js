/* 运行状态：右上角长条显示「生成进度 / 系统资源」，面板里看明细 */
const Monitor = {
  view: "progress",       // 面板当前页：progress | system
  mode: "progress",       // 长条显示什么：progress | system
  jobs: [],
  online: false,
  _gpu: null,
  _cpu: 0,

  init() {
    this.mode = localStorage.getItem("wwdm-stat-mode") === "system" ? "system" : "progress";
    $("#statSwitch").addEventListener("click", (event) => {
      event.stopPropagation();
      this.setMode(this.mode === "progress" ? "system" : "progress");
    });
    $("#statOpen").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle();
    });
    $("#statPill").addEventListener("click", () => this.toggle());
    $("#monitorClose").addEventListener("click", () => this.close());
    $("#monTabs").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-view]");
      if (btn) this.setView(btn.dataset.view);
    });
    $("#clearTasks").addEventListener("click", () => this.clear());
    this.setView("progress", false);
    this.paintPill();
  },

  setMode(mode) {
    this.mode = mode === "system" ? "system" : "progress";
    localStorage.setItem("wwdm-stat-mode", this.mode);
    // 长条显示什么，面板就默认打开哪一页
    this.setView(this.mode, false);
    this.paintPill();
  },

  setView(view, syncPill = true) {
    this.view = view;
    $("#progressView").hidden = view !== "progress";
    $("#systemView").hidden = view !== "system";
    $("#clearTasks").hidden = view !== "progress";
    $$("#monTabs button").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
    if (syncPill && view !== this.mode) {
      this.mode = view;
      localStorage.setItem("wwdm-stat-mode", this.mode);
      this.paintPill();
    }
  },

  open() { $("#monitorPanel").hidden = false; },
  close() { $("#monitorPanel").hidden = true; },
  toggle() {
    const panel = $("#monitorPanel");
    panel.hidden = !panel.hidden;
  },

  /* ---------- 长条 ---------- */
  /* 正在跑的：提示词任务优先，其次是有进度的作品任务 */
  current() {
    const active = ["queued", "submitting", "running"];
    const job = this.jobs.find((item) => active.includes(item.status));
    if (job) {
      return {
        id: job.id, kind: job.kind || "prompt", label: job.label,
        percent: job.progress || 0, status: job.status, node: job.node || "",
      };
    }
    const task = State.tasks.find((item) => active.includes(item.status));
    if (task) {
      return {
        id: task.id, kind: task.kind || "image", label: task.prompt,
        percent: task.progress || 0, status: task.status, node: task.node || "",
      };
    }
    return null;
  },

  paintPill() {
    const bar = $("#statBar");
    const text = $("#statText");
    if (!bar || !text) return;
    if (this.mode === "system") {
      const gpu = this._gpu;
      let percent = this._cpu || 0;
      let label = "CPU";
      if (gpu) {
        if (gpu.util != null) {
          percent = gpu.util;
          label = "GPU";
        } else if (gpu.vram_total) {
          // 远程实例拿不到 GPU 占用率，用显存占用代替
          percent = gpu.vram_used / gpu.vram_total * 100;
          label = "显存";
        }
      }
      text.textContent = `${label} ${Math.round(percent)}%`;
      bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      bar.className = percent >= 88 ? "hot" : percent >= 65 ? "warm" : "";
      $("#statPill").title = "当前显示：系统资源 · 点条形切换";
      return;
    }
    const current = this.current();
    if (!current) {
      text.textContent = "生成 空闲";
      bar.style.width = "0%";
      bar.className = "";
      $("#statPill").title = "当前显示：生成进度 · 点条形切换";
      return;
    }
    const percent = Math.min(99, Math.max(1, current.percent));
    text.textContent = `${current.kind === "prompt" ? "提示词" : "生成"} ${percent}%`;
    bar.style.width = `${percent}%`;
    bar.className = percent >= 88 ? "hot" : percent >= 65 ? "warm" : "";
    $("#statPill").title = `当前显示：生成进度 · ${current.label || ""}`;
  },

  setBar(id, percent) {
    const bar = $(id);
    if (!bar) return;
    bar.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
    bar.classList.toggle("warm", percent >= 65 && percent < 88);
    bar.classList.toggle("hot", percent >= 88);
  },

  async refreshStats() {
    let data;
    try {
      data = await API.stats();
    } catch {
      $("#comfyDot").className = "dot offline";
      $("#statText").textContent = "状态获取失败";
      return;
    }
    this.jobs = data.jobs || [];
    this.online = !!data.comfy?.online;
    $("#comfyDot").className = `dot ${this.online ? "online" : "offline"}`;

    const gpu = data.gpu?.[0];
    this._gpu = gpu;
    this._cpu = data.cpu;
    const mem = data.memory || {};
    $("#cpuText").textContent = `${data.cpu ?? 0}%`;
    $("#gpuText").textContent = gpu
      ? (gpu.util != null ? `${gpu.util}%` : `显存 ${Math.round(gpu.vram_used / gpu.vram_total * 100)}%`)
      : "N/A";
    $("#vramText").textContent = gpu ? `${gpu.vram_used} / ${gpu.vram_total} MB` : "未检测到 GPU";
    $("#memText").textContent = `${mem.used_gb ?? 0} / ${mem.total_gb ?? 0} GB`;
    this.setBar("#cpuBar", data.cpu);
    this.setBar("#gpuBar", gpu?.util != null ? gpu.util
      : gpu && gpu.vram_total ? gpu.vram_used / gpu.vram_total * 100 : 0);
    this.setBar("#vramBar", gpu ? gpu.vram_used / gpu.vram_total * 100 : 0);
    this.setBar("#memBar", mem.percent);

    const line = $("#comfyLine");
    if (this.online) {
      line.classList.remove("offline");
      line.textContent = `ComfyUI 已连接${data.remote ? "（远程实例）" : ""} · 运行中 ${data.comfy.running} · 等待 ${data.comfy.pending}`;
    } else {
      line.classList.add("offline");
      line.textContent = "ComfyUI 未连接，请检查设置里的服务地址";
    }

    this.paintPill();
    this.renderProgress();
  },

  /* ---------- 进度页 ---------- */
  stateText(status) {
    return {
      queued: "排队中", submitting: "提交中", running: "生成中",
      done: "已完成", error: "失败", cancelled: "已取消",
    }[status] || status || "";
  },

  renderProgress() {
    const current = this.current();
    const box = $("#currentProgress");
    const meta = $("#currentMeta");
    if (!current) {
      meta.textContent = this.online ? "空闲" : "ComfyUI 未连接";
      box.innerHTML = `<div class="mon-empty">${
        this.online ? "当前没有正在生成的画面" : "连上 ComfyUI 后这里会显示进度"}</div>`;
    } else {
      meta.textContent = `${this.stateText(current.status)}${
        current.node ? ` · 节点 ${escapeHtml(current.node)}` : ""}`;
      box.innerHTML = `
        <div class="task-progress current">
          <div class="task-top">
            <span class="prompt">${escapeHtml(current.kind === "prompt"
              ? `提示词 · ${current.label}` : current.label || "未命名")}</span>
            <span class="pct">${current.percent || 0}%</span>
          </div>
          <div class="task-bar"><i style="width:${current.percent || 0}%"></i></div>
        </div>`;
    }

    // 最近：作品任务 + 提示词任务按时间合并
    const clearedAt = Number(State.activeProject()?.progress_cleared_at || 0);
    const activeStatuses = ["queued", "submitting", "running"];
    const tasks = State.tasks
      .filter((task) => activeStatuses.includes(task.status) || task.created_at > clearedAt)
      .map((task) => ({
        id: task.id,
        kind: task.kind || "image",
        label: task.prompt,
        percent: task.progress || 0,
        status: task.status,
        node: task.node || "",
        created_at: task.created_at,
        meta: this.taskMeta(task),
      }));
    const jobs = this.jobs.map((job) => ({
      id: job.id,
      kind: job.kind || "prompt",
      label: job.label,
      percent: job.progress || 0,
      status: job.status,
      node: job.node || "",
      created_at: job.created_at,
      meta: "提示词生成",
    }));
    const list = [...tasks, ...jobs]
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 4);

    $("#taskCounter").textContent = `显示 ${list.length} 条`;
    const listBox = $("#taskProgressList");
    if (!list.length) {
      listBox.innerHTML = `<div class="mon-empty">暂无记录</div>`;
      return;
    }
    listBox.innerHTML = list.map((item) => `
      <div class="task-progress">
        <div class="task-top">
          <span class="prompt">${escapeHtml(item.kind === "prompt"
            ? `提示词 · ${item.label}` : item.label || "未命名")}</span>
          <span class="pct">${item.percent || 0}%</span>
        </div>
        <div class="task-bar"><i style="width:${item.percent || 0}%"></i></div>
        <div class="task-foot">
          <span>${escapeHtml(item.meta)}</span>
          <span class="state ${item.status === "done" ? "done" : ""} ${item.status === "error" ? "error" : ""}">
            ${this.stateText(item.status)}${item.node ? ` · ${escapeHtml(item.node)}` : ""}</span>
        </div>
      </div>`).join("");
  },

  taskMeta(task) {
    const [w, h] = sizeForParams(task.params);
    if ((task.kind || "image") === "video") {
      return `${task.width || w} × ${task.height || h} · ${Number(task.params?.duration || 3)} 秒`;
    }
    return `${task.width || w} × ${task.height || h} · ${task.params?.batch || 1} 张`;
  },

  async clear() {
    if (!await Dialog.confirm({
      title: "清空生成进度",
      message: "确定清空当前项目的进度列表吗？作品卡片、画布和图库中的图片都会保留。",
      confirmText: "清空进度",
    })) return;
    try {
      const result = await API.clearTasks(State.activeId);
      await Projects.load();
      if (result.cleared) toast(`已隐藏 ${result.cleared} 条进度，图片已保留`);
      else await Dialog.info({ title: "无需清空", message: "当前没有可清空的进度记录。" });
      window.Main?.refreshAll();
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    }
  },
};
