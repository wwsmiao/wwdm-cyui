/* 项目菜单、标题重命名与左侧项目管理抽屉 */
const Projects = {
  selected: new Set(),

  async load() {
    const data = await API.listProjects();
    State.projects = data.projects;
    State.activeId = data.active_id;
    this.renderTitle();
    this.renderDrawer();
  },

  renderTitle() {
    const title = $("#projectTitle");
    if (title) title.textContent = State.activeProject()?.name || "Untitled";
  },

  closeMenu() { $("#projectMenu").hidden = true; },

  async handle(action) {
    this.closeMenu();
    try {
      if (action === "new") {
        await API.createProject();
        toast("已新建项目");
      } else if (action === "duplicate") {
        await API.duplicateProject(State.activeId);
        toast("已复制项目及其作品");
      } else if (action === "delete") {
        if (State.projects.length <= 1) {
          return Dialog.warn({ title: "无法删除", message: "至少需要保留一个项目。" });
        }
        if (!await Dialog.confirm({
          title: "删除当前项目",
          message: "确定删除当前项目及其所有作品记录吗？图片文件不会被删除，此操作不可撤销。",
          confirmText: "删除项目",
        })) return;
        await API.deleteProject(State.activeId);
        toast("已删除项目");
      }
      await this.load();
      window.Main?.refreshAll();
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    }
  },

  bind() {
    const menu = $("#projectMenu");
    $("#projectMenuBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".dropdown-wrap")) this.closeMenu();
    });
    menu.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (button) this.handle(button.dataset.action);
    });
    this.bindTitle();
    this.bindDrawer();
  },

  bindTitle() {
    const title = $("#projectTitle");
    if (!title) return;
    title.addEventListener("dblclick", () => this.renameInline(title, {
      afterSave: async () => { await this.load(); window.Main?.refreshAll(); },
    }), { once: true });
  },

  renameInline(node, options = {}) {
    const input = document.createElement("input");
    input.className = "project-title editing";
    input.value = node.textContent;
    node.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      const span = document.createElement("span");
      span.className = "project-title";
      span.id = "projectTitle";
      span.title = "双击重命名";
      span.textContent = name || "Untitled";
      input.replaceWith(span);
      Projects.bindTitle();
      if (!save || !name) return;
      try {
        await API.renameProject(State.activeId, name);
        await options.afterSave?.();
        toast("项目已重命名");
      } catch (error) {
        Dialog.warn({ title: "操作失败", message: error.message });
      }
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
  },

  bindDrawer() {
    $("#projectToggle").addEventListener("click", () => this.toggleDrawer());
    $("#drawerCollapse").addEventListener("click", () => this.closeDrawer());
    $("#drawerBackdrop").addEventListener("click", () => this.closeDrawer());

    $("#projectList").addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      const row = event.target.closest("[data-id]");
      if (!row) return;
      const id = row.dataset.id;
      if (action) {
        event.stopPropagation();
        const kind = action.dataset.action;
        if (kind === "delete") return this.deleteOne(id);
        if (kind === "rename") return this.renameDrawer(row, id);
      }
      if (event.target.closest("input, button")) return;
      // Ctrl / Cmd + 左键：多选项目；普通点击：切换项目
      if (event.ctrlKey || event.metaKey) return this.toggleSelect(id);
      this.activate(id);
    });
    $("#projectCreate").addEventListener("click", async () => {
      try {
        await API.createProject();
        await this.load();
        window.Main?.refreshAll();
        toast("已新建项目");
      } catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
    });
    $("#projectBatchDelete").addEventListener("click", () => this.batchDelete());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("#projectDrawer").classList.contains("open")) this.closeDrawer();
    });
  },

  openDrawer() {
    $("#projectDrawer").classList.add("open");
    $("#projectDrawer").setAttribute("aria-hidden", "false");
    $("#drawerBackdrop").hidden = false;
    this.renderDrawer();
  },

  closeDrawer() {
    $("#projectDrawer").classList.remove("open");
    $("#projectDrawer").setAttribute("aria-hidden", "true");
    $("#drawerBackdrop").hidden = true;
  },

  toggleDrawer() {
    if ($("#projectDrawer").classList.contains("open")) this.closeDrawer();
    else this.openDrawer();
  },

  renderDrawer() {
    const list = $("#projectList");
    if (!list) return;
    const valid = new Set(State.projects.map((p) => p.id));
    this.selected = new Set([...this.selected].filter((id) => valid.has(id)));
    if (!State.projects.length) {
      list.innerHTML = `<div class="drawer-empty">暂无项目</div>`;
    } else {
      list.innerHTML = State.projects.map((project) => `
        <div class="project-row ${project.id === State.activeId ? "active" : ""}${this.selected.has(project.id) ? " selected" : ""}" data-id="${project.id}">
          <span class="row-name" title="单击切换项目 · Ctrl+单击多选">${escapeHtml(project.name)}</span>
          <span class="row-meta">${project.task_count || 0} 张</span>
          <span class="row-actions">
            <button data-action="rename" title="重命名"><svg><use href="#i-edit"/></svg></button>
            <button data-action="delete" class="danger" title="删除"><svg><use href="#i-trash"/></svg></button>
          </span>
        </div>`).join("");
    }
    this.updateBatchButton();
  },

  toggleSelect(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    const row = $(`#projectList .project-row[data-id="${CSS.escape(id)}"]`);
    row?.classList.toggle("selected", this.selected.has(id));
    this.updateBatchButton();
  },

  updateBatchButton() {
    const btn = $("#projectBatchDelete");
    if (btn) btn.disabled = this.selected.size === 0;
  },

  async activate(id) {
    if (id === State.activeId) return this.closeDrawer();
    try {
      await API.activateProject(id);
      await this.load();
      window.Main?.refreshAll();
      this.closeDrawer();
      toast("已切换项目");
    } catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
  },

  renameDrawer(row, id) {
    const nameNode = row.querySelector(".row-name");
    const project = State.projects.find((p) => p.id === id);
    if (!nameNode || !project) return;
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = project.name;
    nameNode.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const span = document.createElement("span");
      span.className = "row-name";
      span.title = "单击切换 · 双击重命名";
      span.textContent = name || project.name;
      input.replaceWith(span);
      if (!save || !name) return;
      try {
        await API.renameProject(id, name);
        await this.load();
        window.Main?.refreshAll();
        toast("项目已重命名");
      } catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
  },

  async deleteOne(id) {
    const project = State.projects.find((p) => p.id === id);
    if (!project) return;
    if (State.projects.length <= 1) {
      return Dialog.warn({ title: "无法删除", message: "至少需要保留一个项目。" });
    }
    if (!await Dialog.confirm({
      title: "删除项目",
      message: `确定删除「${project.name}」及其作品记录吗？图片文件不会被删除。`,
      confirmText: "删除项目",
    })) return;
    try {
      await API.deleteProject(id);
      this.selected.delete(id);
      await this.load();
      window.Main?.refreshAll();
      toast("已删除项目");
    } catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
  },

  async batchDelete() {
    const ids = [...this.selected];
    if (!ids.length) return;
    if (ids.length >= State.projects.length) {
      return Dialog.warn({ title: "无法删除", message: "至少需要保留一个项目，请取消勾选其中一个。" });
    }
    if (!await Dialog.confirm({
      title: "批量删除项目",
      message: `确定删除选中的 ${ids.length} 个项目及其作品记录吗？图片文件不会被删除。`,
      confirmText: `删除 ${ids.length} 个项目`,
    })) return;
    try {
      const result = await API.batchDeleteProjects(ids);
      this.selected.clear();
      await this.load();
      window.Main?.refreshAll();
      toast(`已删除 ${result.deleted} 个项目`);
    } catch (error) { Dialog.warn({ title: "操作失败", message: error.message }); }
  },
};
