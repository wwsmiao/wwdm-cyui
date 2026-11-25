/* 文本模式：富文本笔记编辑器，按项目保存 */
const Notes = {
  _for: "",      // 编辑器里装的是哪个项目的笔记
  _dirty: false,

  init() {
    const editor = $("#notesEditor");

    // 回车生成 <p> 而不是 <div>，保存出来的结构更干净
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* 忽略 */ }

    $("#notesSave").addEventListener("click", () => this.save());
    $("#notesClear").addEventListener("click", () => this.clear());
    $("#notesCopy").addEventListener("click", () => this.copyAll());
    $("#notesBlock").addEventListener("change", (event) => {
      this.exec("formatBlock", `<${event.target.value}>`);
    });

    $("#notesToolbar").addEventListener("mousedown", (event) => {
      // 阻止默认行为，否则按钮按下时编辑器会丢焦点、选区消失
      if (event.target.closest("button")) event.preventDefault();
    });
    $("#notesToolbar").addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-cmd]");
      if (!btn) return;
      editor.focus();
      this.exec(btn.dataset.cmd, btn.dataset.value);
    });

    editor.addEventListener("input", () => {
      this._dirty = true;
      this.updateMeta();
    });
    editor.addEventListener("keyup", () => this.syncToolbarState());
    editor.addEventListener("mouseup", () => this.syncToolbarState());
    editor.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        this.save();
      }
    });
    // 外部粘贴一律转纯文本，避免把网页样式和脚本带进笔记
    editor.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text == null) return;
      event.preventDefault();
      document.execCommand("insertText", false, text);
    });
  },

  exec(command, value) {
    try {
      document.execCommand(command, false, value);
    } catch { /* 浏览器不支持的命令直接忽略 */ }
    this._dirty = true;
    this.updateMeta();
    this.syncToolbarState();
  },

  /* 光标所在位置的格式状态回显到工具栏 */
  syncToolbarState() {
    $$("#notesToolbar button[data-cmd]").forEach((btn) => {
      const cmd = btn.dataset.cmd;
      if (["undo", "redo", "removeFormat", "formatBlock"].includes(cmd)) return;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { on = false; }
      btn.classList.toggle("active", on);
    });
    // queryCommandValue 可能返回 "h1" 或 "<h1>"，统一去掉尖括号再回显
    const block = String(document.queryCommandValue("formatBlock") || "p")
      .toLowerCase().replace(/[<>]/g, "");
    const select = $("#notesBlock");
    if ([...select.options].some((opt) => opt.value === block)) select.value = block;
  },

  activeId() {
    return State.activeId || State.activeProject()?.id || "";
  },

  /* 旧数据是纯文本，转成段落；已经是 HTML 的原样用 */
  toHtml(raw) {
    const text = String(raw || "");
    if (!text.trim()) return "";
    if (/<(p|div|br|h[1-6]|ul|ol|li|blockquote|b|strong|i|em|u|s|span)\b/i.test(text)) return text;
    return text.split(/\n{2,}/).map((block) =>
      `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join("");
  },

  load(force = false) {
    const project = State.activeProject();
    const id = this.activeId();
    if (!force && this._for === id) return;
    const editor = $("#notesEditor");
    editor.innerHTML = this.toHtml(project?.notes || "");
    $("#notesProject").textContent = project?.name || "";
    this._for = id;
    this._dirty = false;
    this.updateMeta();
  },

  /* 项目切换后由 Main.refreshAll 调用；正在写的时候先把旧草稿存回原项目 */
  refresh() {
    const id = this.activeId();
    if (this._for === id) return;
    if (this._dirty && this._for) {
      const html = $("#notesEditor").innerHTML;
      API.saveNotes(this._for, html)
        .then(() => {
          const project = State.projects.find((item) => item.id === this._for);
          if (project) project.notes = html;
        })
        .catch(() => {})
        .finally(() => {
          this._dirty = false;
          this.load(true);
        });
      return;
    }
    this.load(true);
  },

  updateMeta() {
    const editor = $("#notesEditor");
    const text = editor.innerText || "";
    editor.classList.toggle("is-empty", !text.trim());
    const chars = text.replace(/\s/g, "").length;
    const lines = text.trim() ? text.trim().split("\n").length : 0;
    $("#notesCount").textContent = text.trim() ? `${chars} 字 · ${lines} 行` : "0 字";
    const status = $("#notesStatus");
    status.classList.toggle("dirty", this._dirty);
    status.classList.toggle("saved", !this._dirty);
    status.textContent = this._dirty ? "未保存" : "已保存";
  },

  async save() {
    // 存回内容所属的项目：切项目时有草稿也不会写错地方
    const id = this._for || this.activeId();
    if (!id) return;
    const btn = $("#notesSave");
    const html = $("#notesEditor").innerHTML;
    btn.disabled = true;
    try {
      await API.saveNotes(id, html);
      const project = State.projects.find((item) => item.id === id) || State.activeProject();
      if (project) project.notes = html;
      this._dirty = false;
      this._for = id;
      this.updateMeta();
      const status = $("#notesStatus");
      status.textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5)}`;
      status.classList.add("saved");
    } catch (error) {
      Dialog.warn({ title: "保存失败", message: error.message });
    } finally {
      btn.disabled = false;
    }
  },

  async clear() {
    if (!await Dialog.confirm({
      title: "清空笔记",
      message: "当前项目的笔记会被清空，且无法撤销。确定继续吗？",
      confirmText: "清空",
    })) return;
    $("#notesEditor").innerHTML = "";
    this._dirty = true;
    this.updateMeta();
    await this.save();
    toast("笔记已清空");
  },

  async copyAll() {
    const text = ($("#notesEditor").innerText || "").trim();
    if (!text) {
      return Dialog.warn({ title: "没有内容", message: "编辑器里还没有可以复制的文字。" });
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制全文");
    } catch {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
      toast("已复制全文");
    }
  },
};
