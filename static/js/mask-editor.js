/* 局部重绘：在作品图上涂遮罩（红色区域），提交给「局部重绘」工作流只重画这块。
   遮罩按 ComfyUI 的约定导出成「该区域透明」的 PNG —— LoadImage 的 MASK 输出就是 1 - alpha。 */
const MaskEditor = {
  source: null,         // {url, name, projectId, onCreated} —— 提交后落点由 onCreated 决定
  image: null,
  strokes: [],          // [{tool, size(原图半径), points:[{x,y}]}]
  tool: "brush",
  brush: 56,            // 笔刷直径（屏幕像素）
  mask: null,           // 原图尺寸的遮罩画布（红笔迹，导出时当 alpha 用）
  maskCtx: null,
  view: { w: 0, h: 0, scale: 1 },
  drawing: null,
  raf: 0,
  busy: false,

  init() {
    $("#maskClose").addEventListener("click", () => this.close());
    $("#maskCancel").addEventListener("click", () => this.close());
    $("#maskLayer").addEventListener("click", (event) => {
      if (event.target === $("#maskLayer")) this.close();
    });
    $("#maskSubmit").addEventListener("click", () => this.submit());
    $("#maskUndo").addEventListener("click", () => this.undo());
    $("#maskClear").addEventListener("click", () => this.clear());
    $("#maskBrush").addEventListener("input", (event) => this.setBrush(event.target.value));
    $$("[data-mask-tool]").forEach((btn) => {
      btn.addEventListener("click", () => this.setTool(btn.dataset.maskTool));
    });

    const canvas = $("#maskCanvas");
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    canvas.addEventListener("pointerleave", () => { $("#maskRing").hidden = true; });
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });

    window.addEventListener("resize", () => {
      if (!$("#maskLayer").hidden) this.layout();
    });
    $("#maskWorkflow").addEventListener("change", (event) => {
      this.loadWorkflowParams(event.target.value);
    });
    $("#maskDenoise").addEventListener("input", () => {
      this.renderNote(this.workflowList().find((wf) => wf.id === $("#maskWorkflow").value));
    });
    document.addEventListener("keydown", (event) => {
      if ($("#maskLayer").hidden) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
      if (event.key === "Escape") return this.close();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        return this.undo();
      }
      // Ctrl+Enter 直接提交，B / E 切画笔和橡皮（在输入框里打字时不拦）
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        return this.submit();
      }
      if (typing) return;
      if (event.key.toLowerCase() === "b") return this.setTool("brush");
      if (event.key.toLowerCase() === "e") return this.setTool("eraser");
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        this.setBrush(this.brush + (event.key === "]" ? 8 : -8));
      }
    });
  },

  // ---------- 打开 / 关闭 ----------
  /* options: {url, name, projectId, onCreated(created), sourceLabel}
     作品卡片和画布节点都走这一个入口，提交后的落点由 onCreated 决定 */
  open(options = {}) {
    const url = String(options.url || "");
    if (!url) return toast("这里还没有图片", true);
    if (/\.(mp4|webm|mov|mkv)$/i.test(url)) {
      return toast("局部重绘只能用在图片上", true);
    }
    const list = this.workflowList();
    if (!list.length) {
      const all = (State.workflows || []).filter((wf) => wf.category === "inpaint");
      return Dialog.warn({
        title: "没有可用的局部重绘工作流",
        message: all.length
          ? "这些工作流在当前 ComfyUI 实例上跑不起来：" + all.map(
              (wf) => `${wf.name || wf.id}（${wf.unavailable_reason || "缺少节点或模型"}）`).join("；")
          : "需要先有一个「局部重绘」类型的工作流（放在 workflows/ 目录里、category 设为 inpaint）。",
      });
    }

    this.source = options;
    this.image = null;
    this.strokes = [];
    this.mask = null;
    this.maskCtx = null;
    this.drawing = null;
    this.busy = false;
    this.tool = "brush";
    this.setBrush(this.brush, true);

    const name = options.name || decodeURIComponent(url.split("/").pop() || "");
    $("#maskSub").textContent = options.label ? `${options.label} · ${name}` : name;
    $("#maskDims").textContent = options.width && options.height ? `${options.width} × ${options.height}` : "—";
    $("#maskArea").textContent = "0%";
    $("#maskPrompt").value = "";
    $("#maskNegative").value = "";
    $("#maskDenoise").value = "1";
    $("#maskGrow").value = "6";
    $("#maskTip").textContent = "先涂要重绘的区域";
    $("#maskTip").classList.remove("warn");
    $("#maskLoading").hidden = false;
    $("#maskLoading").textContent = "正在载入图片…";
    this.fillWorkflows(list);
    this.syncSubmit();
    $("#maskLayer").hidden = false;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.image = img;
      this.mask = document.createElement("canvas");
      this.mask.width = img.naturalWidth;
      this.mask.height = img.naturalHeight;
      this.maskCtx = this.mask.getContext("2d");
      $("#maskDims").textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      $("#maskLoading").hidden = true;
      this.layout();
    };
    img.onerror = () => {
      $("#maskLoading").textContent = "图片载入失败，换一张试试";
    };
    img.src = url;
  },

  close() {
    if (this.busy) return;         // 提交中不让关，避免半途中断
    $("#maskLayer").hidden = true;
    $("#maskRing").hidden = true;
    this.source = null;
    this.image = null;
    this.mask = null;
    this.maskCtx = null;
    this.strokes = [];
    this.drawing = null;
  },

  workflowList() {
    // 当前实例缺节点 / 缺模型的工作流不列出来（比如远程实例没装某个 inpaint 节点）
    return (State.workflows || []).filter(
      (wf) => wf.category === "inpaint" && wf.available !== false);
  },

  fillWorkflows(list) {
    const select = $("#maskWorkflow");
    const saved = localStorage.getItem("wwdm-mask-workflow") || "";
    select.innerHTML = list.map((wf) => `
      <option value="${escapeHtml(wf.id)}">${escapeHtml(wf.name || wf.id)}</option>`).join("");
    const pick = list.find((wf) => wf.id === saved) || list[0];
    select.value = pick.id;
    this.loadWorkflowParams(pick.id);
  },

  /* 选中工作流的关键参数：重绘幅度 / 遮罩外扩 先按设置里的值填好，可以直接在弹窗里改 */
  async loadWorkflowParams(workflowId) {
    const denoise = $("#maskDenoise");
    const grow = $("#maskGrow");
    const wf = this.workflowList().find((item) => item.id === workflowId);
    let saved = {};
    try {
      const info = await API.workflowParams(workflowId);
      saved = { ...(info.defaults || {}), ...(info.saved || {}) };
    } catch { /* 拿不到就沿用图里的默认值 */ }
    this.params = saved;
    const d = Number(saved.denoise);
    if (denoise) denoise.value = String(Number.isFinite(d) && d > 0 ? Math.min(1, d) : 1);
    const g = Number(saved.grow_mask_by);
    if (grow) grow.value = String(Number.isFinite(g) && g >= 0 ? Math.round(g) : 6);
    this.renderNote(wf);
  },

  /* 弹窗底部这行提示：工作流自己的注意点 + 当前 denoise + 去哪改其它参数 */
  renderNote(wf) {
    const box = $("#maskNote");
    if (!box) return;
    const bits = [];
    if (wf?.inpaint_note) bits.push(wf.inpaint_note);
    const denoise = Number($("#maskDenoise")?.value);
    if (Number.isFinite(denoise) && denoise > 0 && denoise < 1) {
      bits.push("denoise 小于 1 时遮罩区可能留下灰底");
    }
    bits.push(`步数等其余参数在「设置 → 图片参数 → ${wf?.name || "该工作流"}」里调，这里的改动只对本次提交生效`);
    box.textContent = bits.join(" · ");
  },

  // ---------- 画布 ----------
  layout() {
    const stage = $("#maskStage");
    const canvas = $("#maskCanvas");
    if (!this.image || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const availW = Math.max(80, stage.clientWidth - 2);
    const availH = Math.max(80, stage.clientHeight - 2);
    const scale = Math.min(availW / this.image.naturalWidth, availH / this.image.naturalHeight, 2);
    this.view.scale = scale || 1;
    this.view.w = Math.max(1, Math.round(this.image.naturalWidth * this.view.scale));
    this.view.h = Math.max(1, Math.round(this.image.naturalHeight * this.view.scale));
    canvas.width = Math.round(this.view.w * dpr);
    canvas.height = Math.round(this.view.h * dpr);
    canvas.style.width = `${this.view.w}px`;
    canvas.style.height = `${this.view.h}px`;
    this.render();
  },

  render() {
    const canvas = $("#maskCanvas");
    const ctx = canvas.getContext("2d");
    if (!ctx || !this.image) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.view.w, this.view.h);
    ctx.drawImage(this.image, 0, 0, this.view.w, this.view.h);
    if (this.mask) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.mask, 0, 0, this.view.w, this.view.h);
      ctx.restore();
    }
  },

  /* 屏幕坐标 → 原图坐标 */
  pointOf(event) {
    const rect = $("#maskCanvas").getBoundingClientRect();
    const sx = this.image.naturalWidth / rect.width;
    const sy = this.image.naturalHeight / rect.height;
    return {
      x: Math.max(0, Math.min(this.image.naturalWidth, (event.clientX - rect.left) * sx)),
      y: Math.max(0, Math.min(this.image.naturalHeight, (event.clientY - rect.top) * sy)),
      screenX: event.clientX - rect.left,
      screenY: event.clientY - rect.top,
    };
  },

  pointerDown(event) {
    if (event.button !== 0 || !this.image || this.busy) return;
    event.preventDefault();
    $("#maskCanvas").setPointerCapture?.(event.pointerId);
    const point = this.pointOf(event);
    const stroke = {
      tool: this.tool,
      // 笔刷按屏幕像素给，落到原图上要除以缩放比
      size: Math.max(1, (this.brush / 2) / this.view.scale),
      points: [{ x: point.x, y: point.y }],
    };
    this.drawing = stroke;
    this.drawDot(stroke, point);
    this.paint();
  },

  pointerMove(event) {
    if (!this.image) return;
    this.moveRing(event);
    if (!this.drawing) return;
    event.preventDefault();
    const point = this.pointOf(event);
    const points = this.drawing.points;
    const last = points[points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < 0.6) return;
    points.push({ x: point.x, y: point.y });
    this.drawSegment(this.drawing, last, point);
    this.paint();
  },

  pointerUp(event) {
    if (!this.drawing) return;
    $("#maskCanvas").releasePointerCapture?.(event.pointerId);
    this.strokes.push(this.drawing);
    this.drawing = null;
    this.maskStroke = null;
    this.updateArea();
    this.syncSubmit();
  },

  wheel(event) {
    if (!this.image) return;
    event.preventDefault();
    this.setBrush(this.brush - Math.sign(event.deltaY) * 6);
    this.moveRing(event);
  },

  moveRing(event) {
    const ring = $("#maskRing");
    const stage = $("#maskStage");
    const rect = $("#maskCanvas").getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) { ring.hidden = true; return; }
    ring.hidden = false;
    ring.style.width = `${this.brush}px`;
    ring.style.height = `${this.brush}px`;
    ring.style.left = `${event.clientX - stageRect.left}px`;
    ring.style.top = `${event.clientY - stageRect.top}px`;
  },

  drawDot(stroke, point) {
    const ctx = this.maskCtx;
    if (!ctx) return;
    this.applyStyle(ctx, stroke);
    ctx.beginPath();
    ctx.arc(point.x, point.y, stroke.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  drawSegment(stroke, from, to) {
    const ctx = this.maskCtx;
    if (!ctx) return;
    this.applyStyle(ctx, stroke);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  },

  applyStyle(ctx, stroke) {
    ctx.save();
    ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ff3b6b";
    ctx.fillStyle = "#ff3b6b";
    ctx.lineWidth = stroke.size * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  },

  paint() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  },

  // ---------- 工具 ----------
  setTool(tool) {
    this.tool = tool === "eraser" ? "eraser" : "brush";
    $$("[data-mask-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.maskTool === this.tool);
    });
  },

  setBrush(value, silent = false) {
    const next = Math.max(4, Math.min(240, Math.round(Number(value) || 56)));
    this.brush = next;
    $("#maskBrush").value = String(next);
    $("#maskBrushSize").textContent = String(next);
    $("#maskRing").style.width = `${next}px`;
    $("#maskRing").style.height = `${next}px`;
    if (!silent) this.syncSubmit();
  },

  undo() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.rebuild();
  },

  clear() {
    if (!this.strokes.length) return;
    this.strokes = [];
    this.rebuild();
  },

  rebuild() {
    if (!this.maskCtx || !this.mask) return;
    this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
    this.strokes.forEach((stroke) => {
      const points = stroke.points;
      if (points.length === 1) return this.drawDot(stroke, points[0]);
      for (let i = 1; i < points.length; i += 1) this.drawSegment(stroke, points[i - 1], points[i]);
    });
    this.render();
    this.updateArea();
    this.syncSubmit();
  },

  /* 遮罩占比：只数采样后的小图，够用又不会卡 */
  updateArea() {
    if (!this.mask) return;
    const sample = document.createElement("canvas");
    sample.width = 128;
    sample.height = Math.max(1, Math.round(128 * this.mask.height / this.mask.width));
    const ctx = sample.getContext("2d");
    ctx.drawImage(this.mask, 0, 0, sample.width, sample.height);
    let painted = 0;
    try {
      const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 24) painted += 1;
    } catch { /* 读不到像素就不显示占比 */ }
    const total = sample.width * sample.height || 1;
    const percent = Math.round(painted / total * 100);
    $("#maskArea").textContent = `${percent}%`;
    if (percent > 88) this.tip("遮罩几乎铺满整张图，效果会接近整图重画", true);
    else if (percent === 0) this.tip("先涂要重绘的区域", true);
    else this.tip("可以继续补涂，或直接提交");
  },

  tip(text, warn = false) {
    const box = $("#maskTip");
    box.textContent = text;
    box.classList.toggle("warn", warn);
  },

  syncSubmit() {
    const btn = $("#maskSubmit");
    if (!btn) return;
    const ok = this.strokes.length > 0 && !!this.image && !this.busy;
    btn.disabled = !ok;
    btn.innerHTML = this.busy
      ? "提交中…"
      : `<svg class="tiny"><use href="#i-sparkle"/></svg>开始重绘`;
  },

  // ---------- 提交 ----------
  exportBlob() {
    const out = document.createElement("canvas");
    out.width = this.image.naturalWidth;
    out.height = this.image.naturalHeight;
    const ctx = out.getContext("2d");
    ctx.drawImage(this.image, 0, 0);
    // 把涂过的地方抠成透明：LoadImage 的 MASK = 1 - alpha，正好对上
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(this.mask, 0, 0);
    return new Promise((resolve, reject) => {
      out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("遮罩图导出失败"))), "image/png");
    });
  },

  async submit() {
    if (this.busy) return;
    if (!this.image) return toast("图片还没载入完", true);
    if (!this.strokes.length) return this.tip("先在图上涂出要重绘的区域", true);
    const select = $("#maskWorkflow");
    const wf = this.workflowList().find((item) => item.id === select.value);
    if (!wf) return toast("请选择重绘工作流", true);
    const prompt = $("#maskPrompt").value.trim();
    if (wf.supports_prompt !== false && !prompt) {
      $("#maskPrompt").focus();
      return this.tip("写一句遮罩区域要画成什么", true);
    }

    const projectId = this.source?.projectId || State.activeId;
    this.busy = true;
    this.syncSubmit();
    this.tip("正在提交…");
    try {
      const blob = await this.exportBlob();
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const file = new File([blob], `inpaint-${stamp}.png`, { type: "image/png" });
      const uploaded = await API.uploadReferences([file], projectId);
      const image = uploaded?.items?.[0]?.name;
      if (!image) throw new Error("遮罩图上传失败");
      // 弹窗里改的重绘幅度 / 遮罩外扩 / 负面提示词只对这一张生效（不改设置里的默认值）
      const workflowParams = {};
      const denoise = Number($("#maskDenoise").value);
      const grow = Number($("#maskGrow").value);
      const negative = $("#maskNegative").value.trim();
      if (Number.isFinite(denoise) && denoise > 0) workflowParams.denoise = Math.min(1, denoise);
      if (Number.isFinite(grow) && grow >= 0) workflowParams.grow_mask_by = Math.round(grow);
      if (negative) workflowParams.negative = negative;
      const created = await API.generate({
        project_id: projectId,
        prompt,
        workflow: wf.id,
        params: { image },
        workflow_params: workflowParams,
      });
      if (created?.warnings?.length) toast(created.warnings[0], true);
      const onCreated = this.source?.onCreated;
      localStorage.setItem("wwdm-mask-workflow", wf.id);
      this.busy = false;
      this.close();
      if (typeof onCreated === "function") {
        onCreated(created);
      } else if (typeof CardMenu !== "undefined" && CardMenu.adoptTask) {
        // CardMenu 是顶层 const（不在 window 上），直接按标识符调用
        CardMenu.adoptTask(created);
      } else if (window.Main?.refreshAll) {
        toast("已提交局部重绘");
        window.Main.refreshAll();
      } else toast("已提交局部重绘");
    } catch (error) {
      this.busy = false;
      this.syncSubmit();
      this.tip("提交失败，可以重试", true);
      Dialog.warn({ title: "局部重绘失败", message: error.message });
    }
  },
};
