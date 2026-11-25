/* 工作台内联编辑器：裁剪 / 旋转翻转 / 色调调整 / 高清放大
   —— 参数在右侧面板里改，左侧图片实时预览，点「确认」才真正出图。
   预览算法按后端 PIL 的公式实现（亮度→对比→饱和→色温），尽量做到所见即所得。 */
const WbEdit = {
  tool: "",
  taskId: "",
  img: null,             // 原图 HTMLImageElement
  natural: { w: 0, h: 0 },
  // 裁剪：显示像素坐标系下的框 + 相对原图的缩放比
  crop: { x: 0, y: 0, w: 0, h: 0 },
  disp: { w: 0, h: 0, scale: 1 },
  ratio: "1:1",          // 自由 | 1:1 | ... | 自定义
  customRatio: { w: 4, h: 5 },
  rotate: "right",
  tone: { brightness: 1, contrast: 1, saturation: 1, warmth: 0 },
  canvas: null,
  basePixels: null,      // 降采样后的原始像素（色调预览用）
  busy: false,
  dragging: null,

  RATIOS: ["自由", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "自定义"],
  ROTATES: [
    ["left", "左转 90°"],
    ["right", "右转 90°"],
    ["180", "翻转 180°"],
    ["flip-h", "水平镜像"],
    ["flip-v", "垂直镜像"],
  ],
  TITLE: { crop: "裁剪", rotate: "旋转翻转", tone: "色调调整", upscale: "高清放大" },

  init() {
    const stage = $("#wbStage");
    stage.addEventListener("pointerdown", (event) => this.onStageDown(event));
    window.addEventListener("pointermove", (event) => this.onStageMove(event));
    window.addEventListener("pointerup", () => this.onStageUp());

    $("#wbSideBody").addEventListener("click", (event) => {
      if (!this.active()) return;
      const ratio = event.target.closest("[data-ratio]");
      if (ratio) return this.setRatio(ratio.dataset.ratio);
      const rot = event.target.closest("[data-rotate]");
      if (rot) return this.setRotate(rot.dataset.rotate);
      if (event.target.closest("[data-tone-reset]")) return this.resetTone();
      if (event.target.closest("[data-crop-full]")) return this.cropFull();
      if (event.target.closest("[data-crop-center]")) return this.cropCenter();
    });
    $("#wbSideBody").addEventListener("input", (event) => {
      if (!this.active()) return;
      const input = event.target;
      if (input.matches("[data-tone]")) {
        this.tone[input.dataset.tone] = Number(input.value);
        const out = input.closest(".wb-slider")?.querySelector("output");
        if (out) out.textContent = Number(input.value).toFixed(2);
        this.renderTone();
      } else if (input.matches("[data-scale]")) {
        const out = input.closest(".wb-slider")?.querySelector("output");
        if (out) out.textContent = `${Number(input.value).toFixed(1)}×`;
        this.renderUpscaleHint();
      } else if (input.matches("[data-ratio-w], [data-ratio-h]")) {
        // 输入自定义比例：不重建面板（否则输入框会被换掉、丢焦点）
        const group = input.closest(".wb-ratio-inputs");
        const w = Number(group?.querySelector("[data-ratio-w]")?.value) || 1;
        const h = Number(group?.querySelector("[data-ratio-h]")?.value) || 1;
        this.customRatio = { w, h };
        if (this.ratio !== "自定义") {
          this.ratio = "自定义";
          this.renderCropPanel();
        }
        this.applyRatioToBox();
      }
    });
  },

  active() { return !!this.tool; },

  // ---------- 进入 / 退出 ----------
  begin(tool) {
    const task = CardMenu.task();
    if (!task) return;
    const url = (task.images || [])[0] || "";
    if (!url) return toast("这条作品还没有图片", true);
    this.tool = tool;
    this.taskId = task.id;
    this.busy = false;
    // 「实际大小」模式的容器是 max-content，裁剪框坐标会算错，编辑时强制回适应窗口
    $("#wbStage").classList.remove("actual");
    CardMenu.actualSize = false;
    $("#wbBack").hidden = false;
    $("#wbTitle").textContent = this.TITLE[tool] || "编辑";

    if (tool === "upscale") {
      this.renderUpscalePanel();
      return;
    }
    // 其余工具需要图片像素：先加载原图
    this.loadImage(url).then(() => {
      if (!this.active()) return;
      if (tool === "crop") this.startCrop();
      else if (tool === "rotate") this.startRotate();
      else if (tool === "tone") this.startTone();
    }).catch(() => {
      Dialog.warn({ title: "图片加载失败", message: "这张作品的图片可能已被删除，可以先用「拿最新图片」找回。" });
      this.cancel();
    });
  },

  cancel() {
    this.tool = "";
    this.dragging = null;
    this.basePixels = null;
    this.canvas = null;
    $("#wbBack").hidden = true;
    CardMenu.render();
  },

  back() { this.cancel(); },

  loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.img = img;
        this.natural = { w: img.naturalWidth, h: img.naturalHeight };
        resolve(img);
      };
      img.onerror = reject;
      img.src = url;
    });
  },

  // ---------- 裁剪 ----------
  startCrop() {
    const media = $("#wbMedia");
    media.classList.add("cropping");
    media.innerHTML = `
      <div class="crop-layer" id="cropLayer">
        <img class="crop-img" src="${escapeHtml(this.srcUrl())}" alt="" draggable="false">
        <div class="crop-mask" id="cropMask">
          <i data-m="t"></i><i data-m="b"></i><i data-m="l"></i><i data-m="r"></i>
        </div>
        <div class="crop-box" id="cropBox">
          ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((dir) => `<span class="crop-handle ${dir}" data-handle="${dir}"></span>`).join("")}
          <span class="crop-dim" id="cropDim"></span>
        </div>
      </div>`;
    this.ratio = "1:1";
    this.renderCropPanel();
    requestAnimationFrame(() => {
      this.layoutCropStage();
      this.cropCenter();
    });
  },

  /* 显式算好裁剪层的 left/top/宽/高 —— 图片位置从此不随框子或其它样式变化而移动 */
  layoutCropStage() {
    const media = $("#wbMedia");
    const layer = $("#cropLayer");
    if (!media || !layer) return;
    const boxW = media.clientWidth || media.getBoundingClientRect().width;
    const boxH = media.clientHeight || media.getBoundingClientRect().height;
    const scale = Math.min((boxW * 0.94) / this.natural.w, (boxH * 0.94) / this.natural.h);
    const w = this.natural.w * scale;
    const h = this.natural.h * scale;
    this.disp = { w, h, scale, boxW, boxH };
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    layer.style.left = `${Math.max(0, Math.round((boxW - w) / 2))}px`;
    layer.style.top = `${Math.max(0, Math.round((boxH - h) / 2))}px`;
    const img = layer.querySelector(".crop-img");
    if (img) {
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
    }
  },

  ratioValue() {
    if (this.ratio === "自由") return null;
    if (this.ratio === "自定义") {
      const w = Number(this.customRatio.w) || 1;
      const h = Number(this.customRatio.h) || 1;
      return w / h;
    }
    const [w, h] = this.ratio.split(":").map(Number);
    return w / h;
  },

  cropCenter() {
    const ratio = this.ratioValue();
    let w = this.disp.w * 0.78;
    let h = this.disp.h * 0.78;
    if (ratio) {
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
      if (w > this.disp.w) { w = this.disp.w; h = w / ratio; }
      if (h > this.disp.h) { h = this.disp.h; w = h * ratio; }
    }
    this.crop = {
      x: Math.round((this.disp.w - w) / 2),
      y: Math.round((this.disp.h - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
    this.paintCrop();
  },

  cropFull() {
    const ratio = this.ratioValue();
    let w = this.disp.w;
    let h = this.disp.h;
    if (ratio) {
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
    }
    this.crop = { x: 0, y: 0, w: Math.round(w), h: Math.round(h) };
    this.paintCrop();
  },

  paintCrop() {
    const box = $("#cropBox");
    if (!box) return;
    const { x, y, w, h } = this.crop;
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    // 框外压暗：用 4 块遮罩拼出「框」的孔（box-shadow 这种写法在部分情况下画不出来）
    const mask = $("#cropMask");
    if (mask) {
      const W = this.disp.w;
      const H = this.disp.h;
      const set = (sel, l, t, ww, hh) => {
        const el = mask.querySelector(sel);
        if (!el) return;
        el.style.left = `${l}px`;
        el.style.top = `${t}px`;
        el.style.width = `${Math.max(0, ww)}px`;
        el.style.height = `${Math.max(0, hh)}px`;
      };
      set('[data-m="t"]', 0, 0, W, y);
      set('[data-m="b"]', 0, y + h, W, H - (y + h));
      set('[data-m="l"]', 0, y, x, h);
      set('[data-m="r"]', x + w, y, W - (x + w), h);
    }
    const scale = this.disp.scale || 1;
    const dim = $("#cropDim");
    if (dim) {
      dim.textContent = `${Math.round(w / scale)} × ${Math.round(h / scale)}`;
    }
  },

  setRatio(name) {
    this.ratio = name;
    this.renderCropPanel();
    this.applyRatioToBox();
  },

  /* 按当前比例把框调成最大内接（以原框中心为基准），不动面板 DOM */
  applyRatioToBox() {
    const ratio = this.ratioValue();
    if (!ratio) return;   // 自由比例：保持当前框
    const cx = this.crop.x + this.crop.w / 2;
    const cy = this.crop.y + this.crop.h / 2;
    let w = this.crop.w;
    let h = w / ratio;
    if (h > this.disp.h) { h = this.disp.h; w = h * ratio; }
    if (w > this.disp.w) { w = this.disp.w; h = w / ratio; }
    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.max(0, Math.min(this.disp.w - w, x));
    y = Math.max(0, Math.min(this.disp.h - h, y));
    this.crop = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    this.paintCrop();
  },

  renderCropPanel() {
    const custom = this.ratio === "自定义";
    $("#wbSideBody").innerHTML = `
      <div class="wb-tool-tip">拖框选区域，或拖八个手柄改大小；确认后才写成新作品。</div>
      <div class="wb-field">
        <label>裁剪比例${this.ratioValue() ? "（已锁定）" : "（自由）"}</label>
        <div class="wb-chips">
          ${this.RATIOS.map((name) => `<button class="wb-chip${name === this.ratio ? " active" : ""}" data-ratio="${name}">${name}</button>`).join("")}
        </div>
      </div>
      <div class="wb-field${custom ? "" : " off"}">
        <label>自定义比例（宽 : 高）</label>
        <div class="wb-ratio-inputs">
          <input type="number" min="1" max="100" step="1" value="${this.customRatio.w}" data-ratio-w>
          <span>:</span>
          <input type="number" min="1" max="100" step="1" value="${this.customRatio.h}" data-ratio-h>
        </div>
      </div>
      <div class="wb-field">
        <label>快捷选择</label>
        <div class="wb-row">
          <button class="wb-mini" data-crop-center>居中 78%</button>
          <button class="wb-mini" data-crop-full>尽量铺满</button>
        </div>
      </div>`;
    $("#wbSideFoot").innerHTML = `
      <div class="wb-foot-row">
        <button class="soft-btn" id="wbCancel">取消</button>
        <button class="primary-btn" id="wbConfirm">确认裁剪</button>
      </div>`;
    this.bindFoot();
  },

  // ---------- 旋转 ----------
  startRotate() {
    const media = $("#wbMedia");
    media.classList.remove("cropping");
    media.innerHTML = "";
    this.rotate = "right";
    this.renderRotatePanel();
    this.renderRotate();
  },

  /* 旋转预览也走 canvas：90° 时自动交换画布宽高，预览始终填满舞台 */
  renderRotate() {
    const swap = ["left", "right"].includes(this.rotate);
    const max = 1400;
    const scale = Math.min(1, max / Math.max(this.natural.w, this.natural.h));
    const sw = Math.max(1, Math.round(this.natural.w * scale));
    const sh = Math.max(1, Math.round(this.natural.h * scale));

    let canvas = $(".wb-rotate-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "wb-rotate-canvas";
      $("#wbMedia").appendChild(canvas);
    }
    canvas.width = swap ? sh : sw;
    canvas.height = swap ? sw : sh;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    const angle = { left: -Math.PI / 2, right: Math.PI / 2, "180": Math.PI }[this.rotate] || 0;
    ctx.rotate(angle);
    if (this.rotate === "flip-h") ctx.scale(-1, 1);
    if (this.rotate === "flip-v") ctx.scale(1, -1);
    ctx.drawImage(this.img, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
    this.renderRotateHint();
  },

  renderRotatePanel() {
    $("#wbSideBody").innerHTML = `
      <div class="wb-tool-tip">左边是实时效果，确认后才写成新作品。</div>
      <div class="wb-field">
        <label>变换方式</label>
        <div class="wb-chips three">
          ${this.ROTATES.map(([value, label]) => `<button class="wb-chip${
            value === this.rotate ? " active" : ""}" data-rotate="${value}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="wb-hint" id="wbRotateInfo"></div>`;
    $("#wbSideFoot").innerHTML = `
      <div class="wb-foot-row">
        <button class="soft-btn" id="wbCancel">取消</button>
        <button class="primary-btn" id="wbConfirm">确认变换</button>
      </div>`;
    this.bindFoot();
    this.renderRotateHint();
  },

  setRotate(mode) {
    this.rotate = mode;
    this.renderRotatePanel();
    this.renderRotate();
  },

  renderRotateHint() {
    const info = $("#wbRotateInfo");
    if (!info) return;
    const swap = ["left", "right"].includes(this.rotate);
    const w = swap ? this.natural.h : this.natural.w;
    const h = swap ? this.natural.w : this.natural.h;
    info.textContent = `输出尺寸 ${w} × ${h}`;
  },

  // ---------- 色调 ----------
  startTone() {
    const media = $("#wbMedia");
    media.classList.remove("cropping");
    // 预览用降采样画布，拖动时不卡；保存仍按原图全分辨率走后端
    const max = 1100;
    const scale = Math.min(1, max / Math.max(this.natural.w, this.natural.h));
    const w = Math.max(1, Math.round(this.natural.w * scale));
    const h = Math.max(1, Math.round(this.natural.h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.className = "wb-tone-canvas";
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(this.img, 0, 0, w, h);
    this.canvas = canvas;
    this.basePixels = ctx.getImageData(0, 0, w, h);
    media.innerHTML = "";
    media.appendChild(canvas);
    this.tone = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };
    this.renderTonePanel();
    this.renderTone();
  },

  renderTonePanel() {
    const rows = [
      ["brightness", "亮度", 0.4, 1.8, 0.01],
      ["contrast", "对比度", 0.4, 1.8, 0.01],
      ["saturation", "饱和度", 0, 2, 0.01],
      ["warmth", "色温", -1, 1, 0.01],
    ];
    $("#wbSideBody").innerHTML = `
      <div class="wb-tool-tip">左边实时预览（约 ${Math.round(this.canvas.width)}px 采样）；确认后按原图分辨率出图。</div>
      ${rows.map(([key, label, min, max, step]) => `
        <div class="wb-slider">
          <label>${label}</label>
          <input type="range" data-tone="${key}" min="${min}" max="${max}" step="${step}" value="${this.tone[key]}">
          <output>${Number(this.tone[key]).toFixed(2)}</output>
        </div>`).join("")}
      <div class="wb-row" style="margin-top:4px">
        <button class="wb-mini" data-tone-reset>全部重置</button>
      </div>`;
    $("#wbSideFoot").innerHTML = `
      <div class="wb-foot-row">
        <button class="soft-btn" id="wbCancel">取消</button>
        <button class="primary-btn" id="wbConfirm">确认色调</button>
      </div>`;
    this.bindFoot();
  },

  resetTone() {
    this.tone = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };
    $$("#wbSideBody [data-tone]").forEach((input) => {
      input.value = this.tone[input.dataset.tone];
      const out = input.closest(".wb-slider")?.querySelector("output");
      if (out) out.textContent = Number(input.value).toFixed(2);
    });
    this.renderTone();
  },

  /* 按 PIL 的顺序复刻：亮度 → 对比（以灰度均值为中心）→ 饱和（向灰度插值）→ 色温（R/B 通道缩放） */
  renderTone() {
    if (!this.canvas || !this.basePixels) return;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    const src = this.basePixels.data;
    const out = ctx.createImageData(this.canvas.width, this.canvas.height);
    const dst = out.data;
    const { brightness, contrast, saturation, warmth } = this.tone;

    // 灰度均值（PIL ImageEnhance.Contrast 用的就是它）
    let sum = 0;
    for (let i = 0; i < src.length; i += 4) {
      sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }
    const mean = sum / (src.length / 4);
    const warmGain = 0.25 * warmth;

    for (let i = 0; i < src.length; i += 4) {
      let r = src[i];
      let g = src[i + 1];
      let b = src[i + 2];
      // 饱和度：与灰度做线性插值
      if (saturation !== 1) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * saturation;
        g = lum + (g - lum) * saturation;
        b = lum + (b - lum) * saturation;
      }
      // 对比度：以均值为中心
      if (contrast !== 1) {
        r = mean + (r - mean) * contrast;
        g = mean + (g - mean) * contrast;
        b = mean + (b - mean) * contrast;
      }
      // 亮度
      if (brightness !== 1) {
        r *= brightness;
        g *= brightness;
        b *= brightness;
      }
      // 色温
      if (warmGain) {
        r *= 1 + warmGain;
        b *= 1 - warmGain;
      }
      dst[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      dst[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      dst[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      dst[i + 3] = src[i + 3];
    }
    ctx.putImageData(out, 0, 0);
  },

  // ---------- 高清放大 ----------
  renderUpscalePanel() {
    const wf = this.upscaleWorkflow();
    const task = CardMenu.task();
    const src = task?.width && task?.height ? `${task.width} × ${task.height}` : "原图";
    if (!wf) {
      $("#wbSideBody").innerHTML = `<div class="wb-hint warn">还没接入带放大倍数的工作流（TTP 分块高清放大）。</div>`;
      $("#wbSideFoot").innerHTML = `<div class="wb-foot-row"><button class="soft-btn" id="wbCancel">返回</button></div>`;
      return this.bindFoot();
    }
    const scale = wf.scale || { min: 1, max: 10, step: 0.1, default: 2 };
    const factor = Number(scale.default || 2);
    $("#wbSideBody").innerHTML = `
      <div class="wb-tool-tip">放大交给「${escapeHtml(wf.name || "TTP 分块高清放大")}」工作流跑，提交后这里会显示进度，出图自动切过去。</div>
      <div class="wb-slider">
        <label>放大倍数</label>
        <input type="range" data-scale min="${scale.min ?? 1}" max="${scale.max ?? 10}"
               step="${scale.step ?? 0.1}" value="${factor}">
        <output>${factor.toFixed(1)}×</output>
      </div>
      <div class="wb-hint" id="wbScaleInfo"></div>`;
    $("#wbSideFoot").innerHTML = `
      <div class="wb-foot-row">
        <button class="soft-btn" id="wbCancel">取消</button>
        <button class="primary-btn" id="wbConfirm">开始放大</button>
      </div>`;
    this.bindFoot();
    this.renderUpscaleHint(src, factor);
  },

  renderUpscaleHint(src, factor) {
    const info = $("#wbScaleInfo");
    if (!info) return;
    const input = $("[data-scale]");
    const f = factor ?? Number(input?.value || 2);
    const task = CardMenu.task();
    const w = Number(task?.width) || 0;
    const h = Number(task?.height) || 0;
    info.textContent = w && h
      ? `预计输出 ${Math.round(w * f)} × ${Math.round(h * f)}`
      : "预计输出按原图乘以倍数";
  },

  upscaleWorkflow() {
    return (State.workflows || []).find((wf) => wf.scale) || null;
  },

  // ---------- 公共 ----------
  srcUrl() {
    return (CardMenu.task()?.images || [])[0] || "";
  },

  bindFoot() {
    $("#wbCancel")?.addEventListener("click", () => this.cancel());
    $("#wbConfirm")?.addEventListener("click", () => this.commit());
  },

  // ---------- 裁剪框交互 ----------
  onStageDown(event) {
    if (this.tool !== "crop") return;
    const layer = $("#cropLayer");
    if (!layer || !layer.contains(event.target)) return;
    const handle = event.target.closest("[data-handle]");
    const inBox = event.target.closest("#cropBox");
    if (!handle && !inBox) return;
    event.preventDefault();
    const rect = layer.getBoundingClientRect();
    this.dragging = {
      mode: handle ? handle.dataset.handle : "move",
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...this.crop },
      rect,
    };
    // 抓住指针：鼠标甩出窗口也不会丢 pointerup，拖完不会卡住
    try { event.target.setPointerCapture?.(event.pointerId); } catch { /* 合成事件没有 pointerId */ }
    $("body").classList.add("cropping-drag");
  },

  onStageMove(event) {
    const drag = this.dragging;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const o = drag.origin;
    const maxW = this.disp.w;
    const maxH = this.disp.h;
    const ratio = this.ratioValue();
    const min = 24;

    if (drag.mode === "move") {
      this.crop = {
        ...o,
        x: Math.max(0, Math.min(maxW - o.w, Math.round(o.x + dx))),
        y: Math.max(0, Math.min(maxH - o.h, Math.round(o.y + dy))),
      };
      return this.paintCrop();
    }

    let { x, y, w, h } = o;
    const right = o.x + o.w;
    const bottom = o.y + o.h;

    if (drag.mode.includes("e")) w = Math.max(min, Math.min(maxW - o.x, o.w + dx));
    if (drag.mode.includes("s")) h = Math.max(min, Math.min(maxH - o.y, o.h + dy));
    if (drag.mode.includes("w")) {
      const left = Math.max(0, Math.min(right - min, o.x + dx));
      w = right - left;
      x = left;
    }
    if (drag.mode.includes("n")) {
      const top = Math.max(0, Math.min(bottom - min, o.y + dy));
      h = bottom - top;
      y = top;
    }

    if (ratio) {
      // 锁定比例：以拖动的角/边为基准反推另一边
      if (drag.mode.includes("e") || drag.mode.includes("w")) {
        h = w / ratio;
        if (h > maxH - y) { h = maxH - y; w = h * ratio; }
        if (drag.mode.includes("n")) y = bottom - h;
      } else {
        w = h * ratio;
        if (w > maxW - x) { w = maxW - x; h = w / ratio; }
        if (drag.mode.includes("w")) x = right - w;
      }
      // 边界兜底
      if (x < 0) { x = 0; }
      if (y < 0) { y = 0; }
      if (x + w > maxW) { w = maxW - x; h = w / ratio; }
      if (y + h > maxH) { h = maxH - y; w = h * ratio; }
    }

    this.crop = {
      x: Math.round(Math.max(0, x)),
      y: Math.round(Math.max(0, y)),
      w: Math.round(Math.max(min, Math.min(maxW - x, w))),
      h: Math.round(Math.max(min, Math.min(maxH - y, h))),
    };
    this.paintCrop();
  },

  onStageUp() {
    if (!this.dragging) return;
    this.dragging = null;
    $("body").classList.remove("cropping-drag");
  },

  // ---------- 确认保存 ----------
  async commit() {
    if (this.busy) return;
    const task = CardMenu.task();
    if (!task) return;
    this.busy = true;
    const btn = $("#wbConfirm");
    if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
    try {
      const created = this.tool === "upscale"
        ? await this.commitUpscale(task)
        : await this.commitLocal(task);
      this.tool = "";
      $("#wbBack").hidden = true;
      if (created) CardMenu.adoptTask(created);
      else CardMenu.render();
    } catch (error) {
      Dialog.warn({ title: "处理失败", message: error.message });
    } finally {
      this.busy = false;
      if (btn) { btn.disabled = false; }
    }
  },

  async commitLocal() {
    const scale = this.disp.scale || 1;
    if (this.tool === "crop") {
      const rect = {
        x: Math.round(this.crop.x / scale),
        y: Math.round(this.crop.y / scale),
        w: Math.round(this.crop.w / scale),
        h: Math.round(this.crop.h / scale),
      };
      const created = await API.editImage(this.srcUrl(), "crop", { rect });
      toast(`已裁剪 ${rect.w} × ${rect.h}`);
      window.Main?.refreshAll();
      return created;
    }
    if (this.tool === "rotate") {
      const created = await API.editImage(this.srcUrl(), "rotate", { mode: this.rotate });
      toast("已生成变换后的新作品");
      window.Main?.refreshAll();
      return created;
    }
    if (this.tool === "tone") {
      const created = await API.editImage(this.srcUrl(), "tone", { ...this.tone });
      toast("已应用色调，生成新作品");
      window.Main?.refreshAll();
      return created;
    }
    return null;
  },

  async commitUpscale(task) {
    const wf = this.upscaleWorkflow();
    if (!wf) throw new Error("没有可用的放大工作流");
    const factor = Number($("[data-scale]")?.value || wf.scale?.default || 2);
    const prepared = await API.importReferences([{ source: "project", name: this.srcUrl() }]);
    const name = (prepared.items || [])[0]?.name;
    if (!name) throw new Error("参考图导入失败");
    const created = await API.generate({
      project_id: task.project_id || State.activeId,
      prompt: `高清放大 ×${factor.toFixed(1)}`,
      workflow: wf.id,
      params: { image: name, scale: factor },
    });
    toast(`已提交放大任务（×${factor.toFixed(1)}）`);
    window.Main?.refreshAll();
    return created;
  },
};
