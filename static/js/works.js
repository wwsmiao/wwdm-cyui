/* 作品卡片：网格 / 画布双视图、进度覆盖层、拖拽与预览 */
const DEFAULT_NEGATIVE = "low quality, bad anatomy, extra digits, missing digits, extra limbs, missing limbs";

const Works = {
  _previewTask: null,
  _previewIndex: 0,
  _signature: "",
  _dragging: null,
  // 生图信息弹窗里的图片缩放：scale + 平移（transform-origin 固定在左上角）
  _zoom: { scale: 1, tx: 0, ty: 0 },

  async load() {
    const tasks = await API.tasks(State.activeId);
    State.tasks = tasks;
    const signature = JSON.stringify(tasks.map((t) => [
      t.id, t.status, t.progress, t.images.length, t.prompt,
    ]));
    if (signature === this._signature || this._dragging) return;
    this._signature = signature;
    this.render();
  },

  reset() {
    this._signature = "";
    this.render();
  },

  /* 拿最新图片：从 ComfyUI 历史里把这条任务的结果重新取回本地。
     用于取图失败 / 文件被清掉 / 任务超时中断后想再要一次图片。 */
  async refetch(taskId) {
    const task = State.tasks.find((item) => item.id === taskId);
    if (!task) return void toast("找不到这条任务记录", true);
    try {
      const result = await API.reclaimTask(taskId);
      const count = (result.images || []).length;
      if (result.status === "done") {
        toast(count ? `已拿到最新图片（${count} 张）` : "已是最新，没有新的图片");
      } else {
        toast("已挂上取图任务，稍等几秒就会显示");
      }
      window.Main?.refreshAll();
      return result;
    } catch (error) {
      Dialog.warn({ title: "拿最新图片失败", message: error.message });
      return null;
    }
  },

  statusInfo(task) {
    const map = {
      queued: ["排队中", ""], submitting: ["提交中", "running"],
      running: ["生成中", "running"], done: ["已完成", ""],
      error: ["失败", "error"], cancelled: ["已取消", ""],
    };
    return map[task.status] || [task.status, ""];
  },

  cardHtml(task, canvas) {
    const [label, stateClass] = this.statusInfo(task);
    const running = ["queued", "submitting", "running"].includes(task.status);
    const first = task.images[0] || "";
    const isVideo = (task.kind === "video") || /\.(mp4|webm|mov|mkv)$/i.test(first);
    let cover;
    if (!task.images.length) cover = `<div class="placeholder">${icon("image")}</div>`;
    else if (isVideo) {
      // 有真实宽高就先占好位置，避免视频元数据到位时整行跳动
      const ratio = task.width && task.height ? ` style="aspect-ratio:${task.width}/${task.height}"` : "";
      cover = `<video src="${first}" muted loop playsinline preload="metadata"${ratio}></video>
        <span class="play-badge">${icon("video")}</span>`;
    } else cover = `<img src="${first}" alt="作品" loading="lazy">`;
    const overlay = running ? `
      <div class="progress-overlay"><div class="ring"></div>
        <span>${task.progress || 0}%${task.node ? ` · 节点 ${escapeHtml(task.node)}` : ""}</span></div>` : "";
    const badge = `<span class="status-badge ${stateClass}"><i></i>${label}</span>`;
    const [cw, ch] = sizeForParams(task.params);
    // 视频不按像素算尺寸，角标改显示时长
    const resBadge = isVideo
      ? `<span class="res-badge">${Number(task.params?.duration || 3)}s 视频</span>`
      : `<span class="res-badge">${task.width || cw} × ${task.height || ch}</span>`;
    const countBadge = task.images.length > 1
      ? `<span class="count-badge">${task.images.length} 张</span>` : "";
    const customName = (task.image_names || {})[first] || "";
    const nameRow = customName
      ? `<div class="work-name" title="双击可改名">${escapeHtml(customName)}</div>` : "";
    const note = task.status === "error"
      ? `<div class="work-prompt" title="${escapeHtml(task.error)}">${escapeHtml(task.error)}</div>`
      : `<div class="work-prompt" title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</div>`;
    const actions = `
      <div class="card-actions">
        ${running ? `<button data-cancel="${task.id}" title="取消">${icon("close")}</button>` : ""}
        ${!running && task.prompt_id && task.status !== "done"
          ? `<button data-reclaim="${task.id}" title="找回结果">${icon("rotate")}</button>` : ""}
        ${task.images.length ? `<button data-download="${task.id}" title="下载">${icon("download")}</button>` : ""}
        <button data-remove="${task.id}" title="移除记录">${icon("trash")}</button>
      </div>`;
    const style = canvas ? `style="${this.positionStyle(task.id)}"` : "";
    const extraClass = canvas ? " canvas-card" : "";
    return `
      <article class="work-card${extraClass}" data-id="${task.id}" ${style}>
        <div class="work-cover ${task.images.length ? "with-image" : ""}">${cover}${badge}${countBadge}${resBadge}${overlay}</div>
        <div class="work-meta">${nameRow}${note}
          <div class="work-sub">
            <span class="tag">${escapeHtml((State.workflows.find((w) => w.id === task.workflow) || {}).name || task.workflow)}</span>
            <span>${timeLabel(task.created_at)}</span>${actions}
          </div>
        </div>
      </article>`;
  },

  positionStyle(taskId) {
    const stored = localStorage.getItem(`canvas-pos-${taskId}`);
    if (stored) {
      const pos = JSON.parse(stored);
      return `left:${pos.x}px;top:${pos.y}px;`;
    }
    const index = State.tasks.findIndex((t) => t.id === taskId);
    return `left:${40 + (index % 4) * 260}px;top:${46 + Math.floor(index / 4) * 300}px;`;
  },

  render() {
    const empty = $("#emptyState");
    empty.hidden = State.viewMode !== "card" || State.tasks.length > 0;
    const cards = State.tasks.map((task) => this.cardHtml(task, false)).join("");
    $("#worksGrid").innerHTML = cards;
    // 画布交给无限画布模块渲染：节点 + 连线 + 平移缩放 + 持久化
    window.Canvas?.render();
    this.bindCards();
  },

  /* 顶栏「整理」：卡片模式按创建时间重排并复位视图 */
  tidy() {
    if (!State.tasks.length) return toast("还没有作品可整理", true);
    State.tasks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    State.zoom = 1;
    State.cardZoom = 1;
    $("#worksGrid").style.zoom = 1;
    $("#zoomLabel").textContent = "100%";
    $("#worksGrid").scrollTop = 0;
    this.render();
    toast(`已按创建时间整理 ${State.tasks.length} 张卡片`);
  },

  bindCards() {
    $$(".work-card").forEach((card) => {
      const media = card.querySelector(".work-cover img, .work-cover video");
      if (media) media.addEventListener("click", () => this.preview(card.dataset.id, media.getAttribute("src")));
      card.addEventListener("dblclick", (event) => {
        if (event.target.closest("button, a")) return;
        const task = State.tasks.find((item) => item.id === card.dataset.id);
        const url = (task?.images || [])[0];
        if (!task || !url) return;
        event.preventDefault();
        this.renameMedia(task, url).then((changed) => { if (changed) this.render(); });
      });
    });
    $$("[data-cancel]").forEach((btn) => btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try { await API.cancelTask(btn.dataset.cancel); window.Main?.refreshAll(); }
      catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
    }));
    $$("[data-reclaim]").forEach((btn) => btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      try {
        const result = await API.reclaimTask(btn.dataset.reclaim);
        if (result.status === "done") {
          toast("已找回结果");
        } else {
          toast("已找回，正在等待 ComfyUI 返回结果");
        }
        window.Main?.refreshAll();
      } catch (error) {
        Dialog.warn({ title: "找回失败", message: error.message });
        btn.disabled = false;
      }
    }));
    $$("[data-remove]").forEach((btn) => btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!await Dialog.confirm({
        title: "移除作品记录",
        message: "确定从列表移除这张作品吗？本地图片文件不会被删除。",
        confirmText: "移除记录",
      })) return;
      try { await API.deleteTask(btn.dataset.remove); window.Main?.refreshAll(); }
      catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
    }));
    $$("[data-download]").forEach((btn) => btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const task = State.tasks.find((t) => t.id === btn.dataset.download);
      if (!task?.images?.length) return;
      const link = document.createElement("a");
      link.href = task.images[0];
      link.download = this.downloadName(task, task.images[0]);
      link.click();
    }));
  },

  makeDraggable(card) {
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, img")) return;
      const rect = card.getBoundingClientRect();
      const parent = $("#canvasInner").getBoundingClientRect();
      this._dragging = {
        card,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        parent,
      };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", (event) => {
      if (!this._dragging || this._dragging.card !== card) return;
      const x = Math.max(0, event.clientX - this._dragging.parent.left - this._dragging.dx);
      const y = Math.max(0, event.clientY - this._dragging.parent.top - this._dragging.dy);
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    });
    const stop = () => {
      if (!this._dragging || this._dragging.card !== card) return;
      localStorage.setItem(`canvas-pos-${card.dataset.id}`, JSON.stringify({
        x: parseInt(card.style.left, 10) || 0,
        y: parseInt(card.style.top, 10) || 0,
      }));
      this._dragging = null;
    };
    card.addEventListener("pointerup", stop);
    card.addEventListener("pointercancel", stop);
  },

  /* 素材显示名：用户改过就用自定义名，否则用提示词摘要（多张带序号），最后兜底文件名 */
  titleOf(task, url) {
    if (!task) return decodeURIComponent(String(url || "").split("/").pop() || "未命名");
    const map = task.image_names || {};
    const key = String(url || "");
    const file = decodeURIComponent(key.split("/").pop() || "");
    if (map[key]) return map[key];
    if (map[file]) return map[file];
    const list = task.images || [];
    const prompt = String(task.prompt || "").replace(/\s+/g, " ").trim();
    if (prompt) {
      const short = prompt.length > 16 ? `${prompt.slice(0, 16)}…` : prompt;
      if (list.length <= 1) return short;
      const index = list.indexOf(key);
      return `${short} #${index >= 0 ? index + 1 : 1}`;
    }
    return file || "未命名";
  },

  /* 下载用的文件名：优先用素材显示名（提示词摘要 / 自定义名），再补上真实扩展名 */
  downloadName(task, url) {
    const EXT = /\.(png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|mkv|mp3|wav|flac|ogg|m4a)$/i;
    const file = decodeURIComponent(String(url || "").split("/").pop() || "");
    const ext = (file.match(EXT) || [".png"])[0].toLowerCase();
    const title = String(this.titleOf(task, url) || "").trim();
    const base = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!base) return `作品${ext}`;
    // 旧作品没有提示词时 titleOf 会退回 1.png：至少给个不重名的兜底
    if (/^\d+\.[a-z0-9]{2,5}$/i.test(base)) {
      return `作品_${(task?.id || "01").slice(-4)}${ext}`;
    }
    if (EXT.test(base)) return base;
    return `${base}${ext}`;
  },

  /* 改名：画布节点、图库、预览面板共用 */
  async renameMedia(task, url) {
    if (!task?.id) return;
    const current = this.titleOf(task, url);
    const name = await Dialog.prompt({
      title: "重命名素材",
      label: "改一个自己认得出来的名字（留空恢复默认）",
      value: current,
      placeholder: "例如：荷塘白裙 01",
      confirmText: "保存",
    });
    if (name === null) return false;
    try {
      const result = await API.renameMedia(task.id, url, name);
      task.image_names = result.image_names || {};
      toast(name ? "名称已更新" : "已恢复默认名称");
      window.Main?.refreshAll();
      return true;
    } catch (error) {
      Dialog.warn({ title: "改名失败", message: error.message });
      return false;
    }
  },

  preview(taskId, src) {
    const task = State.tasks.find((item) => item.id === taskId) || {};
    const [w, h] = sizeForParams(task.params);
    const created = task.created_at
      ? new Date(task.created_at * 1000).toLocaleString("zh-CN", { hour12: false })
      : "—";
    const negative = task.negative || DEFAULT_NEGATIVE;
    const video = task.kind === "video" || /\.(mp4|webm|mov|mkv)$/i.test((task.images || [])[0] || "");
    const loras = Array.isArray(task.loras) ? task.loras : null;
    const loraText = loras === null ? "旧记录未保存 LoRA 信息"
      : loras.length ? "" : "未使用 LoRA";
    const items = [
      ["素材名称", this.titleOf(task, src || (task.images || [])[0] || ""), "mono"],
      [video ? "视频底模" : "生图底模", task.model || "Z-Image-Turbo", "mono"],
      ["分辨率", `${task.width || w} × ${task.height || h} 像素`, "mono"],
    ];
    if (video) {
      const real = task.duration ? `${Number(task.duration).toFixed(2)} 秒` : "";
      const want = `${Number(task.params?.duration || 3)} 秒`;
      items.push(["视频参数",
        `${real ? `${real}（设置 ${want}）` : want} · 质量 ${Number(task.params?.quality ?? 1).toFixed(1)} · 24fps`,
        "mono"]);
    }
    items.push(
      ["LoRA", loraText, loras && loras.length ? "lora" : "mono"],
      ["正面提示词", task.prompt || "—", "positive"],
      ["负面提示词", negative, "negative"],
      ["生成时间", created, "mono"],
    );
    $("#lightboxInfoBody").innerHTML = items.map(([label, value, kind]) => {
      const isPrompt = kind === "positive" || kind === "negative";
      const isLora = kind === "lora";
      return `
        <div class="info-item ${kind}">
          ${isPrompt
            ? `<div class="info-label-row"><span>${label}</span><button class="copy-btn" data-copy="${kind}">${icon("copy")}复制</button></div>`
            : `<span>${label}</span>`}
          ${isPrompt
            ? `<div class="prompt-box">${escapeHtml(value)}</div>`
            : isLora
              ? `<div class="lora-list">${loras.map((lora) => `
                  <div class="lora-row">
                    <span class="lora-name" title="${escapeHtml(lora.name)}">${escapeHtml(lora.name)}</span>
                    <span class="lora-weight">${Number(lora.strength).toFixed(2)}</span>
                  </div>`).join("")}</div>`
              : `<p class="mono">${escapeHtml(value)}</p>`}
        </div>`;
    }).join("");
    $("#lightboxInfoTitle").textContent = "生图信息";
    this._previewTask = task;
    this._previewIndex = Math.max(0, (task.images || []).indexOf(src));
    this._previewSrc = src;
    this.renderPreviewImage();
    $("#lightbox").hidden = false;
  },

  /* 素材预览：ComfyUI 目录里的文件没有任务记录，只显示文件信息；视频/音频可直接播放 */
  previewAsset(item) {
    this.prepareZoom();
    const media = $("#lightboxMedia");
    const img = $("#lightboxImg");
    $("#lightboxInfoTitle").textContent = "素材信息";
    this._previewTask = null;
    this._previewSrc = item.url;
    if (item.kind === "image") {
      media.hidden = true;
      media.innerHTML = "";
      img.hidden = false;
      img.src = item.url;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      media.hidden = false;
      media.innerHTML = item.kind === "video"
        ? `<video src="${item.url}" controls autoplay playsinline></video>`
        : `<audio src="${item.url}" controls autoplay></audio>`;
    }

    const source = item.source === "output" ? "输出目录"
      : item.source === "project" ? "本项目作品"
        : item.source === "input" ? "输入目录" : "—";
    const size = item.width && item.height ? `${item.width} × ${item.height} 像素` : "—";
    const created = item.mtime
      ? new Date(item.mtime * 1000).toLocaleString("zh-CN", { hour12: false })
      : "—";
    const items = [
      ["文件", item.name || "—", "mono"],
      ["类型", { image: "图片", video: "视频", audio: "音频" }[item.kind] || "素材", "mono"],
      ["尺寸", size, "mono"],
      ["来源", source, "mono"],
      ["修改时间", created, "mono"],
    ];
    $("#lightboxInfoBody").innerHTML = items.map(([label, value, kind]) => `
      <div class="info-item ${kind}">
        <span>${label}</span>
        <p class="mono">${escapeHtml(value)}</p>
      </div>`).join("");

    $("#lightboxPrev").hidden = true;
    $("#lightboxNext").hidden = true;
    $("#lightboxCounter").hidden = true;
    $("#lightbox").hidden = false;
  },

  renderPreviewImage() {
    this.prepareZoom();
    const images = this._previewTask?.images || [];
    if (!images.length) return;
    this._previewIndex = (this._previewIndex + images.length) % images.length;
    const src = images[this._previewIndex];
    this._previewSrc = src;

    const media = $("#lightboxMedia");
    const img = $("#lightboxImg");
    if (/\.(mp4|webm|mov|mkv)$/i.test(src)) {
      img.hidden = true;
      img.removeAttribute("src");
      media.hidden = false;
      media.innerHTML = `<video src="${src}" controls autoplay loop playsinline></video>`;
    } else {
      media.hidden = true;
      media.innerHTML = "";
      img.hidden = false;
      img.src = src;
    }

    const multiple = images.length > 1;
    $("#lightboxPrev").hidden = !multiple;
    $("#lightboxNext").hidden = !multiple;
    $("#lightboxCounter").hidden = !multiple;
    $("#lightboxCounter").textContent = `${this._previewIndex + 1} / ${images.length}`;
  },

  stepPreview(delta) {
    this._previewIndex += delta;
    this.renderPreviewImage();
  },

  /* ---------- 生图信息弹窗：滚轮以鼠标所在点为中心缩放 ---------- */
  bindLightboxZoom() {
    const stage = $(".lightbox-stage");
    const img = $("#lightboxImg");
    if (!stage || !img) return;

    img.addEventListener("load", () => this.prepareZoom());
    img.addEventListener("dblclick", () => this.resetZoom());

    stage.addEventListener("wheel", (event) => {
      if ($("#lightbox").hidden || img.hidden || !img.naturalWidth) return;
      event.preventDefault();
      if (!this._zoomBase) this.prepareZoom();
      const base = this._zoomBase;
      if (!base) return;
      const from = this._zoom.scale;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      // 最大放到 1:1 原图像素（再往上就是插值放大了），小图至少也能放到 2×
      const nativeRatio = Math.max(img.naturalWidth / base.w, img.naturalHeight / base.h);
      const maxScale = Math.min(8, Math.max(2, nativeRatio));
      const to = Math.min(maxScale, Math.max(1, from * factor));
      if (Math.abs(to - from) < 0.001) return;
      if (to === 1) return void this.resetZoom();
      // 以鼠标为中心：布局尺寸按 to 重排后，把鼠标下的那个点用 translate 拉回原位
      const center = this._zoomCenter || { x: event.clientX, y: event.clientY };
      const dx = event.clientX - center.x;
      const dy = event.clientY - center.y;
      this._zoom = {
        scale: to,
        tx: dx - (dx - this._zoom.tx) * (to / from),
        ty: dy - (dy - this._zoom.ty) * (to / from),
      };
      this.applyZoom();
    }, { passive: false });

    // 放大之后按住图片可以拖动查看其它区域
    img.addEventListener("pointerdown", (event) => {
      if (this._zoom.scale <= 1.001 || event.button !== 0) return;
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY, tx: this._zoom.tx, ty: this._zoom.ty };
      img.setPointerCapture(event.pointerId);
      const move = (ev) => {
        this._zoom.tx = start.tx + ev.clientX - start.x;
        this._zoom.ty = start.ty + ev.clientY - start.y;
        this.applyZoom();
      };
      const end = () => {
        img.removeEventListener("pointermove", move);
        img.removeEventListener("pointerup", end);
        img.removeEventListener("pointercancel", end);
        img.classList.remove("panning");
      };
      img.classList.add("panning");
      img.addEventListener("pointermove", move);
      img.addEventListener("pointerup", end);
      img.addEventListener("pointercancel", end);
    });
  },

  /* 记录 1× 时的显示尺寸与中心：放大时按这个尺寸等比放大布局，而不是缩放位图 */
  prepareZoom() {
    const img = $("#lightboxImg");
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._zoomBase = null;
    this._zoomCenter = null;
    img.style.width = "";
    img.style.height = "";
    img.style.maxWidth = "";
    img.style.maxHeight = "";
    img.style.transform = "";
    img.classList.remove("zoomed");
    this.updateZoomBadge();
    if (img.hidden || !img.complete || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this._zoomBase = { w: rect.width, h: rect.height };
    this._zoomCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },

  applyZoom() {
    const img = $("#lightboxImg");
    const base = this._zoomBase;
    const { scale, tx, ty } = this._zoom;
    if (base && scale > 1.001) {
      // 关键：改布局尺寸（width/height），浏览器会按新尺寸重新栅格化，放大后不糊
      img.style.maxWidth = "none";
      img.style.maxHeight = "none";
      img.style.width = `${Math.round(base.w * scale)}px`;
      img.style.height = `${Math.round(base.h * scale)}px`;
      img.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
      img.classList.add("zoomed");
    } else {
      img.style.width = "";
      img.style.height = "";
      img.style.maxWidth = "";
      img.style.maxHeight = "";
      img.style.transform = "";
      img.classList.remove("zoomed");
    }
    this.updateZoomBadge();
  },

  updateZoomBadge() {
    const badge = $("#lightboxZoom");
    if (!badge) return;
    const on = this._zoom.scale > 1.001;
    badge.hidden = !on;
    if (on) badge.textContent = `${Math.round(this._zoom.scale * 100)}%`;
  },

  resetZoom() {
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this.applyZoom();
  },

  closePreview() {
    this.resetZoom();
    $("#lightbox").hidden = true;
    // 清空播放器，避免音频在弹窗关掉后继续响
    const media = $("#lightboxMedia");
    media.innerHTML = "";
    media.hidden = true;
    Gallery.resume();
  },

  async copyPrompt(kind) {
    const task = this._previewTask;
    if (!task) return;
    const text = kind === "negative"
      ? (task.negative || DEFAULT_NEGATIVE)
      : (task.prompt || "");
    const label = kind === "negative" ? "负面提示词" : "正面提示词";
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
      toast(`已复制${label}`);
    }
  },

  setViewMode(mode) {
    State.viewMode = mode;
    localStorage.setItem("wwdm-view-mode", mode);   // 刷新后停在当前页面
    document.documentElement.dataset.view = mode;   // 首屏样式跟当前视图保持一致
    const textMode = mode === "text";
    $("#worksGrid").hidden = mode !== "card";
    $("#canvasView").hidden = mode !== "canvas";
    $("#notesView").hidden = !textMode;
    $("#emptyState").hidden = textMode || State.tasks.length > 0;
    // 文本模式是一整页笔记；画布模式改用画布内创作区，底部创作框都收起来
    $("#composerRegion").hidden = textMode || mode === "canvas";
    $$("#viewSwitch button").forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
    window.Canvas?.onView(mode);
    if (mode !== "canvas") {
      // 画布有自己的相机缩放，离开后把顶栏还原成卡片模式的缩放
      State.zoom = State.cardZoom || 1;
      $("#worksGrid").style.zoom = State.zoom;
      $("#zoomLabel").textContent = `${Math.round(State.zoom * 100)}%`;
    }
    if (textMode) Notes.load();
  },

  bind() {
    $("#viewSwitch").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-mode]");
      if (btn) this.setViewMode(btn.dataset.mode);
    });
    this.bindLightboxZoom();
    $("#lightboxClose").addEventListener("click", () => this.closePreview());
    $("#lightboxDownload").addEventListener("click", () => {
      const src = this._previewSrc || this._previewTask?.images?.[this._previewIndex];
      if (!src) return;
      const link = document.createElement("a");
      link.href = src;
      const suffix = this._previewTask ? `_${this._previewIndex + 1}` : "";
      link.download = `${this._previewTask?.id || "asset"}${suffix}${src.slice(src.lastIndexOf("."))}`;
      link.click();
    });
    $("#lightboxPrev").addEventListener("click", () => this.stepPreview(-1));
    $("#lightboxNext").addEventListener("click", () => this.stepPreview(1));
    $("#lightboxInfoBody").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-copy]");
      if (btn) this.copyPrompt(btn.dataset.copy);
    });
    document.addEventListener("keydown", (event) => {
      if ($("#lightbox").hidden) return;
      if (event.key === "ArrowLeft") this.stepPreview(-1);
      if (event.key === "ArrowRight") this.stepPreview(1);
    });
    $("#lightbox").addEventListener("click", (event) => {
      if (event.target.id === "lightbox") this.closePreview();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || $("#lightbox").hidden) return;
      // 关掉详情后可能回到图库，必须吃掉这次 Esc，否则图库的 Esc 监听会立刻又把它关掉
      event.stopImmediatePropagation();
      this.closePreview();
    });
  },
};

// Works 是顶层 const，不挂到 window 上时（card-menu / gallery / 画布）判断会永远拿到 undefined
window.Works = Works;
