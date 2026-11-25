/* 画布内创作区：合一创作节点（图片 / 视频 / 提示词可切换），创作区跟随该节点。
   文本 / 素材节点是纯输入节点，不挂创作区。 */
const CanvasComposer = {
  nodeId: "",
  mode: "gen",          // 只服务合一创作节点
  draft: null,
  _loading: false,
  _saveTimer: null,

  KIND_LABEL: { image: "图片", video: "视频", prompt: "提示词" },
  KIND_ICON: { image: "image", video: "video", prompt: "text" },
  MEDIA_LABEL: { image: "图片", video: "视频", audio: "音频" },

  init() {
    this.bind();
  },

  visible() { return !$("#cvComposer").hidden; },

  gen() {
    return this.mode === "gen" ? Canvas.layout().gens?.[this.nodeId] || null : null;
  },

  state() {
    return this.mode === "gen" ? this.gen() : this.draft;
  },

  target() { return Canvas.byId(this.nodeId); },

  showFor(nodeId) {
    // 创作区只跟生成节点；文本 / 素材节点是纯输入，不弹创作区
    if (Canvas.byId(nodeId)?.type === "gen") this.openFor(nodeId);
    else this.hide();
  },

  openFor(nodeId) {
    const node = Canvas.byId(nodeId);
    // 创作节点合一：创作区只挂在唯一的「创作节点」上；文本 / 素材节点是纯输入，不挂创作区
    if (!node || node.type !== "gen" || State.viewMode !== "canvas") return this.hide();
    this.nodeId = nodeId;
    this.mode = "gen";
    this.draft = null;
    this.show();
    this.follow();
    this.syncAll();
    const textarea = $("#cvPrompt");
    textarea.value = textarea.disabled ? "" : (this.gen()?.prompt || "");
    this.autoGrow();
  },

  show() {
    $("#cvComposer").hidden = false;
    const tip = $("#canvasBottomTip");
    if (tip) tip.hidden = true;
  },

  /* 创作区跟随选中节点：横向居中对齐节点，优先放在节点下方，空间不够就翻到上方 */
  follow() {
    if (!this.visible()) return;
    const nodeEl = Canvas.elOf(this.nodeId);
    const view = $("#canvasView");
    const composer = $("#cvComposer");
    if (!nodeEl || !view || !composer || composer.hidden) return;
    const vr = view.getBoundingClientRect();
    const nr = nodeEl.getBoundingClientRect();
    const width = composer.offsetWidth;
    const height = composer.offsetHeight;
    const pad = 12;
    const gap = 14;
    let left = nr.left + nr.width / 2 - width / 2 - vr.left;
    left = Math.max(pad, Math.min(left, vr.width - width - pad));
    let top = nr.bottom - vr.top + gap;
    if (top + height > vr.height - pad) {
      const above = nr.top - vr.top - height - gap;
      top = above >= pad ? above : Math.max(pad, vr.height - height - pad);
    }
    composer.style.left = `${Math.round(left)}px`;
    composer.style.top = `${Math.round(top)}px`;
  },

  hide() {
    $("#cvComposer").hidden = true;
    this.closePops();
    const tip = $("#canvasBottomTip");
    if (tip) tip.hidden = false;
    this.nodeId = "";
    this.draft = null;
  },

  // ---------- 数据 ----------
  workflowOptions() {
    const state = this.state();
    const kind = state?.kind || "image";
    const type = kind === "prompt" ? "llm" : kind;
    // 局部重绘默认不出现在下拉里；但这个节点本身就是局部重绘结果时要能显示自己的来源，
    // 否则下拉会悄悄跳到别的工作流，看着像被换掉了
    const list = (State.workflows || []).filter(
      (wf) => (wf.kind || "image") === type && wf.category !== "inpaint" && wf.category !== "tool"
        && wf.available !== false);
    const own = (State.workflows || []).find((wf) => wf.id === state?.workflow);
    if (own && own.category === "inpaint" && !list.some((wf) => wf.id === own.id)) {
      list.unshift(own);
    }
    // 节点自己用的工作流即使这台实例跑不起来也留着，好让标签显示真实来源（生成时再报原因）
    if (own && own.available === false && !list.some((wf) => wf.id === own.id)) {
      list.unshift(own);
    }
    return list;
  },

  currentWorkflow() {
    const state = this.state();
    if (!state) return null;
    const list = this.workflowOptions();
    return list.find((wf) => wf.id === state.workflow) || list[0] || null;
  },

  kindOf(wf) {
    const kind = wf?.kind || "image";
    return kind === "llm" ? "prompt" : kind;
  },

  /* 当前工作流是不是吃多模态参考（图 + 视频 + 音频一起进同一个任务） */
  multiModal(wf = this.currentWorkflow()) {
    const limits = wf?.limits || {};
    return limits.videos != null || limits.audios != null;
  },

  refs() {
    const state = this.state();
    if (!state) return [];
    const manual = (state.refs || []).map((ref, index) => ({ ...ref, auto: false, manualIndex: index }));
    let auto = [];
    if (state.autoRef !== false) {
      auto = Canvas.directInputsOf(this.nodeId).flatMap((nodeId) => Canvas.refsOf(nodeId)).map((ref) => ({ ...ref, auto: true }));
    }
    const seen = new Set();
    return [...auto, ...manual].filter((ref) => {
      const key = `${ref.source}:${ref.name}`;
      if (!ref.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  refUrl(ref) {
    if (ref.url) return ref.url;
    if (ref.source === "project") return ref.name;
    if (ref.source === "library") {
      // 资产库：name 是「分类/文件名」
      const [category, ...rest] = String(ref.name || "").split("/");
      return `/api/library/file?category=${encodeURIComponent(category)}&name=${encodeURIComponent(rest.join("/"))}`;
    }
    return API.comfyFileUrl(ref.source || "input", ref.name);
  },

  functionLabel(key) {
    return Composer.functions.find((item) => item.key === key)?.label || "提示词润色";
  },

  guessFunction(media) {
    const kinds = new Set(media.map((item) => item.kind || "image"));
    if (kinds.has("video") || kinds.has("audio")) return "minimax";
    if (media.length > 1) return "edit";
    if (media.length === 1) return "reverse";
    return "polish";
  },

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      if (this.mode === "gen") Canvas.save();
    }, 260);
  },

  // ---------- 渲染 ----------
  syncAll() {
    const node = this.target();
    const state = this.state();
    if (!node || !state) return this.hide();
    // 编辑标题已去掉：创作区只保留内容本身
    $("#cvKindLabel").textContent = this.KIND_LABEL[state.kind] || "图片";
    $("#cvKindChip use").setAttribute("href", `#i-${this.KIND_ICON[state.kind] || "image"}`);
    $$("#cvKindList [data-kind]").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === state.kind));
    this.renderRefs();
    this.renderLabels();
    this.renderStatus();
    this.syncPromptLock();
    requestAnimationFrame(() => this.follow());
  },

  /* 不需要提示词的工作流（纯放大等）：提示词框置灰只读 */
  syncPromptLock() {
    const el = $("#cvPrompt");
    if (!el) return;
    const wf = this.currentWorkflow();
    const noPrompt = this.state()?.kind !== "prompt" && wf?.supports_prompt === false;
    el.disabled = !!noPrompt;
    el.classList.toggle("is-locked", !!noPrompt);
    el.placeholder = noPrompt
      ? `${wf?.name || "当前工作流"}不需要提示词，左侧放素材即可`
      : "描述画面，或直接连线让上游文本传入…";
    if (noPrompt && el.value.trim()) el.value = "";
  },

  renderRefs() {
    const box = $("#cvRefs");
    const refs = this.refs();
    // 按类型各自编号（图片 1 / 视频 1 / 音频 1），多参考时不会出现「视频 4」这种错位编号
    const counters = { image: 0, video: 0, audio: 0 };
    const per = Number(this.currentWorkflow()?.images_per_task) || 1;
    box.innerHTML = refs.map((ref, index) => {
      const kind = ref.kind || "image";
      const preview = kind === "image"
        ? `<img src="${escapeHtml(this.refUrl(ref))}" alt="" loading="lazy">`
        : kind === "video"
          ? `<video class="ref-video" src="${escapeHtml(this.refUrl(ref))}#t=0.1" muted playsinline preload="metadata"></video>`
          : `<span class="ref-ph">${icon(this.KIND_ICON[kind] || "image")}</span>`;
      const ordinal = (counters[kind] = (counters[kind] || 0) + 1);
      const label = per === 2 && kind === "image"
        ? (index % 2 === 0 ? "首帧" : "尾帧")
        : `${this.MEDIA_LABEL[kind] || "素材"} ${ordinal}`;
      return `
        <div class="ref-chip ${ref.auto ? "auto" : ""}" data-kind="${kind}" data-cv-ref-preview="${index}" title="${this.MEDIA_LABEL[kind] || "素材"} · ${escapeHtml(ref.origin || ref.name)}">
          ${preview}
          <span class="ref-kind">${icon(this.KIND_ICON[kind] || "image")}</span>
          ${ref.auto ? `<span class="ref-auto">${icon("ref")}</span>` : ""}
          <span class="ref-index">${label}</span>
          ${ref.auto ? "" : `<button data-cv-ref-del="${ref.manualIndex}" title="移除">${icon("close")}</button>`}
        </div>`;
    }).join("");
    requestAnimationFrame(() => this.follow());
  },

  renderLabels() {
    const state = this.state();
    if (!state) return;
    const wf = this.currentWorkflow();
    $("#cvWorkflowLabel").textContent = wf?.name || "无可用工作流";
    $("#cvWorkflowChip use").setAttribute("href", `#i-${this.KIND_ICON[state.kind] || "image"}`);
    $("#cvSmartRef").classList.toggle("active", state.autoRef !== false);

    let label = "";
    if (wf?.grid) {
      const rows = Number(state.params?.grid_rows) || Number(wf.grid.rows) || 1;
      const cols = Number(state.params?.grid_cols) || Number(wf.grid.cols) || 1;
      label = `网格 ${rows}×${cols} · ${this.refs().length} 张`;
    } else if (wf?.scale) {
      label = `放大 ×${Number(state.params?.scale || wf.scale.default || 2).toFixed(1)}`;
    } else if (state.kind === "prompt") {
      const fn = state.function || this.guessFunction(this.refs());
      label = `功能 · ${this.functionLabel(fn)}`;
    } else if (state.kind === "video") {
      const p = state.params || {};
      label = `视频 · ${p.video_ratio || "16:9"} · ${Number(p.quality ?? 1).toFixed(1)}MP · ${p.duration || 3}秒`;
    } else {
      const p = state.params || {};
      const sizeOn = wf?.supports_size !== false;
      const batchOn = wf?.supports_batch !== false;
      const parts = [];
      if (sizeOn) {
        const [w, h] = sizeForParams(p);
        parts.push(p.custom ? `自定义 ${w}×${h}` : `${p.ratio || "1:1"} · ${String(p.resolution || "1k").toUpperCase()}`);
      } else {
        parts.push("跟随参考图");
      }
      if (batchOn) parts.push(`${p.batch || 1}张`);
      label = parts.join(" · ");
    }
    $("#cvParamsLabel").textContent = label;

    const upstream = Canvas.upstreamPromptText(this.nodeId);
    const hint = $("#cvUpstreamPrompt");
    if (upstream) {
      const injected = (state.prompt || "").trim() === upstream.trim();
      const preview = upstream.length > 48 ? `${upstream.slice(0, 48)}…` : upstream;
      hint.hidden = false;
      hint.innerHTML = `<span class="cv-upstream-text" title="${escapeHtml(upstream)}">上游文本：${escapeHtml(preview)}</span>
        <button class="cv-upstream-inject" data-cv-inject${injected ? " disabled" : ""}>${injected ? "已传入" : "传入输入框"}</button>`;
    } else {
      hint.hidden = true;
    }
  },

  renderStatus() {
    const status = $("#cvStatus");
    const send = $("#cvSend");
    const state = this.state();
    if (!state) return;
    let busy = this._loading;
    const gen = this.gen();
    const map = {
      idle: "待生成", queued: "排队中", submitting: "提交中",
      running: gen.kind === "prompt" ? "提示词生成中…" : `生成中 ${gen.progress || 0}%`,
      done: "已完成 · 可继续生成", error: gen.error || "生成失败",
      cancelled: "已停止",
    };
    const text = map[gen.status] || "";
    const cls = gen.status === "error" ? "error" : gen.status === "done" ? "done" : "";
    busy = busy || ["queued", "submitting", "running"].includes(gen.status);
    status.textContent = text;
    status.className = `cv-status ${cls}`.trim();
    // 双态按钮：运行中=停止（可点击），平时=生成
    send.disabled = busy ? false : !this.currentWorkflow();
    send.classList.toggle("busy", busy);
    send.classList.toggle("stop", busy);
    const use = send.querySelector("use");
    if (use) use.setAttribute("href", busy ? "#i-stop" : "#i-send");
    send.title = busy ? "停止这个节点的生成" : "生成";
  },

  // ---------- 弹层 ----------
  closePops() {
    $("#cvKindPop").hidden = true;
    $("#cvWorkflowPop").hidden = true;
    $("#cvParamsPop").hidden = true;
  },

  positionPop(pop, anchor) {
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const size = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8));
    // 贴在所点选项正上方；上面放不下才翻到下方
    let top = rect.top - size.height - 8;
    if (top < 8) top = rect.bottom + 8;
    if (top + size.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - size.height - 8);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  },

  toggleKindPop() {
    const pop = $("#cvKindPop");
    const opening = pop.hidden;
    this.closePops();
    if (!opening) return;
    this.positionPop(pop, $("#cvKindChip"));
  },

  toggleWorkflowPop() {
    const pop = $("#cvWorkflowPop");
    const opening = pop.hidden;
    this.closePops();
    if (!opening) return;
    this.renderWorkflowList();
    this.positionPop(pop, $("#cvWorkflowChip"));
  },

  toggleParamsPop() {
    const pop = $("#cvParamsPop");
    const opening = pop.hidden;
    this.closePops();
    if (!opening) return;
    this.renderParamsBody();
    this.positionPop(pop, $("#cvParamsChip"));
  },

  renderWorkflowList() {
    const list = this.workflowOptions();
    const current = this.currentWorkflow();
    const box = $("#cvWorkflowList");
    if (!list.length) {
      box.innerHTML = `<div class="wf-empty">当前类型还没有工作流</div>`;
      return;
    }
    box.innerHTML = list.map((wf) => `
      <button class="workflow-item ${wf.id === current?.id ? "active" : ""}" data-cv-wf="${escapeHtml(wf.id)}">
        <span class="wf-icon">${icon(this.kindOf(wf) === "video" ? "video" : this.kindOf(wf) === "prompt" ? "text" : "image")}</span>
        <span><span class="wf-name">${escapeHtml(wf.name)}</span>
          <span class="wf-desc" style="display:block">${escapeHtml(wf.description || "")} · ${wf.node_count || 0} 节点</span></span>
        <span class="wf-check">${icon("check")}</span>
      </button>`).join("");
  },

  renderParamsBody() {
    const state = this.state();
    const wf = this.currentWorkflow();
    const box = $("#cvParamsBody");
    if (!state) return;
    // 网格工作流：先把行列默认值落进节点参数，界面显示的就是要提交的值
    if (this.ensureGridParams(state) && this.mode === "gen") Canvas.save();
    const p = state.params || {};

    if (state.kind === "prompt") {
      const current = state.function || this.guessFunction(this.refs());
      box.innerHTML = `
        <div class="field">
          <label>提示词功能</label>
          <div class="choice-row">
            ${Composer.functions.map((item) => `
              <button class="choice ${item.key === current ? "active" : ""}" data-cv-fn="${item.key}" title="${escapeHtml(item.desc)}">
                ${escapeHtml(item.label)}
              </button>`).join("")}
          </div>
          <p class="hint">素材会按当前功能自动裁剪：反推取第一张图，图片编辑取全部图片，minimax 取全部图片/视频/音频。</p>
        </div>`;
      return;
    }

    const sizeOn = wf?.supports_size !== false;
    const batchOn = wf?.supports_batch !== false;
    const scale = wf?.scale || null;
    // 网格拼接：在参数体最上面单开一组「行 × 列」，其余保持灰色不可选
    const gridHtml = wf?.grid ? this.gridFieldHtml(wf, p) : "";
    if (state.kind === "image" && gridHtml) {
      box.innerHTML = `${gridHtml}
        <div class="field disabled"><label>图片比例</label><div class="choice-grid">
          ${[...Composer.ratios, "自定义"].map((ratio) => `<button class="choice" disabled>${ratio}</button>`).join("")}
        </div></div>
        <div class="field disabled"><label>分辨率</label><div class="choice-row">
          ${Composer.resolutions.map(([, label]) => `<button class="choice" disabled>${label}</button>`).join("")}
        </div></div>
        <div class="field disabled"><label>生成张数</label><div class="choice-row">
          ${Composer.batches.map((value) => `<button class="choice" disabled>${value} 张</button>`).join("")}
        </div></div>
        <p class="hint">网格拼接是纯 Python 本地执行：按参考图的原始像素拼，不缩放，比例 / 分辨率 / 张数不参与。</p>`;
      return;
    }
    if (state.kind === "image" && scale) {
      const factor = Number(p.scale || scale.default || 2);
      box.innerHTML = `
        <div class="field">
          <label>放大倍数 <small>${scale.min ?? 1} – ${scale.max ?? 10} 倍</small></label>
          <div class="range-row">
            <input id="cvScaleRange" type="range" min="${scale.min ?? 1}" max="${scale.max ?? 10}"
                   step="${scale.step ?? 0.1}" value="${factor}">
            <output>${factor.toFixed(1)}×</output>
          </div>
        </div>
        <div class="field disabled"><label>图片比例</label><div class="choice-grid">
          ${[...Composer.ratios, "自定义"].map((ratio) => `<button class="choice" disabled>${ratio}</button>`).join("")}
        </div></div>
        <div class="field disabled"><label>分辨率</label><div class="choice-row">
          ${Composer.resolutions.map(([, label]) => `<button class="choice" disabled>${label}</button>`).join("")}
        </div></div>
        <div class="field disabled"><label>生成张数</label><div class="choice-row">
          ${Composer.batches.map((value) => `<button class="choice" disabled>${value} 张</button>`).join("")}
        </div></div>`;
      this.syncRangeFills();
      return;
    }
    if (state.kind === "video") {
      box.innerHTML = `
        <div class="field ${sizeOn ? "" : "disabled"}">
          <label>视频比例</label>
          <div class="choice-row">
            ${Composer.videoRatios.map((ratio) => `
              <button class="choice ${p.video_ratio === ratio ? "active" : ""}" data-cv-vratio="${ratio}">${ratio}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>视频质量 <small>百万像素 0.2 – 2.0</small></label>
          <div class="range-row">
            <input id="cvQualityRange" type="range" min="0.2" max="2" step="0.1" value="${Number(p.quality ?? 1)}">
            <output>${Number(p.quality ?? 1).toFixed(1)}</output>
          </div>
        </div>
        <div class="field">
          <label>视频时长 <small>1 – 15 秒</small></label>
          <div class="range-row">
            <input id="cvDurationRange" type="range" min="1" max="15" step="1" value="${Number(p.duration || 3)}">
            <output>${Number(p.duration || 3)} 秒</output>
          </div>
        </div>`;
      this.syncRangeFills();
      return;
    }

    box.innerHTML = `
      <div class="field ${sizeOn ? "" : "disabled"}">
        <label>图片比例</label>
        <div class="choice-grid">
          ${[...Composer.ratios, "自定义"].map((ratio) => `
            <button class="choice ${(p.custom ? ratio === "自定义" : p.ratio === ratio) ? "active" : ""}"
                    data-cv-ratio="${ratio}">${ratio}</button>`).join("")}
        </div>
      </div>
      <div class="field ${sizeOn ? "" : "disabled"}">
        <label>分辨率 <small>按最长边计算</small></label>
        <div class="choice-row">
          ${Composer.resolutions.map(([value, label]) => `
            <button class="choice ${p.resolution === value ? "active" : ""}" data-cv-res="${value}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="field custom-size" ${p.custom && sizeOn ? "" : "hidden"}>
        <label>自定义宽高 <small>按 8 像素对齐</small></label>
        <div class="custom-inputs">
          <label>宽 <input id="cvWidth" type="number" min="64" max="4096" step="8" value="${p.custom_width || 1024}"></label>
          <span>×</span>
          <label>高 <input id="cvHeight" type="number" min="64" max="4096" step="8" value="${p.custom_height || 1024}"></label>
        </div>
      </div>
      <div class="field ${batchOn ? "" : "disabled"}">
        <label>生成张数</label>
        <div class="choice-row">
          ${Composer.batches.map((value) => `
            <button class="choice ${Number(p.batch) === value ? "active" : ""}" data-cv-batch="${value}">${value} 张</button>`).join("")}
        </div>
      </div>`;
  },

  /* 网格拼接的行 / 列：下拉显示的是工作流默认值，但必须真的写进节点参数，
     否则提交时后端拿不到 grid_cols 会按 1×1 处理（只输出第一张） */
  ensureGridParams(state) {
    const wf = State.workflows.find((item) => item.id === state?.workflow);
    const grid = wf?.grid;
    if (!grid || !state) return false;
    const params = state.params || (state.params = {});
    let changed = false;
    if (!Number(params.grid_rows)) { params.grid_rows = Number(grid.rows) || 1; changed = true; }
    if (!Number(params.grid_cols)) { params.grid_cols = Number(grid.cols) || 1; changed = true; }
    return changed;
  },

  /* 网格拼接（纯 Python）专用的参数块：行 × 列 */
  gridFieldHtml(wf, p = {}) {
    const grid = wf?.grid || {};
    const rows = Number(p.grid_rows) || Number(grid.rows) || 1;
    const cols = Number(p.grid_cols) || Number(grid.cols) || 1;
    const cells = rows * cols;
    const count = this.refs().length;
    const fill = (max, current) => Array.from(
      { length: Math.max(1, Math.min(24, Number(max) || 6)) },
      (_, i) => `<option value="${i + 1}"${Number(current) === i + 1 ? " selected" : ""}>${i + 1}</option>`,
    ).join("");
    const note = !count ? "还没接图片"
      : count > cells ? `已接 ${count} 张，只用前 ${cells} 张`
        : count < cells ? `已接 ${count} 张，会空 ${cells - count} 格`
          : `已接 ${count} 张，刚好铺满`;
    return `
      <div class="field">
        <label>网格 <small>行 × 列，按素材顺序从左到右、从上到下</small></label>
        <div class="custom-inputs">
          <label>行 <select id="cvGridRows">${fill(grid.max_rows || 6, rows)}</select></label>
          <span>×</span>
          <label>列 <select id="cvGridCols">${fill(grid.max_cols || 8, cols)}</select></label>
        </div>
        <p class="hint">共 ${cells} 格 · ${note} · 按原像素拼接（不缩放）</p>
      </div>`;
  },

  syncRangeFills() {    $$("#cvParamsBody input[type=range]").forEach((input) => {
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 1;
      const value = Number(input.value) || min;
      input.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
    });
  },

  // ---------- 生成 ----------
  async addRefs() {
    const state = this.state();
    if (!state) return;
    Picker.open((picked) => {
      if (!picked?.length) return;
      state.refs ||= [];
      picked.forEach((item) => {
        if (state.refs.some((ref) => ref.name === item.name && ref.source === item.source)) return;
        state.refs.push({
          name: item.name, source: item.source, kind: item.kind || "image",
          origin: item.origin || item.name, url: item.url || "",
        });
      });
      if (this.mode === "gen") Canvas.save();
      this.renderRefs();
      this.renderLabels();
      this.renderStatus();
      const counts = { image: 0, video: 0, audio: 0 };
      picked.forEach((item) => { counts[item.kind || "image"] = (counts[item.kind || "image"] || 0) + 1; });
      const detail = [counts.image ? `${counts.image} 图` : "", counts.video ? `${counts.video} 视频` : "",
        counts.audio ? `${counts.audio} 音频` : ""].filter(Boolean).join(" / ");
      if (detail) toast(`已添加 ${detail}`);
    }, { allowMedia: state.kind === "prompt" || this.multiModal() });
  },

  async submit() {
    if (this._loading) return;
    const state = this.state();
    if (!state) return;
    const prompt = ($("#cvPrompt").value || "").trim();
    state.prompt = prompt;
    const inherited = Canvas.upstreamPromptText(this.nodeId);
    const wf = this.currentWorkflow();
    if (state.kind !== "prompt" && wf?.supports_prompt !== false && !prompt && !inherited) {
      return Dialog.warn({ title: "缺少提示词", message: "先在下方描述想要生成的内容。" });
    }

    await this.generate(this.nodeId);
  },

  /* 停止节点运行：取消它提交的全部任务，提示词运行走 ComfyUI 中断 */
  async stop(genId = this.nodeId) {
    const gen = Canvas.layout().gens?.[genId] || this.gen();
    if (!gen) return;
    this._stopRequested = true;
    if (this._promptAbort) {
      this._promptAbort.abort();
      this._promptAbort = null;
    }
    const ids = [...(gen.taskIds || [])];
    gen.taskIds = [];
    this._loading = false;
    let stopped = 0;
    for (const id of ids) {
      try { await API.cancelTask(id); stopped += 1; } catch { /* 已结束忽略 */ }
    }
    if (gen.kind === "prompt" || !ids.length) {
      try { await API.interruptComfy(); } catch { /* ComfyUI 不在线忽略 */ }
    }
    gen.status = "cancelled";
    gen.progress = 0;
    Canvas.save();
    Canvas.render();
    this.renderStatus();
    toast(stopped ? `已停止 ${stopped} 个任务` : "已停止当前生成");
    window.Main?.refreshAll();
  },

  async generate(genId) {
    if (this._loading) return;
    const gen = Canvas.layout().gens?.[genId];
    if (!gen) return;
    if (["queued", "submitting", "running"].includes(gen.status)) {
      return toast("这个节点正在生成，稍等一下", true);
    }
    const wf = State.workflows.find((item) => item.id === gen.workflow) || this.currentWorkflow();
    if (!wf) return Dialog.warn({ title: "没有工作流", message: "请先在设置里接入对应类型的工作流。" });
    if (wf.available === false) {
      return Dialog.warn({
        title: "当前实例跑不了这个工作流",
        message: `${wf.name || wf.id}：${wf.unavailable_reason || "缺少节点或模型"}。换回本机实例或换一个工作流再试。`,
      });
    }

    if (wf.scale && !Number(gen.params?.scale)) {
      gen.params = { ...(gen.params || {}), scale: wf.scale.default ?? 2 };
    }
    // 网格拼接：提交前保证行列都落在参数里（旧节点 / 没展开参数弹层的情况）
    if (wf.grid && this.ensureGridParams(gen)) Canvas.save();
    const prompt = (gen.prompt || "").trim() || Canvas.upstreamPromptText(genId);
    if (wf.supports_prompt === false) {
      // 纯放大类工作流没有提示词：只要参考图
      if (!Canvas.mediaRefsFor(genId).length) {
        return Dialog.warn({ title: "缺少素材", message: "这个工作流需要一张图片，从素材节点拉一条线过来。" });
      }
    } else if (!prompt) {
      return Dialog.warn({ title: "缺少提示词", message: "在下方输入想要生成的内容。" });
    }
    if (gen.kind === "prompt") return this.generatePrompt(gen, prompt);

    // 局部重绘节点：只认当初上传的遮罩图（params.image），不吃上游素材，
    // 否则会拿原图当输入、整张图重画而不是只改遮罩区
    const isInpaint = wf.category === "inpaint";
    const limits = wf.limits || {};
    // 多参考素材（图 + 视频 + 音频一起进同一个任务）只在这种工作流里出现
    const multiModal = !isInpaint && (limits.videos != null || limits.audios != null);
    // 普通图片 / 视频工作流只吃图片，视频与音频留给提示词节点
    let media = isInpaint ? [] : Canvas.mediaRefsFor(genId).filter((ref) => {
      if (ref.kind === "prompt") return true;
      const kind = ref.kind || "image";
      return multiModal ? true : kind === "image";
    });
    // 按类型分别卡上限（图 9 / 视频 3 / 音频 3）
    const used = { image: 0, video: 0, audio: 0 };
    let dropped = 0;
    media = media.filter((ref) => {
      const kind = ref.kind || "image";
      const cap = isInpaint ? 0 : limits[`${kind}s`];
      if (cap != null && used[kind] >= cap) {
        dropped += 1;
        return false;
      }
      used[kind] += 1;
      return true;
    });
    if (dropped) {
      toast(`这个工作流最多 ${limits.images ?? "∞"} 图 / ${limits.videos ?? "∞"} 视频 / ${limits.audios ?? "∞"} 音频，已忽略 ${dropped} 个`);
    }
    const hasImage = media.some((ref) => (ref.kind || "image") === "image");
    if (wf.needs_image && !hasImage && !(isInpaint && gen.params?.image)) {
      return Dialog.warn({
        title: isInpaint ? "缺少遮罩图" : "缺少参考素材",
        message: isInpaint
          ? "这个节点是局部重绘结果，没有可复用的遮罩图。右键节点选「局部重绘…」重新涂一次。"
          : "这个工作流需要参考图，从素材节点拉一条线过来，或点「+」添加素材。",
      });
    }

    this._loading = true;
    this._stopRequested = false;
    gen.status = "submitting";
    gen.progress = 0;
    gen.error = "";
    gen.taskIds = [];
    gen.results = [];
    gen.result = "";
    Canvas.render();
    this.renderStatus();
    try {
      // 纯 Python 工作流（网格拼接）：素材不传 ComfyUI，直接把来源 + 名字交给后端
      const local = (wf.engine || "comfy") === "python";
      const prepared = local ? media : await Canvas.prepareRefs(media);
      // 多参考工作流把所有素材塞进同一个任务；其余按 images_per_task 分组
      const per = multiModal || local
        ? Math.max(1, prepared.length)
        : Math.max(1, Number(wf.images_per_task) || 1);
      const jobs = [];
      if (wf.needs_image && prepared.length) {
        for (let i = 0; i < prepared.length; i += per) jobs.push(prepared.slice(i, i + per));
      } else {
        jobs.push(null);
      }
      const taskIds = [];
      for (const group of jobs) {
        const extra = {};
        if (local) {
          extra.refs = (group || []).map((item) => ({
            source: item.source || "input",
            name: item.name,
            origin: item.origin || "",
          }));
        } else {
          // 按素材类型分别编号：image / image2…、video / video2…、audio / audio2…
          const counters = { image: 0, video: 0, audio: 0 };
          (group || []).forEach((item) => {
            if (!item?.name) return;
            const kind = item.kind || "image";
            const index = (counters[kind] = (counters[kind] || 0) + 1);
            extra[index === 1 ? kind : `${kind}${index}`] = item.name;
          });
        }
        const task = await API.generate({
          project_id: State.activeId,
          prompt,
          workflow: gen.workflow,
          params: { ...gen.params, ...extra },
        });
        if (task?.id) taskIds.push(task.id);
        if (task?.warnings?.length) toast(task.warnings[0], true);
        // 提交途中被停止：不再继续下发，已发出的直接取消
        if (this._stopRequested) {
          for (const id of taskIds) API.cancelTask(id).catch(() => {});
          gen.status = "cancelled";
          gen.taskIds = [];
          this._loading = false;
          Canvas.save();
          Canvas.render();
          this.renderStatus();
          return;
        }
      }
      if (!taskIds.length) throw new Error("提交后没有返回任务");
      gen.taskIds = taskIds;
      gen.status = "queued";
      gen.progress = 0;
      Canvas.save();
      Canvas.render();
      this.renderStatus();
      toast(taskIds.length > 1 ? `已提交 ${taskIds.length} 个任务` : "已提交，节点会实时显示进度");
      window.Main?.refreshAll();
    } catch (error) {
      if (gen.status === "cancelled" || this._stopRequested) return;   // 用户主动停止，不弹错误
      gen.status = "error";
      gen.error = error.message;
      Canvas.save();
      Canvas.render();
      this.renderStatus();
      Dialog.warn({ title: "生成失败", message: error.message });
    } finally {
      this._loading = false;
      this.renderStatus();
    }
  },

  async generatePrompt(gen, prompt) {
    this._loading = true;
    this._stopRequested = false;
    this._promptAbort = new AbortController();
    gen.status = "running";
    gen.progress = 0;
    gen.error = "";
    gen.results = [];
    gen.result = "";
    Canvas.render();
    this.renderStatus();
    try {
      const media = Canvas.mediaRefsFor(gen.id);
      const prepared = await Canvas.prepareRefs(media);
      const fn = gen.function || this.guessFunction(media);
      const result = await API.runPrompt({
        prompt,
        function: fn,
        workflow: gen.workflow,
        assets: prepared.map((item) => ({ name: item.name, kind: item.kind })),
      }, { signal: this._promptAbort.signal });
      gen.function = fn;
      gen.result = result.prompt || "";
      gen.results = gen.result ? [gen.result] : [];
      gen.status = "done";
      gen.progress = 100;
      Canvas.save();
      Canvas.render();
      this.renderStatus();
      toast("提示词已生成");
    } catch (error) {
      if (gen.status === "cancelled" || this._stopRequested) return;
      gen.status = "error";
      gen.error = error.message;
      Canvas.save();
      Canvas.render();
      this.renderStatus();
      Dialog.warn({ title: "提示词生成失败", message: error.message });
    } finally {
      this._loading = false;
      this._promptAbort = null;
      this.renderStatus();
    }
  },

  // ---------- 交互 ----------
  autoGrow() {
    const el = $("#cvPrompt");
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    requestAnimationFrame(() => this.follow());
  },

  refresh() {
    if (!this.visible()) return;
    const node = this.target();
    if (!node) return this.hide();
    this.syncAll();
  },

  /* 把相邻上游的文本灌进输入框；上游引用的图片/视频/音频作为素材一起带过来 */
  injectUpstream() {
    const text = Canvas.upstreamPromptText(this.nodeId);
    const media = Canvas.mediaRefsFor(this.nodeId);
    if (!text && !media.length) return toast("相邻上游还没有可传入的内容", true);
    if (text) {
      const area = $("#cvPrompt");
      area.value = text;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      this.autoGrow();
    }
    // 素材由智能引用自动带上（autoRef），这里只负责把状态与提示刷新出来
    this.renderRefs();
    this.renderLabels();
    if (text && media.length) toast(`已传入上游文本和 ${media.length} 个素材`);
    else if (text) toast("已传入上游文本");
    else toast(`已接入上游 ${media.length} 个素材`);
  },

  /* 合一创作节点：在创作区里切换 图片 / 视频 / 提示词 */
  setKind(kind) {
    const gen = this.gen();
    if (!gen || gen.kind === kind) return;
    Canvas.record();
    gen.kind = kind;
    const hasMedia = Canvas.mediaRefsFor(gen.id).some((ref) => (ref.kind || "image") === "image");
    gen.workflow = Canvas.defaultWorkflowFor(kind, hasMedia);
    gen.params = Canvas.defaultParamsFor(kind);
    gen.function = "";
    gen.refs = [];          // 切类型清掉旧的手动引用，避免多余图片干扰新工作流
    gen.status = "idle";
    gen.progress = 0;
    gen.taskIds = [];
    gen.results = [];
    gen.result = "";
    gen.error = "";
    localStorage.setItem(`wwdm-cv-workflow-${kind}`, gen.workflow);
    if (this.mode === "gen") Canvas.save();
    Canvas.render();
    this.syncAll();
    this.renderStatus();
  },

  bind() {
    $("#cvPrompt").addEventListener("input", () => {
      const state = this.state();
      if (!state) return;
      state.prompt = $("#cvPrompt").value;
      this.autoGrow();
      this.renderLabels();
      this.save();
    });
    $("#cvPrompt").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.submit();
      }
    });
    $("#cvSend").addEventListener("click", () => {
      const gen = this.gen();
      const busy = this._loading || ["queued", "submitting", "running"].includes(gen?.status);
      if (busy) return void this.stop();
      this.submit();
    });
    $("#cvAddRef").addEventListener("click", () => this.addRefs());
    $("#cvSmartRef").addEventListener("click", () => {
      const state = this.state();
      if (!state) return;
      state.autoRef = state.autoRef === false;
      if (this.mode === "gen") Canvas.save();
      this.renderRefs();
      this.renderLabels();
      toast(state.autoRef ? "已开启智能引用：自动使用上游连线素材" : "已关闭智能引用：只用手动添加的素材");
    });
    $("#cvExpand").addEventListener("click", () => {
      $("#cvComposer").classList.toggle("expanded");
      this.autoGrow();
      requestAnimationFrame(() => this.follow());
    });
    $("#cvRefs").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cv-ref-del]");
      if (!btn) return;
      const state = this.state();
      if (!state?.refs) return;
      state.refs.splice(Number(btn.dataset.cvRefDel), 1);
      if (this.mode === "gen") Canvas.save();
      this.renderRefs();
      this.renderLabels();
      this.renderStatus();
    });
    $("#cvRefs").addEventListener("click", (event) => {
      if (event.target.closest("[data-cv-ref-del]")) return;
      const chip = event.target.closest("[data-cv-ref-preview]");
      if (!chip) return;
      const ref = this.refs()[Number(chip.dataset.cvRefPreview)];
      if (!ref) return;
      const url = ref.url || (ref.source === "project" ? ref.name : API.comfyFileUrl(ref.source || "input", ref.name));
      if (ref.taskId) Works.preview(ref.taskId, url);
      else Works.previewAsset({ url, name: ref.origin || ref.name, kind: ref.kind || "image", source: ref.source });
    });
    $("#cvUpstreamPrompt").addEventListener("click", (event) => {
      if (event.target.closest("[data-cv-inject]")) this.injectUpstream();
    });
    $("#cvKindChip").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleKindPop();
    });
    $("#cvKindList").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-kind]");
      if (!btn) return;
      this.setKind(btn.dataset.kind);
      this.closePops();
    });
    $("#cvWorkflowChip").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleWorkflowPop();
    });
    $("#cvParamsChip").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleParamsPop();
    });
    $$("[data-cv-close]").forEach((btn) => btn.addEventListener("click", () => this.closePops()));

    $("#cvWorkflowList").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cv-wf]");
      if (!btn) return;
      const state = this.state();
      if (!state) return;
      state.workflow = btn.dataset.cvWf;
      localStorage.setItem(`wwdm-cv-workflow-${state.kind}`, state.workflow);
      if (this.mode === "gen") { Canvas.save(); Canvas.render(); }
      this.closePops();
      this.renderLabels();
      this.renderStatus();
      // 换工作流后参数可用范围变了（如切到纯放大），参数体与提示词锁要跟着刷新
      this.renderParamsBody();
      this.syncPromptLock();
    });

    $("#cvParamsBody").addEventListener("change", (event) => {
      const state = this.state();
      if (!state) return;
      const p = state.params || (state.params = {});
      if (event.target.id === "cvGridRows") p.grid_rows = Number(event.target.value) || 1;
      else if (event.target.id === "cvGridCols") p.grid_cols = Number(event.target.value) || 1;
      else return;
      if (this.mode === "gen") Canvas.save();
      this.renderParamsBody();
      this.renderLabels();
      this.renderStatus();
    });
    $("#cvParamsBody").addEventListener("click", (event) => {
      const state = this.state();
      if (!state) return;
      const p = state.params || (state.params = {});
      const ratio = event.target.closest("[data-cv-ratio]");
      const res = event.target.closest("[data-cv-res]");
      const batch = event.target.closest("[data-cv-batch]");
      const vratio = event.target.closest("[data-cv-vratio]");
      const fn = event.target.closest("[data-cv-fn]");
      if (ratio) {
        if (ratio.dataset.cvRatio === "自定义") p.custom = true;
        else { p.custom = false; p.ratio = ratio.dataset.cvRatio; }
      } else if (res) {
        p.custom = false;
        p.resolution = res.dataset.cvRes;
      } else if (batch) {
        p.batch = Number(batch.dataset.cvBatch);
      } else if (vratio) {
        p.video_ratio = vratio.dataset.cvVratio;
      } else if (fn) {
        state.function = fn.dataset.cvFn;
      } else {
        return;
      }
      if (this.mode === "gen") Canvas.save();
      this.renderParamsBody();
      this.renderLabels();
      this.renderStatus();
    });
    $("#cvParamsBody").addEventListener("input", (event) => {
      const state = this.state();
      if (!state) return;
      const p = state.params || (state.params = {});
      if (event.target.id === "cvScaleRange") {
        p.scale = Number(event.target.value);
        const out = event.target.parentElement.querySelector("output");
        if (out) out.textContent = `${p.scale.toFixed(1)}×`;
        if (this.mode === "gen") Canvas.save();
        this.syncRangeFills();
        this.renderLabels();
        return;
      }
      if (event.target.id === "cvQualityRange") p.quality = Number(event.target.value);
      else if (event.target.id === "cvDurationRange") p.duration = Number(event.target.value);
      else if (event.target.id === "cvWidth") p.custom_width = Number(event.target.value) || 1024;
      else if (event.target.id === "cvHeight") p.custom_height = Number(event.target.value) || 1024;
      else return;
      if (this.mode === "gen") Canvas.save();
      this.syncRangeFills();
      // 同步滑块右侧的数值（只换文字，不重建 DOM，否则拖动会断）
      const row = event.target.closest(".range-row");
      const out = row?.querySelector("output");
      if (out) {
        out.textContent = event.target.id === "cvDurationRange"
          ? `${p.duration} 秒`
          : String(Number(p.quality ?? 1).toFixed(1));
      }
      this.renderLabels();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#cvKindPop, #cvWorkflowPop, #cvParamsPop, #cvKindChip, #cvWorkflowChip, #cvParamsChip")) {
        this.closePops();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.visible()) this.closePops();
    });
    window.addEventListener("resize", () => this.closePops());
  },
};

window.CanvasComposer = CanvasComposer;
