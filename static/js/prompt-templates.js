/* 设置 → 提示词模版：四种功能各绑一套模版，模版本身可新建 / 改名 / 改内容 / 删除 */
const PromptTemplates = {
  functions: [
    { key: "polish", label: "提示词润色", desc: "输入框文字 + 模版" },
    { key: "reverse", label: "单图反推", desc: "第一张图片 + 输入框文字 + 模版" },
    { key: "edit", label: "图片编辑润色", desc: "全部图片（按顺序）+ 输入框文字 + 模版" },
    { key: "minimax", label: "minimax-h3提示词润色", desc: "全部图片 / 视频 / 音频（按顺序）+ 输入框文字 + 模版" },
  ],
  data: [],
  bindings: {},
  defaults: [],
  loaded: false,
  saving: false,
  timer: 0,

  init() {
    $("#tplCreate").addEventListener("click", () => this.create());
    $("#tplRestore").addEventListener("click", () => this.restore());
    $("#tplList").addEventListener("input", (event) => {
      const field = event.target.closest("[data-tpl-field]");
      if (!field) return;
      const card = field.closest("[data-tpl-id]");
      const item = this.data.find((tpl) => tpl.id === card.dataset.tplId);
      if (!item) return;
      item[field.dataset.tplField] = field.value;
      if (field.dataset.tplField === "name") {
        const title = card.querySelector(".tpl-title");
        if (title) title.textContent = field.value || "未命名模版";
        this.renderBindings();
      }
      this.schedule();
    });
    $("#tplList").addEventListener("click", (event) => {
      const del = event.target.closest("[data-tpl-del]");
      if (del) this.remove(del.dataset.tplDel);
    });
    $("#tplBindings").addEventListener("change", (event) => {
      const select = event.target.closest("[data-bind]");
      if (!select) return;
      this.bindings[select.dataset.bind] = select.value;
      this.schedule();
    });
  },

  async load(force = false) {
    if (this.loaded && !force) return;
    try {
      const info = await API.promptTemplates();
      this.data = (info.templates || []).map((item) => ({ ...item }));
      this.bindings = { ...(info.bindings || {}) };
      this.defaults = info.defaults || [];
    } catch (error) {
      $("#tplList").innerHTML = `<div class="wf-empty">读取失败：${escapeHtml(error.message)}</div>`;
      return;
    }
    this.loaded = true;
    this.render();
  },

  render() {
    this.renderBindings();
    const box = $("#tplList");
    $("#tplCount").textContent = `· ${this.data.length} 个`;
    if (!this.data.length) {
      box.innerHTML = `<div class="wf-empty">还没有模版，点右上角「新建模版」。</div>`;
      return;
    }
    box.innerHTML = this.data.map((tpl) => `
      <div class="tpl-card" data-tpl-id="${escapeHtml(tpl.id)}">
        <div class="tpl-card-head">
          <span class="tpl-title">${escapeHtml(tpl.name)}</span>
          ${tpl.builtin ? `<span class="tpl-badge">内置</span>` : ""}
          <button class="tpl-del" data-tpl-del="${escapeHtml(tpl.id)}" title="删除模版">${icon("trash")}</button>
        </div>
        <label class="tpl-field">
          <span>名称</span>
          <input data-tpl-field="name" value="${escapeHtml(tpl.name)}" maxlength="40" spellcheck="false">
        </label>
        <label class="tpl-field">
          <span>系统提示词 <em>模型扮演的角色</em></span>
          <textarea data-tpl-field="system" rows="2" spellcheck="false">${escapeHtml(tpl.system)}</textarea>
        </label>
        <label class="tpl-field">
          <span>用户提示词 <em>{prompt} 代表输入框内容</em></span>
          <textarea data-tpl-field="user" rows="3" spellcheck="false">${escapeHtml(tpl.user)}</textarea>
        </label>
      </div>`).join("");
  },

  renderBindings() {
    const box = $("#tplBindings");
    const options = this.data.map((tpl) =>
      `<option value="${escapeHtml(tpl.id)}">${escapeHtml(tpl.name)}</option>`).join("");
    box.innerHTML = this.functions.map((fn) => `
      <label class="tpl-bind">
        <span>${escapeHtml(fn.label)}</span>
        <select data-bind="${fn.key}">${options}</select>
        <em>${escapeHtml(fn.desc)}</em>
      </label>`).join("");
    this.functions.forEach((fn) => {
      const select = box.querySelector(`[data-bind="${fn.key}"]`);
      const wanted = this.bindings[fn.key];
      if (select && this.data.some((tpl) => tpl.id === wanted)) select.value = wanted;
      else if (select) this.bindings[fn.key] = select.value;
    });
  },

  async create() {
    const id = "tpl_" + Date.now().toString(36);
    this.data.push({
      id,
      name: "新模版",
      system: "",
      user: "{prompt}",
      builtin: false,
    });
    this.render();
    this.schedule(0);
    const input = $(`[data-tpl-id="${CSS.escape(id)}"] input[data-tpl-field="name"]`);
    input?.focus();
    input?.select();
  },

  async remove(id) {
    const item = this.data.find((tpl) => tpl.id === id);
    if (!item) return;
    if (!await Dialog.confirm({
      title: "删除模版",
      message: `确定删除「${item.name}」吗？绑定了它功能会自动换成第一个模版。`,
      confirmText: "删除",
    })) return;
    this.data = this.data.filter((tpl) => tpl.id !== id);
    if (!this.data.length) {
      this.data = this.defaults.map((tpl) => ({ ...tpl }));
      toast("模版被删光了，已恢复内置模版");
    }
    for (const fn of this.functions) {
      if (!this.data.some((tpl) => tpl.id === this.bindings[fn.key])) {
        this.bindings[fn.key] = this.data[0].id;
      }
    }
    this.render();
    this.schedule(0);
  },

  async restore() {
    let added = 0;
    this.defaults.forEach((tpl) => {
      if (this.data.some((item) => item.id === tpl.id)) return;
      this.data.push({ ...tpl });
      added += 1;
    });
    if (!added) {
      toast("内置模版都在");
      return;
    }
    this.render();
    this.schedule(0);
    toast(`已恢复 ${added} 个内置模版`);
  },

  schedule(delay = 500) {
    clearTimeout(this.timer);
    $("#tplStatus")?.classList.add("dirty");
    this.timer = setTimeout(() => this.save(), delay);
  },

  async save() {
    if (this.saving) return;
    this.saving = true;
    const status = $("#tplStatus");
    if (status) {
      status.textContent = "保存中…";
      status.classList.remove("dirty");
    }
    try {
      const result = await API.savePromptTemplates(this.data, this.bindings);
      this.data = (result.templates || this.data).map((item) => ({ ...item }));
      this.bindings = { ...(result.bindings || this.bindings) };
      if (status) {
        status.textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5)}`;
        status.classList.remove("dirty");
      }
    } catch (error) {
      if (status) {
        status.textContent = "保存失败";
        status.classList.add("dirty");
      }
      Dialog.warn({ title: "模版保存失败", message: error.message });
    } finally {
      this.saving = false;
    }
  },
};
