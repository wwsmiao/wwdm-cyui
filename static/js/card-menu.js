/* 作品工作台：右键作品卡片 → 近全屏「左大图 + 右操作面板」，
   编辑（裁剪 / 旋转 / 色调）出图后自动切到新作品，方便直接看效果。 */
const CardMenu = {
  taskId: "",        // 当前正在看的作品
  pendingId: "",     // 高清放大等异步任务的 id，出图后自动切过去
  timer: 0,
  actualSize: false,

  init() {
    $("#worksGrid").addEventListener("contextmenu", (event) => {
      const card = event.target.closest(".work-card");
      if (!card) return;
      event.preventDefault();
      this.open(card.dataset.id);
    });

    $("#wbClose").addEventListener("click", () => this.close());
    $("#wbBack").addEventListener("click", () => {
      if (WbEdit.active()) WbEdit.cancel();
      else this.render();
    });
    $("#workbench").addEventListener("click", (event) => {
      if (event.target === $("#workbench")) this.close();
    });
    $("#wbFit").addEventListener("click", () => this.toggleFit());
    // 点图切换「适应窗口 / 实际大小」：编辑态不响应，拖动后松手产生的 click 也不算
    $("#wbMedia").addEventListener("pointerdown", (event) => {
      this._downAt = { x: event.clientX, y: event.clientY };
    });
    $("#wbMedia").addEventListener("click", (event) => {
      if (WbEdit.active()) return;                       // 裁剪 / 预览态一律不切
      if (event.target.closest("video,audio")) return;   // 视频交给原生控件
      const start = this._downAt;
      this._downAt = null;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      this.toggleFit();
    });
    $("#wbFile").addEventListener("dblclick", async () => {
      const url = $("#wbFile").dataset.renameUrl;
      const task = this.task();
      if (!url || !task) return;
      const changed = await Works.renameMedia(task, url);
      if (changed) { this.adoptTask(State.tasks.find((t) => t.id === task.id) || task); }
    });
    $("#wbDownload").addEventListener("click", () => {
      const task = this.task();
      const url = (task?.images || [])[0];
      if (!url) return;
      const link = document.createElement("a");
      link.href = url;
      link.download = Works.downloadName(task, url);
      link.click();
    });

    $("#wbSideBody").addEventListener("click", (event) => {
      const copy = event.target.closest("[data-wb-copy]");
      if (copy) {
        const text = this.task()?.prompt || "";
        if (!text) return;
        navigator.clipboard?.writeText(text).then(
          () => toast("提示词已复制"),
          () => toast("复制失败", true),
        );
        return;
      }
      const btn = event.target.closest("[data-act]");
      if (!btn) return;
      this.run(btn.dataset.act);
    });
    $("#wbSideFoot").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-act]");
      if (!btn) return;
      this.run(btn.dataset.act);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || $("#workbench").hidden) return;
      // 遮罩弹窗开着时 Esc 只关它，工作台留着
      if (typeof MaskEditor !== "undefined" && !$("#maskLayer").hidden) return;
      // 编辑态先退出编辑，再按一次才关工作台
      if (WbEdit.active()) WbEdit.cancel();
      else this.close();
    });
    window.addEventListener("resize", () => {
      if (!$("#workbench").hidden) this.toggleFit(this.actualSize);
    });
  },

  // ---------- 打开 / 关闭 ----------
  open(taskId) {
    const task = State.tasks.find((item) => item.id === taskId);
    if (!task) return toast("这条作品已经不在了", true);
    if (WbEdit.active()) WbEdit.cancel();
    this.taskId = taskId;
    this.actualSize = false;
    $("#workbench").hidden = false;
    $("#wbBack").hidden = true;
    this.render();
    this.startWatch();
  },

  close() {
    if (WbEdit.active()) WbEdit.cancel();
    $("#workbench").hidden = true;
    this.stopWatch();
    this.taskId = "";
    this.pendingId = "";
  },

  task() {
    return State.tasks.find((item) => item.id === this.taskId) || null;
  },

  /* 新作品（本地编辑 / 放大）产生后：并进列表、立刻切过去预览 */
  adoptTask(created) {
    if (!created?.id) return this.render();
    if (!(State.tasks || []).some((item) => item.id === created.id)) State.tasks.unshift(created);
    if (created.status === "done" && (created.images || []).length) {
      this.pendingId = "";
      this.taskId = created.id;
      this.render();
    } else {
      this.pendingId = created.id;
      toast("已提交，完成后会自动切到新作品");
      this.render();
    }
  },

  // ---------- 渲染 ----------
  render() {
    // 正在编辑（裁剪框 / 实时预览）时不要重绘，否则会打断交互
    if (WbEdit.active()) return;
    const task = this.task();
    // 正在等异步任务（如放大）时，列表里还没有新作品也不要关掉工作台
    if (!task) return this.pendingId ? undefined : this.close();
    this.renderStage(task);
    this.renderSide(task);
    $$(".work-card").forEach((card) => card.classList.toggle("menu-target", card.dataset.id === task.id));
  },

  renderStage(task) {
    const box = $("#wbMedia");
    const url = (task.images || [])[0] || "";
    const isVideo = (task.kind === "video") || /\.(mp4|webm|mov|mkv)$/i.test(url);
    box.innerHTML = !url
      ? `<div class="wb-empty">还没有图片</div>`
      : isVideo
        ? `<video src="${escapeHtml(url)}" controls autoplay muted loop playsinline></video>`
        : `<img src="${escapeHtml(url)}" alt="作品预览">`;
    // 用真实名称（提示词摘要 / 自定义名），双击也能改名
    const name = window.Works?.titleOf ? Works.titleOf(task, url) : decodeURIComponent(url.split("/").pop() || "");
    const size = task.width && task.height ? `${task.width} × ${task.height}` : "";
    $("#wbFile").textContent = [name, size].filter(Boolean).join(" · ") || "—";
    $("#wbFile").dataset.renameUrl = url;
    $("#wbFile").title = "双击可重命名";
    $("#wbSize").textContent = size;
    $("#wbTitle").textContent = task.workflow === "local-edit" ? "本地编辑作品" : "作品信息";
    $("#wbStage").classList.toggle("actual", false);
    this.actualSize = false;
  },

  /* 局部重绘用的工作流（category = inpaint）：创作区的工作流下拉里不出现，只在这里用 */
  inpaintWorkflows() {
    // 当前实例跑不起来的（缺节点 / 缺模型）不列，免得点了才报错
    return (State.workflows || []).filter((wf) => wf.category === "inpaint" && wf.available !== false);
  },

  cell(act, label, iconName, { disabled = false, tag = "", placeholder = false } = {}) {
    const cls = placeholder ? ' class="placeholder"' : "";
    return `<button data-act="${act}"${disabled ? " disabled" : ""}${cls}>
      ${icon(iconName)}${escapeHtml(label)}${tag ? `<span class="wb-tag">${escapeHtml(tag)}</span>` : ""}
    </button>`;
  },

  group(title, cells, hint = "") {
    return `
      <div class="wb-group">
        <div class="wb-group-head">${icon("chevron-up")}${escapeHtml(title)}${
          hint ? `<span class="wb-group-hint">${escapeHtml(hint)}</span>` : ""}</div>
        <div class="wb-grid">${cells.join("")}</div>
      </div>`;
  },

  renderSide(task) {
    const hasImage = (task.images || []).length > 0;
    const wf = State.workflows.find((item) => item.id === task.workflow);
    const workflowName = wf?.name || (task.workflow === "local-edit" ? "本地编辑" : (task.workflow || "—"));
    const prompt = task.prompt || "";

    $("#wbSideBody").innerHTML = `
      <div class="wb-info">
        <span>工作流</span><b title="${escapeHtml(workflowName)}">${escapeHtml(workflowName)}</b>
        <span>时间</span><b>${escapeHtml(timeLabel(task.created_at))}</b>
        <span>状态</span><b>${escapeHtml(this.statusText(task))}</b>
      </div>

      <div class="wb-prompt${prompt ? "" : " empty"}">
        <div class="wb-prompt-head">
          <span>提示词 / 说明</span>
          ${prompt ? `<button data-wb-copy>复制</button>` : ""}
        </div>
        <p>${prompt ? escapeHtml(prompt) : "这条作品没有提示词"}</p>
      </div>

      ${this.group("快速编辑", [
        this.cell("crop", "裁剪", "crop", { disabled: !hasImage }),
        this.cell("rotate", "旋转翻转", "rotate", { disabled: !hasImage }),
        this.cell("tone", "色调调整", "sliders", { disabled: !hasImage }),
        this.cell("upscale", "高清放大", "expand", { disabled: !hasImage }),
      ])}

      ${this.group("画面修复", [
        this.cell("edit", "图片编辑", "edit", { tag: "待接入", placeholder: true }),
        this.cell("inpaint", "局部重绘", "mask", { disabled: !hasImage || !this.inpaintWorkflows().length }),
      ], this.inpaintWorkflows().length ? "" : "需要局部重绘工作流")}

      ${this.group("更多工具", [
        this.cell("refetch", "拿最新图片", "ref"),
        this.cell("library", "添加到资产库", "folder", { disabled: !hasImage }),
        this.cell("to-canvas", "发送到画布", "canvas", { disabled: !hasImage }),
        this.cell("prompt", "发送提示词", "send", { disabled: !prompt }),
        this.cell("download", "下载图片", "download", { disabled: !hasImage }),
      ])}`;

    $("#wbSideFoot").innerHTML = `
      <button class="wb-cta" data-act="regen">${icon("sparkle")}用同样设置再生成一张</button>
      <button class="wb-danger" data-act="remove">${icon("trash")}移除作品记录</button>`;
  },

  statusText(task) {
    const map = {
      queued: "排队中", submitting: "提交中", running: `生成中 ${task.progress || 0}%`,
      done: "已完成", error: task.error || "生成失败", cancelled: "已取消",
    };
    return map[task.status] || task.status || "—";
  },

  toggleFit(force) {
    if (WbEdit.active()) return;   // 编辑态容器尺寸变了会让裁剪框错位
    this.actualSize = typeof force === "boolean" ? force : !this.actualSize;
    $("#wbStage").classList.toggle("actual", this.actualSize);
  },

  // ---------- 轮询：异步任务出图后自动切过去 ----------
  startWatch() {
    this.stopWatch();
    this.timer = setInterval(() => {
      if ($("#workbench").hidden) return this.stopWatch();
      const current = this.task();
      if (current && (current.status === "running" || current.status === "queued")) {
        // 当前作品自己还在跑（如正在放大），到点了刷新一次展示
        const before = JSON.stringify(current.images || []);
        setTimeout(() => {
          if (!this.task()) return;
          if (JSON.stringify(this.task().images || []) !== before) this.render();
        }, 60);
      }
      if (!this.pendingId) return;
      const done = (State.tasks || []).find((item) => item.id === this.pendingId);
      if (done && done.status === "done" && (done.images || []).length) {
        this.pendingId = "";
        const target = done.id;
        this.taskId = target;
        this.render();
        toast("放大完成，已切到新作品");
      } else if (done && done.status === "error") {
        this.pendingId = "";
        toast(done.error || "放大失败", true);
      }
    }, 800);
  },

  stopWatch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  },

  // ---------- 动作 ----------
  async run(act) {
    const task = this.task();
    if (!task) return;
    const first = (task.images || [])[0] || "";
    const needImage = () => {
      if (first) return true;
      Dialog.warn({ title: "还没有图片", message: "这条作品还没出图，先等生成完成。" });
      return false;
    };

    if (["crop", "rotate", "tone", "upscale"].includes(act)) {
      if (!needImage()) return;
      return void WbEdit.begin(act);
    }
    if (act === "refetch") {
      if (!task.prompt_id && !(task.images || []).length) {
        return Dialog.warn({
          title: "这条记录还没提交过",
          message: "它没有 ComfyUI 的 prompt_id，找不回图片，只能用原提示词重新生成。",
        });
      }
      const result = await Works.refetch(task.id);
      if (result) setTimeout(() => this.render(), 400);
      return;
    }
    if (act === "library") {
      if (!needImage()) return;
      return void AssetLib.openSave("project", first, task.prompt || "");
    }
    if (act === "to-canvas") return this.sendToCanvas(task);
    if (act === "prompt") {
      if (!task.prompt) return toast("这条作品没有提示词", true);
      this.close();
      Composer.setPrompt(task.prompt);
      return void toast("提示词已送到创作框");
    }
    if (act === "download") {
      if (!needImage()) return;
      const link = document.createElement("a");
      link.href = first;
      link.download = Works.downloadName(task, first);
      link.click();
      return;
    }
    if (act === "inpaint") {
      if (!needImage()) return;
      if (!this.inpaintWorkflows().length) {
        return Dialog.warn({
          title: "还没有局部重绘工作流",
          message: "把局部重绘工作流放进 workflows/ 目录（category 设为 inpaint）后，这里就能直接选它重绘。",
        });
      }
      const name = window.Works?.titleOf ? Works.titleOf(task, first) : "";
      return void MaskEditor.open({
        url: first,
        name,
        label: "作品",
        projectId: task.project_id || State.activeId,
        onCreated: (created) => this.adoptTask(created),
      });
    }
    if (act === "regen") return this.regenerate(task);
    if (act === "remove") return this.remove(task);

    const label = { edit: "图片编辑" }[act] || "该功能";
    Dialog.info({
      title: `${label}尚未接入`,
      message: "入口已占位，等接入对应的 ComfyUI 编辑工作流（重绘 / 局部遮罩）后就能直接用这张图处理。",
    });
  },

  /* 把这张作品作为素材节点发到无限画布，方便从它拉线继续创作 */
  async sendToCanvas(task) {
    const url = (task.images || [])[0];
    if (!url) return toast("这条作品还没有图片", true);
    if (task.project_id && State.activeId && task.project_id !== State.activeId) {
      return Dialog.warn({
        title: "不在当前项目",
        message: "这张作品属于其他项目。先切换到那个项目，再发送到画布。",
      });
    }
    this.close();
    if (State.viewMode !== "canvas") Works.setViewMode("canvas");
    // 等画布切好、项目布局同步完再放节点
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)));
    const canvas = window.Canvas;
    if (!canvas) return toast("画布还没准备好", true);
    const point = canvas.viewCenterWorld?.() || { x: 0, y: 0 };
    const fileName = decodeURIComponent(url.split("/").pop() || "") || "作品";
    const ids = canvas.placeAssets([{
      name: fileName,
      source: "project",
      kind: task.kind === "video" ? "video" : "image",
      origin: (task.prompt || "").slice(0, 60) || fileName,
      url,
      ref: { source: "project", name: url },
      width: task.width,
      height: task.height,
      task_id: task.id,
    }], point) || [];
    if (ids.length) canvas.select(ids[ids.length - 1]);
    toast("已发送到画布，可以从这个素材拉线继续创作");
  },

  /* 旧版本作品没有存参数快照：至少把当时用的 LoRA / 底模 / 负面词按原样带回去，
     其余参数（步数、采样器…）沿用当前设置 —— 这样改过 LoRA 也能按原图重出。 */
  legacySnapshot(task) {
    const snapshot = {};
    (task.loras || []).slice(0, 5).forEach((lora, index) => {
      if (!lora?.name) return;
      snapshot[`lora_${index + 1}`] = lora.name;
      if (lora.strength != null) snapshot[`lora_${index + 1}_strength`] = String(lora.strength);
    });
    if (task.model) snapshot.unet = task.model;
    if (task.negative) snapshot.negative = task.negative;
    return Object.keys(snapshot).length ? snapshot : null;
  },

  async regenerate(task) {
    if (!task.workflow || task.workflow === "local-edit") {
      return Dialog.warn({ title: "无法重复", message: "本地编辑的作品没有对应工作流，请重新选一张原图处理。" });
    }
    // 新作品直接用完整参数快照；旧作品至少还原 LoRA / 底模 / 负面词
    const saved = task.workflow_params;
    const snapshot = (saved && Object.keys(saved).length ? saved : null) || this.legacySnapshot(task);
    try {
      const created = await API.generate({
        project_id: task.project_id || State.activeId,
        prompt: task.prompt || "",
        workflow: task.workflow,
        params: task.params || {},
        workflow_params: snapshot,
      });
      if (created?.id) {
        toast(snapshot ? "已按原图的 LoRA / 参数重新提交" : "已按相同设置重新提交");
        window.Main?.refreshAll();
      }
    } catch (error) {
      Dialog.warn({ title: "重新生成失败", message: error.message });
    }
  },

  async remove(task) {
    if (!await Dialog.confirm({
      title: "移除作品记录",
      message: "确定从列表移除这张作品吗？本地图片文件不会被删除。",
      confirmText: "移除记录",
    })) return;
    try {
      await API.deleteTask(task.id);
      this.close();
      window.Main?.refreshAll();
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    }
  },
};
