/* 设置里的提示词参数：LLM 工作流用于提交前润色提示词 */
const PromptParams = {
  data: {},
  openIds: new Set(),
  loaded: false,

  async load(force = false) {
    if (this.loaded && !force) return;
    const all = State.workflows.length ? State.workflows : await API.listWorkflows();
    const workflows = all.filter((wf) => wf.kind === "llm");
    this.data = {};
    for (const workflow of workflows) {
      try {
        const info = await API.workflowParams(workflow.id);
        this.data[workflow.id] = {
          ...info.defaults, ...info.saved,
          _options: info.options || {},
          _name: workflow.name,
          _available: info.available !== false,
          _reason: info.unavailable_reason || "",
        };
      } catch {
        this.data[workflow.id] = { _options: {}, _name: workflow.name };
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
      // 当前值不在列表里（换了 ComfyUI 实例）：留一条占位，别让浏览器默认选第一项
      const missing = value && !options.some((item) => String(item) === String(value))
        ? `<option value="${safe}" selected>${safe}（当前实例没有，需替换）</option>` : "";
      const opts = options.map((item) =>
        `<option value="${escapeHtml(item)}" ${String(item) === String(value) ? "selected" : ""}>${escapeHtml(item)}</option>`
      ).join("");
      control = `<select data-wf-key="${key}">${missing}${opts}</select>`;
    } else if (type === "textarea") {
      control = `<textarea data-wf-key="${key}" rows="4" spellcheck="false">${safe}</textarea>`;
    } else {
      control = `<input data-wf-key="${key}" type="${type}" value="${safe}" ${type === "number" ? 'step="any"' : ""}>`;
    }
    return `<label class="wf-field ${full ? "full" : ""}"><span>${label}</span>${control}</label>`;
  },

  switchField(key, label, on, hint = "") {
    return `
      <div class="wf-field wf-switch-field">
        <span>${label}${hint ? `<em>${hint}</em>` : ""}</span>
        <button class="switch" type="button" role="switch" data-wf-switch="${key}" aria-checked="${on ? "true" : "false"}"><span></span></button>
      </div>`;
  },

  textFields(values, options) {
    const thinking = ["true", "1", "on", "yes", "开", "开启"].includes(
      String(values.thinking ?? "false").toLowerCase()
    );
    return [
      this.field("temperature", "温度", values.temperature ?? 0.7, null, "number"),
      this.field("max_length", "最大长度", values.max_length ?? 512, null, "number"),
      this.field("seed", "种子（-1 随机）", values.seed ?? -1, null, "number"),
      this.switchField("thinking", "思考模式", thinking, "开启后先推理再回答"),
      this.field("top_p", "Top P", values.top_p ?? 0.95, null, "number"),
      this.field("top_k", "Top K", values.top_k ?? 64, null, "number"),
      this.field("repetition_penalty", "重复惩罚", values.repetition_penalty ?? 1.05, null, "number"),
      this.field("system_prompt", "系统提示词", values.system_prompt ?? "", null, "textarea", true),
      this.field("user_prompt", "用户提示词", values.user_prompt ?? "", null, "textarea", true),
      this.field("clip", (options.clip || []).length ? `CLIP 模型（可选 ${options.clip.length} 个）` : "CLIP 模型",
        values.clip ?? "", options.clip, "text", true),
    ].join("");
  },

  /* DeepSeek 官方 API：配的是 Key / 地址 / 模型，不是 ComfyUI 图参数 */
  deepseekFields(values) {
    return [
      `<label class="wf-field full"><span>API Key <em>在 platform.deepseek.com 创建</em></span>
        <input data-wf-key="api_key" type="password" value="${escapeHtml(values.api_key ?? "")}"
               placeholder="sk-..." spellcheck="false" autocomplete="off"></label>`,
      this.field("base_url", "接口地址", values.base_url ?? "https://api.deepseek.com", null, "text", true),
      `<label class="wf-field full"><span>模型 <em>带图片请选 deepseek-flash（vision） · 点「获取模型列表」拉取</em></span>
        <div class="ds-model-row">
          <input data-wf-key="model" value="${escapeHtml(values.model ?? "deepseek-chat")}" spellcheck="false">
          <button type="button" class="soft-btn" data-ds-models>获取模型列表</button>
        </div></label>`,
    ].join("");
  },

  render() {
    const box = $("#promptAccordion");
    if (!box) return;
    const entries = Object.entries(this.data);
    if (!entries.length) {
      box.innerHTML = `<div class="wf-empty">还没有接入提示词工作流，把 LLM 工作流放进 workflows/ 并在 manifest 里标记 kind 为 llm。</div>`;
      return;
    }
    box.innerHTML = entries.map(([id, values]) => {
      const options = values._options || {};
      const open = this.openIds.has(id);
      // DeepSeek 官方 API：没有 ComfyUI 图，配置的是 Key / 地址 / 模型
      const fields = id === "deepseek-api"
        ? this.deepseekFields(values)
        : this.textFields(values, options);
      return `
        <div class="wf-accordion-item ${open ? "open" : ""}" data-id="${escapeHtml(id)}">
          <button class="wf-accordion-head" type="button">
            <svg class="tiny"><use href="#i-sparkle"/></svg>
            <span>${escapeHtml(values._name || id)}</span>
            ${values._available === false
              ? `<em class="wf-off-badge" title="${escapeHtml(values._reason || "当前实例缺少节点或模型")}">当前实例不可用</em>`
              : ""}
            <svg class="tiny"><use href="#i-chevron"/></svg>
          </button>
          ${values._available === false
            ? `<p class="wf-note wf-off-note">${escapeHtml(values._reason || "当前实例缺少节点或模型")}</p>`
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
        btn.setAttribute("aria-checked",
          btn.getAttribute("aria-checked") === "true" ? "false" : "true");
      });
    });

    // DeepSeek：拉取官方模型列表，把模型输入框换成下拉
    $$("[data-ds-models]", box).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest(".wf-accordion-item");
        const body = {};
        $$("[data-wf-key]", item).forEach((el) => { body[el.dataset.wfKey] = el.value; });
        btn.disabled = true;
        btn.textContent = "获取中…";
        try {
          const result = await API.deepseekModels(body);
          const models = result.models || [];
          if (!models.length) {
            toast("接口没有返回模型");
            return;
          }
          const input = item.querySelector('input[data-wf-key="model"]');
          const select = document.createElement("select");
          select.dataset.wfKey = "model";
          select.innerHTML = models.map((m) =>
            `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
          if (models.includes(input.value)) select.value = input.value;
          input.replaceWith(select);
          toast(`已获取 ${models.length} 个模型，下拉选择即可`);
        } catch (error) {
          Dialog.warn({ title: "获取模型失败", message: error.message });
        } finally {
          btn.disabled = false;
          btn.textContent = "获取模型列表";
        }
      });
    });
  },

  values() {
    const result = {};
    $$("#promptAccordion .wf-accordion-item").forEach((item) => {
      const values = {};
      $$("[data-wf-key]", item).forEach((input) => {
        values[input.dataset.wfKey] = input.value;
      });
      $$("[data-wf-switch]", item).forEach((btn) => {
        values[btn.dataset.wfSwitch] = btn.getAttribute("aria-checked") === "true" ? "true" : "false";
      });
      result[item.dataset.id] = values;
    });
    return result;
  },
};
