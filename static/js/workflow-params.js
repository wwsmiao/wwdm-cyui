/* 设置里的工作流参数：图片 / 视频各自一栏，每个工作流独立折叠编辑 */
const WorkflowParams = {
  data: {},
  openIds: new Set(),
  loaded: false,

  async load(force = false) {
    if (this.loaded && !force) return;
    const all = State.workflows.length ? State.workflows : await API.listWorkflows();
    // 提示词（LLM）工作流单独放在「提示词参数」里；
    // 纯 Python 工作流（网格拼接）没有 ComfyUI 参数可配，不在这里出现
    const workflows = all.filter((wf) => (wf.kind || "image") !== "llm" && wf.engine !== "python");
    this.data = {};
    for (const workflow of workflows) {
      try {
        const info = await API.workflowParams(workflow.id);
        this.data[workflow.id] = {
          ...info.defaults, ...info.saved,
          _options: info.options || {},
          _name: workflow.name,
          _kind: workflow.kind || "image",
          _available: info.available !== false,
          _reason: info.unavailable_reason || "",
          _loraSlots: info.lora_slots || 0,
          _scale: workflow.scale || null,
          _supportsPrompt: workflow.supports_prompt,
          _paramKeys: Object.keys(info.param_map || {}),
          _fields: info.fields || [],
          _saved: { ...(info.saved || {}) },
        };
      } catch {
        this.data[workflow.id] = { _options: {}, _name: workflow.name, _kind: workflow.kind || "image", _paramKeys: [] };
      }
    }
    if (!this.openIds.size && workflows.length) this.openIds.add(workflows[0].id);
    this.loaded = true;
    this.render();
  },

  field(key, label, value, options, type = "text", full = false) {
    const safe = escapeHtml(value ?? "");
    let control;
    if (options?.length) {
      // 当前值不在远端列表里（换了 ComfyUI 实例）：留一条占位，别让浏览器默认选第一项
      const missing = value && !options.some((item) => String(item) === String(value))
        ? `<option value="${safe}" selected>${safe}（当前实例没有，需替换）</option>` : "";
      const opts = options.map((item) =>
        `<option value="${escapeHtml(item)}" ${String(item) === String(value) ? "selected" : ""}>${escapeHtml(item)}</option>`
      ).join("");
      control = `<select data-wf-key="${key}">${missing}${opts}</select>`;
    } else {
      control = `<input data-wf-key="${key}" type="${type}" value="${safe}" ${type === "number" ? 'step="any"' : ""}>`;
    }
    return `<label class="wf-field ${full ? "full" : ""}"><span>${label}</span>${control}</label>`;
  },

  switchField(key, label, value) {
    const on = value === true || ["1", "true", "on", "yes", "开"].includes(String(value ?? "").toLowerCase());
    return `
      <label class="wf-field wf-switch-field"><span>${label}</span>
        <button type="button" class="switch" data-wf-switch="${key}" role="switch"
                aria-checked="${on}"><span></span></button>
        <input type="hidden" data-wf-key="${key}" value="${on ? "true" : "false"}">
      </label>`;
  },

  /* 负面提示词：一行一个也能写，留空就沿用工作流图里自带的默认负面词 */
  negativeField(value) {
    return `
      <label class="wf-field full"><span>负面提示词（留空 = 用工作流自带默认）</span>
        <textarea data-wf-key="negative" rows="3" spellcheck="false"
                  placeholder="例如：low quality, bad anatomy, extra digits">${escapeHtml(value ?? "")}</textarea>
      </label>`;
  },

  /* LoRA 槽位：最多 N 个，留空即不加载（后端会把空槽位的节点整个摘掉） */
  loraBlock(values) {
    const slots = values._loraSlots || 0;
    if (!slots) return "";
    const names = values._options?.lora || [];
    const rows = Array.from({ length: slots }, (_, i) => {
      const index = i + 1;
      const current = values[`lora_${index}`] || "";
      const strength = values[`lora_${index}_strength`] ?? 1;
      const missing = current && !names.includes(current)
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（当前实例没有）</option>` : "";
      const opts = [`<option value="">不使用</option>`, missing].concat(
        names.map((name) => `<option value="${escapeHtml(name)}" ${String(name) === current ? "selected" : ""}>${escapeHtml(name)}</option>`)
      ).join("");
      return `
        <div class="wf-lora-row">
          <span class="wf-lora-idx">${index}</span>
          <select data-wf-key="lora_${index}" title="第 ${index} 个 LoRA">${opts}</select>
          <input data-wf-key="lora_${index}_strength" type="number" step="0.05" min="0" max="2"
                 value="${escapeHtml(strength)}" title="强度">
        </div>`;
    }).join("");
    return `
      <div class="wf-lora-box">
        <div class="wf-lora-head"><span>LoRA 模型</span><em>最多 ${slots} 个 · 库里有 ${names.length} 个 · 留空不加载</em></div>
        ${rows}
      </div>`;
  },

  /* 模型字段标签带上可选数量：一眼看出当前 ComfyUI 的清单里有多少个 */
  countLabel(label, list) {
    const count = (list || []).length;
    return count ? `${label}（可选 ${count} 个）` : label;
  },

  imageFields(values, options) {
    return [
      this.field("seed", "种子（-1 随机）", values.seed ?? -1, null, "number"),
      this.field("steps", "步数", values.steps ?? 8, null, "number"),
      this.field("cfg", "CFG", values.cfg ?? 1, null, "number"),
      this.field("sampler_name", "采样器名称", values.sampler_name ?? "", options.sampler_name),
      this.field("scheduler", "调度器", values.scheduler ?? "", options.scheduler),
      this.field("denoise", "降噪", values.denoise ?? 1, null, "number"),
      this.field("unet", this.countLabel("UNet 模型", options.unet), values.unet ?? "", options.unet, "text", true),
      this.field("clip", this.countLabel("CLIP 模型", options.clip), values.clip ?? "", options.clip, "text", true),
      this.field("vae", this.countLabel("VAE 模型", options.vae), values.vae ?? "", options.vae, "text", true),
      // 只有图里有负面提示词节点的工作流才出现这一栏（放大类、视频类没有）
      (values._paramKeys || []).includes("negative") ? this.negativeField(values.negative) : "",
      // 只有声明了 custom_size 的工作流（图片编辑类）才显示尺寸开关
      (values._paramKeys || []).includes("custom_size")
        ? this.switchField("custom_size", "自定义尺寸（关=保持参考图尺寸）", values.custom_size)
        : "",
      (values._paramKeys || []).includes("resolution")
        ? this.field("resolution", "参考图分辨率（0 = 按原图）", values.resolution ?? 0, null, "number")
        : "",
      this.loraBlock(values),
    ].join("");
  },

  /* 后端声明了 settings_fields 的工作流：按声明的顺序 / 标签 / 控件类型渲染 */
  genericFields(values, options) {
    return (values._fields || []).map((field) => {
      // 下拉的可选值默认取同名 options（unet / lora_name / sampler_name …）
      const opts = field.type === "select"
        ? ((options || {})[field.options || field.key] || [])
        : null;
      const label = field.hint ? `${field.label}（${field.hint}）` : field.label;
      if (field.type === "bool") {
        return this.switchField(field.key, label, values[field.key]);
      }
      if (field.type === "select") {
        return this.field(field.key, this.countLabel(label, opts),
          values[field.key] ?? "", opts, "text", !!field.full);
      }
      if (field.type === "textarea") {
        return `<label class="wf-field full"><span>${escapeHtml(label)}</span>
          <textarea data-wf-key="${escapeHtml(field.key)}" rows="2" spellcheck="false">${
            escapeHtml(values[field.key] ?? "")}</textarea></label>`;
      }
      // 附加 LoRA 槽位：跟 imageFields 里那块是同一个组件（最多 N 个，留空不加载）
      if (field.type === "lora") {
        return this.loraBlock(values);
      }
      return this.field(field.key, label, values[field.key] ?? "", null,
        field.type || "text", !!field.full);
    }).join("");
  },

  videoFields(values, options) {
    return [
      this.field("seed", "种子（-1 随机）", values.seed ?? -1, null, "number"),
      this.field("fps", "视频帧率", values.fps ?? 24, null, "number"),
      this.switchField("turbo", "加速 LoRA（8 步）", values.turbo),
      this.field("steps_turbo", "加速步数", values.steps_turbo ?? 8, null, "number"),
      this.field("steps_full", "普通步数", values.steps_full ?? 20, null, "number"),
      this.field("multiple", "尺寸对齐步长", values.multiple ?? 32, null, "number"),
      this.field("sampler_name", "采样器", values.sampler_name ?? "", options.sampler_name),
      this.field("scheduler", "调度器", values.scheduler ?? "", options.scheduler),
      this.field("unet", this.countLabel("视频 UNet", options.unet), values.unet ?? "", options.unet, "text", true),
      this.field("clip", this.countLabel("CLIP / 文本编码器", options.clip), values.clip ?? "", options.clip, "text", true),
      this.field("vae", this.countLabel("视频 VAE", options.vae), values.vae ?? "", options.vae, "text", true),
      this.field("audio_vae", this.countLabel("音频 VAE", options.vae), values.audio_vae ?? "", options.vae, "text", true),
      (values._paramKeys || []).includes("negative")
        ? this.negativeField(values.negative)
        : `<p class="wf-note">这个视频工作流图里没有负面提示词节点，负向要求直接写进提示词即可（例如「不要出现文字水印」）。</p>`,
      this.loraBlock(values),
    ].join("");
  },

  renderInto(box, kind) {
    if (!box) return;
    const entries = Object.entries(this.data).filter(([, values]) => (values._kind || "image") === kind);
    if (!entries.length) {
      box.innerHTML = `<div class="wf-empty">暂无${kind === "video" ? "视频" : "图片"}工作流</div>`;
      return;
    }
    box.innerHTML = entries.map(([id, values]) => {
      const options = values._options || {};
      const open = this.openIds.has(id);
      // 只有放大倍数的工作流：设置里不展示种子/cfg/LoRA 等无效字段
      const fields = (values._fields || []).length
        ? this.genericFields(values, options)
        : values._scale
          ? `<p class="wf-note">该工作流只有「放大倍数」（${values._scale.min ?? 1} – ${values._scale.max ?? 10}，步长 ${values._scale.step ?? 0.1}）可调，在创作区拖动滑块即可。</p>`
          : kind === "video"
            ? this.videoFields(values, options)
            : this.imageFields(values, options);
      return `
        <div class="wf-accordion-item ${open ? "open" : ""}" data-id="${escapeHtml(id)}" data-kind="${kind}">
          <button class="wf-accordion-head" type="button">
            <svg class="tiny"><use href="#i-settings"/></svg>
            <span>${escapeHtml(values._name || id)}</span>
            ${values._available === false
              ? `<em class="wf-off-badge" title="${escapeHtml(values._reason || "当前实例缺少节点或模型")}">当前实例不可用</em>`
              : ""}
            <svg class="tiny"><use href="#i-chevron"/></svg>
          </button>
          ${values._available === false
            ? `<p class="wf-note wf-off-note">${escapeHtml(values._reason || "当前实例缺少节点或模型")}。换回本机实例后这里会自动恢复；也可以到「ComfyUI 连接」里换实例。</p>`
            : ""}
          <div class="wf-accordion-body ${open ? "" : "hidden"}">${fields}</div>
        </div>`;
    }).join("");

    $$(".wf-accordion-head", box).forEach((head) => {
      head.addEventListener("click", () => {
        const item = head.closest(".wf-accordion-item");
        const id = item.dataset.id;
        const body = item.querySelector(".wf-accordion-body");
        const willOpen = body.classList.contains("hidden");
        body.classList.toggle("hidden", !willOpen);
        item.classList.toggle("open", willOpen);
        if (willOpen) this.openIds.add(id);
        else this.openIds.delete(id);
      });
    });
    $$("[data-wf-switch]", box).forEach((btn) => {
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-checked") !== "true";
        btn.setAttribute("aria-checked", String(on));
        const input = btn.parentElement.querySelector("[data-wf-key]");
        if (input) input.value = on ? "true" : "false";
      });
    });
  },

  render() {
    this.renderInto($("#workflowAccordion"), "image");
    this.renderInto($("#videoAccordion"), "video");
  },

  values() {
    const result = {};
    $$(".wf-accordion-item").forEach((item) => {
      const id = item.dataset.id;
      // 面板上没有输入框的参数（比如视频工作流的固定加速 LoRA）先带上已保存值，避免保存时被冲掉
      const values = { ...((this.data[id] || {})._saved || {}) };
      $$("[data-wf-key]", item).forEach((input) => {
        values[input.dataset.wfKey] = input.value;
      });
      result[id] = values;
    });
    return result;
  },
};
