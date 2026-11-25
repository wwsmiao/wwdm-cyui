/* 创作框：媒体选项卡、工作流选择、参数弹层、提交生成 */
const Composer = {
  ratios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "21:9", "9:21"],
  videoRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"],
  resolutions: [["1k", "1K"], ["1.5k", "1.5K"], ["2k", "2K"]],
  batches: [1, 2, 4],
  _remember: {},   // 媒体类型 → 上次使用的工作流 id
  runningTaskIds: [],   // 本创作区提交且仍在运行的任务
  _promptRunning: false,
  _promptAbort: null,

  async init() {
    this.renderChoices();
    this.renderFunctionList();
    this.bind();
    await this.loadWorkflows();
    this.applyWorkflowCapabilities();
  },

  isVideo() {
    return (this.currentWorkflow().kind || "image") === "video";
  },

  currentWorkflow() {
    return State.workflows.find((item) => item.id === State.workflow) || {};
  },

  /* 供右键菜单等外部调用：写入提示词 / 切换工作流 */
  setPrompt(text) {
    const input = $("#promptInput");
    input.value = text || "";
    this.autoGrow();
    input.focus();
  },

  setWorkflow(workflowId) {
    const wf = State.workflows.find((item) => item.id === workflowId);
    if (!wf) return false;
    State.workflow = wf.id;
    $("#workflowLabel").textContent = wf.name;
    $$("#workflowList .workflow-item").forEach((node) =>
      node.classList.toggle("active", node.dataset.id === wf.id));
    this.applyWorkflowCapabilities();
    return true;
  },

  sizeEnabled() { return this.currentWorkflow().supports_size !== false; },
  batchEnabled() { return this.currentWorkflow().supports_batch !== false; },

  /* 当前工作流是不是纯 Python 执行的（网格拼接）：不传 ComfyUI，素材按原样交给后端 */
  isLocalEngine(wf = this.currentWorkflow()) {
    return (wf?.engine || "comfy") === "python";
  },

  /* 网格拼接的行 / 列：下拉按工作流声明的上限生成，值存在 State.params 里 */
  syncGrid(wf) {
    const box = $("#gridField");
    if (!box) return;
    const grid = wf?.grid || null;
    box.hidden = !grid;
    if (!grid) return;
    const p = State.params;
    if (!Number(p.grid_rows)) p.grid_rows = grid.rows || 1;
    if (!Number(p.grid_cols)) p.grid_cols = grid.cols || 1;
    const fill = (select, max, current) => {
      if (!select) return;
      const top = Math.max(1, Math.min(24, Number(max) || 6));
      select.innerHTML = Array.from({ length: top }, (_, i) =>
        `<option value="${i + 1}"${Number(current) === i + 1 ? " selected" : ""}>${i + 1}</option>`).join("");
    };
    fill($("#gridRows"), grid.max_rows || 6, p.grid_rows);
    fill($("#gridCols"), grid.max_cols || 8, p.grid_cols);
    const hint = $("#gridHint");
    if (hint) hint.textContent = this.gridHintText(p, grid);
  },

  gridHintText(p = State.params, grid = this.currentWorkflow().grid) {
    if (!grid) return "";
    const rows = Number(p.grid_rows) || 1;
    const cols = Number(p.grid_cols) || 1;
    const cells = rows * cols;
    const refs = State.references.length;
    const parts = [`共 ${cells} 格`];
    if (!refs) parts.push("还没选图");
    else if (refs > cells) parts.push(`已选 ${refs} 张，只用前 ${cells} 张`);
    else if (refs < cells) parts.push(`已选 ${refs} 张，会空 ${cells - refs} 格`);
    else parts.push(`已选 ${refs} 张，刚好铺满`);
    parts.push("按原像素拼接，不缩放");
    return parts.join(" · ");
  },

  /* 工作流决定的可用参数：图生图/图生视频的尺寸与张数由参考图决定，提示词模式只要功能选择 */
  applyWorkflowCapabilities() {
    const wf = this.currentWorkflow();
    const kind = this.kindOf(wf);
    const promptMode = kind === "prompt";
    const video = kind === "video";

    // 选中某个工作流时，左上角媒体类型跟着切过去
    this.setMediaType(kind);

    // 提示词模式：藏掉生成参数，露出提示词功能选择
    $("#paramsChip").hidden = promptMode;
    $("#functionChip").hidden = !promptMode;
    if (promptMode) {
      const notice = $("#paramsNotice");
      notice.hidden = true;
      $("#sendBtn").title = "生成提示词";
      this.renderFunctionList();
      return;
    }
    $("#sendBtn").title = "开始生成";

    const scale = wf.scale || null;
    const size = wf.supports_size !== false;
    const batch = wf.supports_batch !== false;
    const locked = !size || !batch;

    // 只有放大倍数的工作流：只开放倍率滑块，其余参数保持灰色不可用
    const scaleField = $("#scaleField");
    if (scaleField) scaleField.hidden = !scale;
    if (scale) {
      const range = $("#scaleRange");
      range.min = scale.min ?? 1;
      range.max = scale.max ?? 10;
      range.step = scale.step ?? 0.1;
      if (!Number(State.params.scale)) State.params.scale = scale.default ?? 2;
      range.value = State.params.scale;
      $("#scaleValue").textContent = `${Number(State.params.scale).toFixed(1)}×`;
    }

    const chip = $("#paramsChip");
    chip.classList.toggle("locked", locked);
    chip.title = video
      ? `${wf.name || "当前工作流"}：比例跟随参考图，时长与质量可调`
      : locked ? `${wf.name || "当前工作流"} 的参数由参考图决定` : "图片生成参数";

    $("#ratioField").classList.toggle("disabled", !size);
    $("#resField").classList.toggle("disabled", !size);
    $("#batchField").classList.toggle("disabled", !batch);

    const notice = $("#paramsNotice");
    notice.hidden = !locked;
    if (scale) {
      notice.hidden = false;
      notice.textContent = `${wf.name || "当前工作流"}：只有放大倍数可调，其余参数由工作流固定。`;
    } else if (locked) {
      const reasons = [];
      if (!size) reasons.push("输出尺寸与参考图一致");
      if (!batch) reasons.push(video ? "每张参考图各生成 1 段视频" : "每张参考图各生成 1 张");
      notice.textContent = `${wf.name || "当前工作流"}：${reasons.join("；")}。`;
    }
    // 网格拼接（纯 Python）：只开放「行 × 列」，比例 / 分辨率 / 张数保持灰色不可选
    this.syncGrid(wf);
    if (wf.grid) {
      notice.hidden = false;
      notice.textContent = `${wf.name || "当前工作流"}：只有网格行列可调；比例 / 分辨率 / 张数由图片本身决定。`;
    }

    // 不需要提示词的工作流（如纯放大）：输入框置灰只读，避免用户白写
    const noPrompt = wf.supports_prompt === false;
    const promptBox = $("#promptInput");
    if (promptBox) {
      promptBox.disabled = noPrompt;
      promptBox.classList.toggle("is-locked", noPrompt);
      promptBox.placeholder = noPrompt
        ? (wf.grid
          ? `${wf.name || "当前工作流"}不需要提示词：按顺序放好图片、选好行列即可`
          : `${wf.name || "当前工作流"}不需要提示词，只需左侧放一张参考图`)
        : (video ? "描述要生成的视频画面..." : "描述要生成的图片...");
      // 注意：不清空输入框。切到不需要提示词的工作流时把文字留着，切回来还在
    }

    const pop = $("#paramsPop");
    pop.classList.toggle("compact", !size && !video && !scale);
    this.syncChoices();
    this.updateLabels();
    this.updateHint();
  },

  /* 当前工作流与已选素材是否匹配：不匹配就在输入框下面说明一句，
     素材和文字都不清空，切回去还能接着用 */
  updateHint() {
    const box = $("#composerHint");
    if (!box) return;
    const wf = this.currentWorkflow();
    const refs = State.references.length;
    const kind = this.kindOf(wf);
    let text = "";
    if (!wf.id) {
      text = "还没有可用工作流，先到设置里接入。";
    } else if (kind === "prompt") {
      if (refs) text = `已选 ${refs} 个素材，会按顺序一起交给提示词模型。`;
    } else if (wf.needs_image) {
      const noPrompt = wf.supports_prompt === false;
      const limits = wf.limits || {};
      // 多参考工作流（图 + 视频 + 音频）单独说明，避免用户只放了一张图就以为够了
      const multi = limits.videos != null || limits.audios != null;
      if (!refs) {
        text = wf.grid
          ? `「${wf.name}」需要图片：点左上角「参考图」按想要的顺序把图加进来。`
          : noPrompt
            ? `「${wf.name}」只需要参考图（不需要提示词）：点左上角「参考图」添加一张。`
            : multi
              ? `「${wf.name}」至少要一张参考图；也可以再拖视频 / 音频进来当参考（最多 ${limits.images ?? "∞"} 图 / ${limits.videos ?? 0} 视频 / ${limits.audios ?? 0} 音频）。`
              : `「${wf.name}」需要参考图：点左上角「参考图」添加，或从图库拖一张过来。`;
      } else if (wf.grid) {
        text = this.gridHintText(State.params, wf.grid);
      } else if (multi) {
        const kinds = { image: 0, video: 0, audio: 0 };
        State.references.forEach((ref) => { kinds[ref.kind || "image"] += 1; });
        text = `已选 ${kinds.image} 图 / ${kinds.video} 视频 / ${kinds.audio} 音频，会一起作为参考素材（上限 ${limits.images ?? "∞"} / ${limits.videos ?? 0} / ${limits.audios ?? 0}）。`;
      } else if (noPrompt) {
        text = `「${wf.name}」不需要提示词，只用参考图；已经写的文字会保留。`;
      }
    } else if (refs) {
      text = `「${wf.name}」是文生图，不会用到已选的 ${refs} 个素材（素材会保留，切回图生图即可使用）。`;
    }
    box.textContent = text;
    box.hidden = !text;
  },

  /* 图片模式只列图片工作流，视频模式只列视频工作流，提示词模式只列 LLM 工作流 */
  workflowsFor(type = State.mediaType) {
    return State.workflows.filter((wf) => {
      // 局部重绘这类专用工作流只在作品卡片的对应入口里出现，不混进创作区
      // （tool = 纯本地工具，比如视频尾帧，没有 ComfyUI 图可以提交）
      if (wf.category === "inpaint" || wf.category === "tool") return false;
      // 当前 ComfyUI 实例跑不起来（缺节点 / 缺模型）的不列出来，免得选了才报错
      if (wf.available === false) return false;
      const kind = wf.kind || "image";
      if (type === "prompt") return kind === "llm";
      if (kind === "llm") return false;
      return type === "video" ? kind === "video" : kind !== "video";
    });
  },

  /* ---------- 提示词功能 ---------- */
  functions: [
    { key: "polish", label: "提示词润色", desc: "输入框文字 + 系统/用户提示词" },
    { key: "reverse", label: "单图反推", desc: "第一张图片 + 输入框文字 + 模版" },
    { key: "edit", label: "图片编辑润色", desc: "全部图片（按顺序）+ 输入框文字" },
    { key: "minimax", label: "minimax-h3提示词润色", desc: "全部图片/视频/音频（按顺序）+ 输入框文字" },
  ],

  function() {
    const saved = localStorage.getItem("wwdm-prompt-function") || "";
    return this.functions.some((item) => item.key === saved) ? saved : "polish";
  },

  setFunction(key) {
    if (!this.functions.some((item) => item.key === key)) return;
    localStorage.setItem("wwdm-prompt-function", key);
    this.renderFunctionList();
    this.applyWorkflowCapabilities();
  },

  functionLabel() {
    const found = this.functions.find((item) => item.key === this.function());
    return found ? found.label : "提示词";
  },

  renderFunctionList() {
    const current = this.function();
    const box = $("#functionList");
    if (!box) return;
    box.innerHTML = this.functions.map((item) => `
      <button class="workflow-item ${item.key === current ? "active" : ""}" data-fn="${item.key}">
        <span class="wf-icon">${icon("sparkle")}</span>
        <span><span class="wf-name">${escapeHtml(item.label)}</span>
          <span class="wf-desc" style="display:block">${escapeHtml(item.desc)}</span></span>
        <span class="wf-check">${icon("check")}</span>
      </button>`).join("");
    const found = this.functions.find((item) => item.key === current);
    $("#functionLabel").textContent = found ? found.label : "提示词润色";
  },

  /* 媒体类型切换：同步标签、图例、占位符，并把工作流换成同类 */
  setMediaType(type, switchWorkflow = true) {
    const previous = State.mediaType;
    const changed = previous !== type;
    if (changed && switchWorkflow) {
      // 记住每种类型上次用的工作流，来回切时不会跳走
      const current = this.currentWorkflow();
      if (current.id && this.kindOf(current) === previous) {
        this._remember[previous] = current.id;
      }
    }
    State.mediaType = type;
    const labels = { image: "图片", video: "视频", prompt: "提示词" };
    const icons = { image: "#i-image", video: "#i-video", prompt: "#i-text" };
    $("#mediaLabel").textContent = labels[type] || "图片";
    $("#mediaSelectBtn use").setAttribute("href", icons[type] || "#i-image");
    // 提示词模式里这些不再只是「参考图」，图片/视频/音频都算素材
    const refLabel = $("#refBtn span");
    if (refLabel) refLabel.textContent = type === "prompt" ? "素材" : "参考图";
    $("#refBtn").title = type === "prompt" ? "添加图片 / 视频 / 音频素材" : "添加参考图";
    $$("#mediaMenu button").forEach((node) => node.classList.toggle("active", node.dataset.type === type));
    // 提示词被锁（纯放大等不需要提示词的工作流）时不覆盖占位文案
    const promptEl = $("#promptInput");
    if (!promptEl.disabled) {
      promptEl.placeholder = type === "video"
        ? "描述视频里的动作、镜头与氛围..."
        : type === "prompt"
          ? "写下想要的提示词，或让模型帮你反推 / 改写..."
          : "描述要生成的图片...";
    }
    if (!changed || !switchWorkflow || !State.workflows.length) {
      this.updateHint();
      return;
    }

    const list = this.workflowsFor(type);
    const current = this.currentWorkflow();
    if (!current.id || this.kindOf(current) !== type) {
      // 记住的选择优先；没有就从第一个「正常」工作流开始（网格拼接这种专用工具不当默认）
      const target = list.find((wf) => wf.id === this._remember[type])
        || list.find((wf) => wf.engine !== "python")
        || list[0];
      if (target) this.setWorkflow(target.id);
      else {
        State.workflow = "";
        $("#workflowLabel").textContent = "无可用工作流";
      }
    }
    this.renderWorkflowList();
    this.updateHint();
  },

  /* 工作流属于哪种媒体：llm → prompt，其余看 kind */
  kindOf(wf) {
    const kind = wf?.kind || "image";
    if (kind === "llm") return "prompt";
    return kind === "video" ? "video" : "image";
  },

  renderWorkflowList() {
    const list = this.workflowsFor();
    const box = $("#workflowList");
    if (!list.length) {
      box.innerHTML = `<div class="wf-empty">当前类型还没有工作流</div>`;
      return;
    }
    box.innerHTML = list.map((wf) => `
      <button class="workflow-item ${wf.id === State.workflow ? "active" : ""}" data-id="${escapeHtml(wf.id)}">
        <span class="wf-icon">${icon(wf.kind === "video" ? "video" : "image")}</span>
        <span><span class="wf-name">${escapeHtml(wf.name)}</span>
          <span class="wf-desc" style="display:block">${escapeHtml(wf.description)} · ${
            wf.engine === "python" ? "本地运算" : `${wf.node_count} 节点`}</span></span>
        <span class="wf-check">${icon("check")}</span>
      </button>`).join("");
  },

  renderChoices() {
    $("#ratioChoices").innerHTML = [...this.ratios, "自定义"].map(
      (r) => `<button class="choice" data-ratio="${r}">${r}</button>`
    ).join("");
    $("#videoRatioChoices").innerHTML = this.videoRatios.map(
      (r) => `<button class="choice" data-vratio="${r}">${r}</button>`
    ).join("");
    $("#resChoices").innerHTML = this.resolutions.map(
      ([value, label]) => `<button class="choice" data-res="${value}">${label}</button>`
    ).join("");
    $("#batchChoices").innerHTML = this.batches.map(
      (value) => `<button class="choice" data-batch="${value}">${value} 张</button>`
    ).join("");
    this.syncChoices();
  },

  syncChoices() {
    const p = State.params;
    const sizeOn = this.sizeEnabled();
    const video = this.isVideo();
    $("#imageParamsGroup").hidden = video;
    $("#videoParamsGroup").hidden = !video;

    $$("#ratioChoices .choice").forEach((b) => {
      const isCustom = b.dataset.ratio === "自定义";
      b.classList.toggle("active", sizeOn && (p.custom ? isCustom : b.dataset.ratio === p.ratio));
      // 灰化但保持可点击，方便随时切回固定比例
      b.classList.toggle("muted", !!p.custom && !isCustom);
    });
    $$("#resChoices .choice").forEach((b) => {
      b.classList.toggle("active", sizeOn && b.dataset.res === p.resolution);
      b.classList.toggle("muted", !!p.custom);
    });
    const batchOn = this.batchEnabled();
    $$("#batchChoices .choice").forEach((b) =>
      b.classList.toggle("active", batchOn && Number(b.dataset.batch) === p.batch));
    // 视频比例直接控制 ResolutionSelector，正常可选可切换
    $$("#videoRatioChoices .choice").forEach((b) =>
      b.classList.toggle("active", b.dataset.vratio === p.video_ratio));

    $("#customSizeField").hidden = !p.custom || !sizeOn;
    $("#resField").classList.toggle("disabled", !sizeOn);
    $("#batchField").classList.toggle("disabled", !batchOn);
    $("#videoRatioField").classList.toggle("disabled", !sizeOn);
    $("#qualityRange").value = p.quality;
    $("#qualityValue").textContent = Number(p.quality).toFixed(1);
    $("#qualityRange").style.setProperty("--fill", `${((p.quality - 0.2) / 1.8) * 100}%`);
    $("#durationRange").value = p.duration;
    $("#durationValue").textContent = `${p.duration} 秒`;
    $("#durationRange").style.setProperty("--fill", `${((p.duration - 1) / 14) * 100}%`);
    if (p.custom) {
      $("#customWidth").value = p.custom_width;
      $("#customHeight").value = p.custom_height;
    }
  },

  updateLabels() {
    const p = State.params;
    const wf = this.currentWorkflow();
    if (wf.grid) {
      const rows = Number(p.grid_rows) || 1;
      const cols = Number(p.grid_cols) || 1;
      const refs = State.references.length;
      $("#paramsLabel").textContent = `网格 ${rows}×${cols}`;
      $("#sizePreview").textContent = refs
        ? `${cols} 列 × ${rows} 行 · 已选 ${refs} 张，按原图像素拼接（不缩放）`
        : `${cols} 列 × ${rows} 行 · 先加参考图`;
      const hint = $("#gridHint");
      if (hint) hint.textContent = this.gridHintText(p, wf.grid);
      return;
    }
    if (wf.scale) {
      const factor = Number(p.scale || wf.scale.default || 2).toFixed(1);
      $("#paramsLabel").textContent = `放大 ×${factor}`;
      $("#sizePreview").textContent = `输出 = 原图 × ${factor}`;
      return;
    }
    if (this.isVideo()) {
      // 视频：比例 + 百万像素画质 + 时长，宽高由尺寸节点计算
      $("#paramsLabel").textContent =
        `视频 · ${p.video_ratio} · ${Number(p.quality).toFixed(1)}MP · ${p.duration}秒`;
      $("#sizePreview").textContent = `输出约 ${estimateMpSize(p.video_ratio, p.quality)}（${p.video_ratio} · ${Number(p.quality).toFixed(1)}MP）`;
      return;
    }
    const sizeOn = this.sizeEnabled();
    const batchOn = this.batchEnabled();
    const [w, h] = sizeForParams(p);
    const parts = [];
    if (sizeOn) {
      parts.push(p.custom ? `自定义 ${w}×${h}` : `${p.ratio} · ${p.resolution.toUpperCase()}`);
    } else {
      // 图生图的出图尺寸由参考图决定，比例/分辨率不再生效
      parts.push("跟随参考图");
    }
    if (batchOn) {
      parts.push(`${p.batch}张`);
    } else {
      const count = State.references.length;
      parts.push(count ? `${count}张` : "待选图");
    }
    $("#paramsLabel").textContent = parts.join(" · ");
    $("#sizePreview").textContent = sizeOn ? `输出 ${w} × ${h} 像素` : "输出尺寸与参考图一致";
  },

  async loadWorkflows() {
    try {
      State.workflows = await API.listWorkflows();
      // 提示词（LLM）工作流只用于润色，不出现在生成工作流选择里
      const list = this.workflowsFor();
      if (!list.some((wf) => wf.id === State.workflow)) {
        const pick = list.find((wf) => wf.engine !== "python") || list[0];
        if (pick) State.workflow = pick.id;
        else State.workflow = "";
      }
      this.renderWorkflowList();
      const found = list.find((wf) => wf.id === State.workflow);
      $("#workflowLabel").textContent = found ? found.name : "无可用工作流";
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    }
  },

  bind() {
    const paramsPop = $("#paramsPop");
    const workflowPop = $("#workflowPop");
    const functionPop = $("#functionPop");
    // 弹层贴着触发它的 chip 显示（之前相对整块创作区定位，看起来离得很远）
    const placePop = (pop, trigger) => {
      if (!pop || !trigger) return;
      const host = pop.offsetParent;
      if (!host) return;
      const hostBox = host.getBoundingClientRect();
      const box = trigger.getBoundingClientRect();
      const width = pop.offsetWidth;
      const height = pop.offsetHeight;
      const max = host.clientWidth - width - 8;
      pop.style.left = `${Math.max(8, Math.min(max, box.left - hostBox.left))}px`;
      // 弹层是 .composer-region 的直接子节点，用 bottom 从下沿往上顶，才能贴着 chip 上沿
      const fromTop = box.top - hostBox.top;
      pop.style.bottom = `${Math.max(8, hostBox.height - fromTop + 8)}px`;
      pop.style.top = "auto";
    };
    const closePops = () => {
      paramsPop.hidden = true;
      workflowPop.hidden = true;
      functionPop.hidden = true;
      $("#mediaMenu").hidden = true;
    };

    $("#paramsChip").addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = paramsPop.hidden;
      closePops();
      paramsPop.hidden = !opening;
      if (opening) {
        placePop(paramsPop, $("#paramsChip"));
        requestAnimationFrame(() => placePop(paramsPop, $("#paramsChip")));
      }
    });
    // 网格拼接的行 / 列：改完立刻同步标签和提示，不需要点确定
    [["gridRows", "grid_rows"], ["gridCols", "grid_cols"]].forEach(([id, key]) => {
      $(`#${id}`)?.addEventListener("change", (event) => {
        State.params[key] = Number(event.target.value) || 1;
        this.updateLabels();
        this.updateHint();
      });
    });
    $("#workflowChip").addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = workflowPop.hidden;
      closePops();
      workflowPop.hidden = !opening;
      if (opening) {
        placePop(workflowPop, $("#workflowChip"));
        requestAnimationFrame(() => placePop(workflowPop, $("#workflowChip")));
      }
    });
    $("#functionChip").addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = functionPop.hidden;
      closePops();
      functionPop.hidden = !opening;
      if (opening) {
        placePop(functionPop, $("#functionChip"));
        requestAnimationFrame(() => placePop(functionPop, $("#functionChip")));
      }
    });
    $$("[data-close-pop]").forEach((btn) => btn.addEventListener("click", closePops));
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".popover") && !event.target.closest(".chip")) closePops();
    });

    $("#ratioChoices").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-ratio]");
      if (!btn) return;
      if (btn.dataset.ratio === "自定义") {
        State.params.custom = true;
      } else {
        State.params.custom = false;
        State.params.ratio = btn.dataset.ratio;
      }
      this.syncChoices(); this.updateLabels();
    });
    $("#scaleRange").addEventListener("input", (event) => {
      State.params.scale = Number(event.target.value);
      $("#scaleValue").textContent = `${State.params.scale.toFixed(1)}×`;
      this.updateLabels();
    });
    $("#customWidth").addEventListener("input", (event) => {
      State.params.custom_width = event.target.value;
      this.updateLabels();
    });
    $("#customHeight").addEventListener("input", (event) => {
      State.params.custom_height = event.target.value;
      this.updateLabels();
    });
    $("#resChoices").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-res]");
      if (!btn) return;
      State.params.custom = false;
      State.params.resolution = btn.dataset.res;
      this.syncChoices(); this.updateLabels();
    });
    $("#batchChoices").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-batch]");
      if (!btn) return;
      State.params.batch = Number(btn.dataset.batch);
      this.syncChoices(); this.updateLabels();
    });
    $("#functionList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-fn]");
      if (!item) return;
      this.setFunction(item.dataset.fn);
      closePops();
    });

    $("#workflowList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-id]");
      if (!item) return;
      State.workflow = item.dataset.id;
      $("#workflowLabel").textContent = item.querySelector(".wf-name").textContent;
      $$("#workflowList .workflow-item").forEach((node) => node.classList.toggle("active", node === item));
      this.applyWorkflowCapabilities();
      closePops();
    });

    $("#mediaSelectBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("#mediaMenu");
      const opening = menu.hidden;
      closePops();
      menu.hidden = !opening;
    });
    $("#mediaMenu").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-type]");
      if (!btn) return;
      this.setMediaType(btn.dataset.type);
      $("#mediaMenu").hidden = true;
    });

    // 视频参数：质量 0.2–2（步长 0.1）、时长 1–15 秒
    $("#qualityRange").addEventListener("input", (event) => {
      State.params.quality = Number(event.target.value);
      this.syncChoices();
      this.updateLabels();
    });
    $("#durationRange").addEventListener("input", (event) => {
      State.params.duration = Number(event.target.value);
      this.syncChoices();
      this.updateLabels();
    });
    $("#videoRatioChoices").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-vratio]");
      if (!btn) return;
      State.params.video_ratio = btn.dataset.vratio;
      this.syncChoices();
      this.updateLabels();
    });

    $("#expandBtn").addEventListener("click", () => $("#composer").classList.toggle("expanded"));
    $("#collapseHint").addEventListener("click", () => {
      const region = $("#composerRegion");
      const collapsed = region.classList.toggle("collapsed");
      $("#composer").hidden = collapsed;
      $("#collapseHint").querySelector("span").textContent = collapsed ? "展开创作区" : "收起创作区";
      $("#collapseHint").querySelector("svg").style.transform = collapsed ? "rotate(180deg)" : "";
    });

    $("#promptInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) this.submit();
    });
    $("#promptInput").addEventListener("input", () => this.autoGrow());
    $("#sendBtn").addEventListener("click", () => this.sendOrStop());
    $("#clearComposer").addEventListener("click", () => this.clearAll());

    // 参考图图标 → 弹出【本地上传 | 从资源选择】
    $("#refBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("#attachMenu");
      menu.hidden = !menu.hidden;
    });
    $("#attachMenu").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-attach]");
      if (!btn) return;
      $("#attachMenu").hidden = true;
      if (btn.dataset.attach === "local") {
        $("#refFileInput").dataset.from = "composer";
        $("#refFileInput").click();
      } else {
        this.openPicker();
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#attachMenu") && !event.target.closest("#refBtn")) {
        $("#attachMenu").hidden = true;
      }
    });
    $("#refFileInput").addEventListener("change", (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (files.length) this.uploadLocal(files, event.target.dataset.from);
    });

    // 直接从剪贴板粘贴图片 / 视频 / 音频上传（截图、复制的文件都能用）
    const composer = $(".composer");
    composer?.addEventListener("paste", (event) => this.handlePaste(event));
  },

  /* 判断是不是可上传的媒体文件，返回 image / video / audio */
  mediaKindOf(file) {
    const type = (file?.type || "").toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    const name = file?.name || "";
    if (/\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(name)) return "image";
    if (/\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(name)) return "video";
    if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(name)) return "audio";
    return "";
  },

  /* 剪贴板里的文件常常叫 blob / image.png，补一个带正确扩展名的文件名给后端识别类型 */
  withFileName(file, index) {
    const EXT = {
      "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
      "image/gif": "gif", "image/bmp": "bmp", "image/avif": "avif",
      "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
      "video/x-matroska": "mkv", "audio/mpeg": "mp3", "audio/wav": "wav",
      "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/flac": "flac",
    };
    const name = file.name || "";
    if (/\.[a-z0-9]{2,5}$/i.test(name) && name !== "blob") return file;
    const ext = EXT[file.type] || (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const renamed = `paste-${Date.now()}-${index + 1}.${ext}`;
    return new File([file], renamed, { type: file.type || "" });
  },

  handlePaste(event) {
    const dt = event.clipboardData;
    if (!dt) return;
    let files = [...(dt.files || [])];
    if (!files.length && dt.items?.length) {
      files = [...dt.items]
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(Boolean);
    }
    const media = files.filter((file) => this.mediaKindOf(file));
    if (!media.length) return;   // 纯文本粘贴，交给浏览器默认行为
    event.preventDefault();
    const named = media.map((file, index) => this.withFileName(file, index));
    this.uploadLocal(named, "composer", { pasted: true });
  },

  /* 本地上传（选文件 / 粘贴都走这里）：图片、视频、音频都收，进 ComfyUI 的 input/wwdm_ref/<项目> */
  async uploadLocal(files, from, options = {}) {
    const allowed = files.filter((file) => this.mediaKindOf(file));
    if (!allowed.length) {
      toast("只支持图片 / 视频 / 音频", true);
      return;
    }
    if (from === "picker") $("#pickerUpload").disabled = true;
    toast(`正在上传 ${allowed.length} 个素材…`);
    try {
      const result = await API.uploadReferences(allowed, State.activeId);
      const picked = (result.items || []).map((item, index) => ({
        name: item.name,
        source: item.source,
        origin: item.origin || allowed[index]?.name,
        // 后端上传接口不返回类型，这里按粘贴/选择的文件补上，参考图才能正确显示视频 / 音频
        kind: this.mediaKindOf(allowed[index]) || "image",
      }));
      if (!picked.length) throw new Error("上传没有返回素材");
      if (from === "picker" && !$("#pickerModal").hidden) {
        // 弹窗里上传完直接回列表，让用户在缩略图里确认
        await Picker.load();
        toast(`已上传 ${picked.length} 个素材，可在「本项目」里查看`);
      } else {
        this.addReferences(picked);
        if (options.pasted) toast(`已从剪贴板添加 ${picked.length} 个素材`);
      }
    } catch (error) {
      Dialog.warn({ title: "上传失败", message: error.message });
    } finally {
      if (from === "picker") $("#pickerUpload").disabled = false;
    }
  },

  addReferences(picked) {
    const merged = [...State.references];
    picked.forEach((item) => {
      if (!merged.some((ref) => ref.name === item.name)) merged.push(item);
    });
    State.references = merged;
    this.renderReferences();
    const kinds = new Set(picked.map((item) => item.kind || "image"));
    toast(kinds.size === 1 && kinds.has("image")
      ? `已添加 ${picked.length} 张参考图`
      : `已添加 ${picked.length} 个素材`);
  },

  /* 打开资源选择弹窗，选中的素材追加到参考图列表；提示词模式允许图片/视频/音频 */
  openPicker() {
    Picker.open((picked) => this.addReferences(picked), {
      allowMedia: State.mediaType === "prompt",
    });
  },

  /* 参考图地址：资产库 / 本项目作品 / ComfyUI 目录 */
  refUrl(ref) {
    if (ref.url) return ref.url;
    if (ref.source === "project") return ref.name;
    if (ref.source === "library") {
      const [category, ...rest] = String(ref.name || "").split("/");
      return `/api/library/file?category=${encodeURIComponent(category)}&name=${encodeURIComponent(rest.join("/"))}`;
    }
    return API.comfyFileUrl(ref.source || "input", ref.name);
  },

  renderReferences() {
    const chips = $("#refChips");
    const refs = State.references;
    const labels = { image: "图片", video: "视频", audio: "音频" };
    const icons = { image: "#i-image", video: "#i-video", audio: "#i-mic" };
    if (!refs.length) {
      chips.innerHTML = "";
      this.updateLabels();
      this.updateHint();
      return;
    }
    const per = Number(this.currentWorkflow().images_per_task) || 1;
    // 多参考工作流（图 + 视频 + 音频混排）按类型各自编号，不然会出现「视频 3」这种怪编号
    const counters = { image: 0, video: 0, audio: 0 };
    chips.innerHTML = refs.map((ref, index) => {
      const kind = ref.kind || "image";
      const url = this.refUrl(ref);
      const preview = kind === "image"
        ? `<img src="${url}" alt="">`
        : kind === "video"
          ? `<video class="ref-video" src="${url}#t=0.1" muted playsinline preload="metadata"></video>`
          : `<span class="ref-ph"><svg><use href="${icons[kind] || "#i-image"}"/></svg></span>`;
      // 首尾帧工作流（per=2）才标首/尾帧；其余按类型编号「图片 2」「视频 1」
      const ordinal = (counters[kind] = (counters[kind] || 0) + 1);
      const label = per === 2 && kind === "image"
        ? (index % 2 === 0 ? "首帧" : "尾帧")
        : `${labels[kind] || "素材"} ${ordinal}`;
      return `
      <div class="ref-chip" data-preview-ref="${index}" title="点击查看素材 · ${escapeHtml(ref.origin || ref.name)}">
        ${preview}
        <span class="ref-index">${label}</span>
        <button data-remove="${index}" title="移除"><svg><use href="#i-close"/></svg></button>
      </div>`;
    }).join("");

    // 点参考图（非删除按钮）弹窗预览这个素材
    $$("[data-preview-ref]", chips).forEach((chip) => {
      chip.addEventListener("click", (event) => {
        if (event.target.closest("[data-remove]")) return;
        const ref = refs[Number(chip.dataset.previewRef)];
        if (!ref) return;
        const url = this.refUrl(ref);
        if (ref.taskId) Works.preview(ref.taskId, url);
        else Works.previewAsset({ url, name: ref.origin || ref.name, kind: ref.kind || "image", source: ref.source });
      });
    });

    $$("[data-remove]", chips).forEach((btn) => {
      btn.addEventListener("click", () => {
        State.references.splice(Number(btn.dataset.remove), 1);
        this.renderReferences();
      });
    });
    this.updateLabels();
    this.updateHint();
  },

  /* 输入框随内容长高，避免优化回来的长提示词被压在 2 行里 */
  autoGrow() {
    const el = $("#promptInput");
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  },

  /* 点击输入框右侧的「提示词」模式后走这里：按当前功能组装素材，回填生成的提示词 */
  async runPrompt() {
    const input = $("#promptInput");
    const text = input.value.trim();
    let refs = State.references;
    try {
      refs = await this.prepareRefs(refs);
    } catch (error) {
      return Dialog.warn({ title: "素材准备失败", message: error.message });
    }
    let assets = refs.map((ref) => ({
      name: ref.name, kind: ref.kind || "image",
    }));
    // 按当前工作流的素材上限裁剪（如 Gemma4 最多 1 图 + 1 视频 + 1 音频）
    const limits = this.currentWorkflow().limits;
    if (limits) {
      const used = { image: 0, video: 0, audio: 0 };
      let dropped = 0;
      assets = assets.filter((asset) => {
        const cap = limits[`${asset.kind}s`] ?? limits[asset.kind];
        if (cap != null && used[asset.kind] >= cap) {
          dropped += 1;
          return false;
        }
        used[asset.kind] += 1;
        return true;
      });
      if (dropped) {
        toast(`当前工作流素材上限：${limits.images ?? "∞"} 图 / ${limits.videos ?? "∞"} 视频 / ${limits.audios ?? "∞"} 音频，已忽略 ${dropped} 个`);
      }
    }
    if (!text && !assets.length) {
      Dialog.warn({ title: "还没有内容", message: "写点描述，或者先选几张素材，再来生成提示词。" });
      return;
    }
    const btn = $("#sendBtn");
    if (this._promptRunning) return;
    this._promptRunning = true;
    this._promptAbort = new AbortController();
    this.updateSendButton();
    try {
      const result = await API.runPrompt({
        prompt: text,
        function: this.function(),
        workflow: State.workflow,
        assets,
      }, { signal: this._promptAbort.signal });
      const generated = result.prompt || text;
      input.value = generated;
      this.autoGrow();
      const tpl = result.template?.name ? ` · ${result.template.name}` : "";
      // 实际送进模型的素材数量（以服务端回执为准）：多图反推时能马上看出有没有漏图
      const used = result.assets;
      const sent = used
        ? [used.images?.length ? `${used.images.length} 图` : "",
          used.videos?.length ? `${used.videos.length} 视频` : "",
          used.audios?.length ? `${used.audios.length} 音频` : ""].filter(Boolean).join(" + ")
        : "";
      const sentText = sent ? ` · 送入 ${sent}` : "";
      // 同时存一份 txt 到图库「提示词」，切换模式 / 刷新页面都不会丢
      const title = (text || this.functionLabel() || "提示词").slice(0, 20);
      try {
        const saved = await API.savePromptText(generated, title);
        toast(`提示词已生成${tpl}${sentText} · 已存到图库「${saved.category || "提示词"}」`);
      } catch {
        toast(`提示词已生成${tpl}${sentText}（存 txt 失败，可手动复制）`, true);
      }
    } catch (error) {
      if (error?.aborted) toast("已停止提示词生成");
      else Dialog.warn({ title: "提示词生成失败", message: error.message });
    } finally {
      this._promptRunning = false;
      this._promptAbort = null;
      this.updateSendButton();
    }
  },

  /* 资产库 / 输出目录 / 本项目作品的素材，提交前先转成 ComfyUI input 名 */
  async prepareRefs(refs) {
    if (!refs.length) return [];
    if (!refs.some((ref) => (ref.source || "input") !== "input")) return refs;
    const result = await API.importReferences(refs.map((ref) => ({
      source: ref.source || "input", name: ref.name,
    })));
    return refs.map((ref, index) => ({
      ...ref,
      name: (result.items || [])[index]?.name || ref.name,
      source: "input",
    }));
  },

  async submit() {
    if (State.mediaType === "prompt") return this.runPrompt();
    const input = $("#promptInput");
    const prompt = input.value.trim();
    const workflow = State.workflows.find((item) => item.id === State.workflow) || {};
    if (workflow.available === false) {
      return Dialog.warn({
        title: "当前实例跑不了这个工作流",
        message: `${workflow.name || workflow.id}：${workflow.unavailable_reason || "缺少节点或模型"}`,
      });
    }
    // 纯放大类工作流（supports_prompt=false）不需要提示词，只要有图
    if (workflow.supports_prompt !== false && !prompt) {
      return Dialog.warn({ title: "缺少提示词", message: "请先在创作框描述要生成的画面。" });
    }
    const video = (workflow.kind || "image") === "video";
    // 网格拼接：行列缺失时用工作流默认值补上，保证提交的参数和界面显示一致
    if (workflow.grid) {
      if (!Number(State.params.grid_rows)) State.params.grid_rows = Number(workflow.grid.rows) || 1;
      if (!Number(State.params.grid_cols)) State.params.grid_cols = Number(workflow.grid.cols) || 1;
    }
    const limits = workflow.limits || {};
    // 多参考素材（图 + 视频 + 音频一起进同一个任务）只在这种工作流里出现
    const multiModal = limits.videos != null || limits.audios != null;
    let refs = workflow.needs_image ? State.references : [];
    if (!multiModal) {
      // 普通图片 / 视频工作流只吃图：附带的视频音频在这里就丢掉，别去占 image 的槽
      refs = refs.filter((ref) => (ref.kind || "image") === "image");
    }
    // 按类型分别卡上限（图 9 / 视频 3 / 音频 3）
    const used = { image: 0, video: 0, audio: 0 };
    let dropped = 0;
    refs = refs.filter((ref) => {
      const kind = ref.kind || "image";
      const cap = limits[`${kind}s`];
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
    if (workflow.needs_image && (refs.length ? !refs.some((ref) => (ref.kind || "image") === "image") : true)) {
      return Dialog.warn({
        title: "缺少参考图",
        message: workflow.supports_prompt === false
          ? "这个工作流需要一张图片，点左侧「参考图」选一张。"
          : video
            ? "图生视频需要一张参考图作为首帧，点左侧「参考图」选一张。"
            : "当前工作流需要参考图，点左侧「参考图」选一张。",
      });
    }
    try {
      // 纯 Python 工作流（网格拼接）在本地读原图，不需要先传进 ComfyUI
      if (!this.isLocalEngine(workflow)) refs = await this.prepareRefs(refs);
    } catch (error) {
      return Dialog.warn({ title: "参考图准备失败", message: error.message });
    }
    // 按工作流要求分组：普通图生图一图一任务；首尾帧工作流两图一任务；
    // 多参考工作流把所有素材塞进同一个任务
    const per = multiModal
      ? Math.max(1, refs.length)
      : Math.max(1, Number(workflow.images_per_task) || 1);
    const jobs = [];
    if (refs.length) {
      for (let i = 0; i < refs.length; i += per) jobs.push(refs.slice(i, i + per));
    } else {
      jobs.push(null);
    }
    const sendBtn = $("#sendBtn");
    sendBtn.disabled = true;
    this._stopRequested = false;
    try {
      for (const group of jobs) {
        const extra = {};
        if (this.isLocalEngine(workflow)) {
          // 本地引擎：把素材的「来源 + 名字」原样交给后端，由它自己读文件
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
          workflow: State.workflow,
          params: { ...State.params, ...extra },
        });
        if (task?.id) this.runningTaskIds.push(task.id);
        // 当前实例没有的 LoRA 会被后端跳过，这里顺口提示一句
        if (task?.warnings?.length) toast(task.warnings[0], true);
        if (this._stopRequested) {   // 提交途中被停止：后续任务不再下发
          break;
        }
      }
      // 提交后保留提示词与参考素材，方便连续微调；需要清空用右侧「清空」按钮
      toast(jobs.length > 1 ? `已提交 ${jobs.length} 个任务` : "任务已提交，可在运行状态里查看进度");
      window.Main?.refreshAll();
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    } finally {
      sendBtn.disabled = false;
      this.updateSendButton();
    }
  },

  /* 发送按钮双态：平时=生成；有任务在跑=停止 */
  isRunning() {
    return this._promptRunning || this.runningTaskIds.length > 0;
  },

  updateSendButton() {
    // 任务已结束的从清单里清掉
    this.runningTaskIds = this.runningTaskIds.filter((id) => {
      const task = (State.tasks || []).find((item) => item.id === id);
      return task && ["queued", "submitting", "running"].includes(task.status);
    });
    const btn = $("#sendBtn");
    const stopping = this.isRunning();
    btn.classList.toggle("stop", stopping);
    btn.classList.toggle("busy", stopping);
    btn.disabled = false;
    const use = btn.querySelector("use");
    if (use) use.setAttribute("href", stopping ? "#i-stop" : "#i-send");
    btn.title = stopping
      ? "停止运行中的任务"
      : (State.mediaType === "prompt" ? "生成提示词" : "开始生成");
  },

  async stop() {
    this._stopRequested = true;
    const ids = [...this.runningTaskIds];
    this.runningTaskIds = [];
    const wasPrompt = this._promptRunning;
    if (this._promptAbort) {
      this._promptAbort.abort();
      this._promptAbort = null;
      this._promptRunning = false;
    }
    let stopped = 0;
    for (const id of ids) {
      try { await API.cancelTask(id); stopped += 1; } catch { /* 已结束的任务忽略 */ }
    }
    // 提示词这类没有任务号的运行才需要额外中断；普通任务 cancel 已带中断
    if (wasPrompt || !ids.length) {
      try { await API.interruptComfy(); } catch { /* ComfyUI 不在线时忽略 */ }
    }
    this.updateSendButton();
    toast(stopped ? `已停止 ${stopped} 个任务` : "已停止当前运行");
    window.Main?.refreshAll();
  },

  /* 一键清空：提示词 + 参考素材一起清掉 */
  clearAll() {
    $("#promptInput").value = "";
    State.references = [];
    this.renderReferences();
    this.autoGrow();
    this.updateHint();
    $("#promptInput").focus();
    toast("已清空提示词和素材");
  },

  sendOrStop() {
    if (this.isRunning()) return this.stop();
    return this.submit();
  },
};
