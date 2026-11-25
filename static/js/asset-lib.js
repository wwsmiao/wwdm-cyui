/* 资产库：data/Asset Library 下的分类（文件夹）+ 资产文件
   - 右键「添加到资产库」：选分类保存
   - 素材弹窗 / 图库：所有页签统一右键菜单
       资产库：移动 / 复制 / 删除 / 预览 / 复制文件名
       全部可用：保存到资产库 / 预览 / 复制文件名
       本项目：保存到资产库 / 删除作品 / 预览 / 复制文件名
     分类（文件夹）：重命名 / 复制分类 / 删除分类 */
const AssetLib = {
  cache: [],           // [{name, count, cover, cover_url}]
  _payload: null,      // 待保存的资产 {source, name}
  _menu: null,         // 右键目标 {type: "folder"|"item", ...}
  _pos: { x: 0, y: 0 },

  init() {
    $("#libSaveClose").addEventListener("click", () => this.closeSave());
    $("#libSaveLayer").addEventListener("click", (event) => {
      if (event.target.id === "libSaveLayer") this.closeSave();
    });
    $("#libSaveList").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cat]");
      if (btn) this.commit(btn.dataset.cat);
    });
    $("#libSaveCreate").addEventListener("click", () => {
      this.createAndCommit($("#libSaveNewName").value);
    });
    $("#libSaveNewName").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.createAndCommit(event.target.value);
      }
    });

    $("#libMenu").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-lib]");
      if (!btn) return;
      const action = btn.dataset.lib;
      this.closeMenu();
      this.runMenu(action, btn.dataset.value || "");
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#libMenu")) this.closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeMenu();
    });
    window.addEventListener("resize", () => this.closeMenu());
  },

  async categories(force = false) {
    if (!force && this.cache.length) return this.cache;
    try {
      const data = await API.libraryAssets();
      this.cache = data.categories || [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  },

  // ---------- 添加到资产库 ----------
  async openSave(source, name, label = "") {
    const target = String(name || "");
    if (source === "project" && !/^\/(static\/outputs|api\/output)\//.test(target)) {
      return toast("这个内容没有对应的素材文件，无法保存", true);
    }
    this._payload = { source, name, title: label || "" };
    const url = source === "project" ? name : API.comfyFileUrl(source, name);
    const base = (name.split("/").pop() || name);
    const isVideo = /\.(mp4|webm|mov|mkv|avi)$/i.test(base);
    const isAudio = /\.(mp3|wav|flac|ogg|m4a)$/i.test(base);
    const thumb = source === "library" ? ""
      : isVideo ? `<video src="${escapeHtml(url)}" muted playsinline preload="metadata"></video>`
        : isAudio ? `<span class="lib-save-ph">${icon("mic")}</span>`
          : `<img src="${escapeHtml(url)}" alt="">`;
    $("#libSavePreview").innerHTML = `${thumb}<span>${escapeHtml(label || base)}</span>`;
    const cats = await this.categories(true);
    this.renderSaveList(cats);
    $("#libSaveNewName").value = "";
    $("#libSaveLayer").hidden = false;
  },

  renderSaveList(cats) {
    const box = $("#libSaveList");
    if (!cats.length) {
      box.innerHTML = `<div class="lib-empty">还没有分类，先在下面新建一个。</div>`;
      return;
    }
    box.innerHTML = cats.map((cat) => `
      <button class="lib-cat" data-cat="${escapeHtml(cat.name)}">
        ${icon("folder")}<span class="lib-cat-name">${escapeHtml(cat.name)}</span>
        <span class="lib-cat-count">${cat.count}</span>
      </button>`).join("");
  },

  closeSave() {
    $("#libSaveLayer").hidden = true;
    this._payload = null;
  },

  async commit(category) {
    const payload = this._payload;
    if (!payload) return;
    try {
      await API.libraryAdd({ ...payload, category });
      toast(`已保存到资产库「${category || "未分类"}」`);
      this.closeSave();
      await this.categories(true);
      this.refreshViews();
    } catch (error) {
      Dialog.warn({ title: "保存失败", message: error.message });
    }
  },

  async createAndCommit(raw) {
    const name = (raw || "").trim();
    if (!name) return toast("先写一个分类名称", true);
    try {
      await API.libraryCreateCategory(name);
      await this.categories(true);
      await this.commit(name);
      $("#libSaveNewName").value = "";
    } catch (error) {
      Dialog.warn({ title: "新建分类失败", message: error.message });
    }
  },

  // ---------- 分类栏 ----------
  async folderBar(containerId, active) {
    const el = $(`#${containerId}`);
    if (!el) return;
    const cats = await this.categories(true);
    const total = cats.reduce((sum, cat) => sum + (cat.count || 0), 0);
    el.innerHTML = `
      <button class="lib-folder ${active ? "" : "active"}" data-folder="">${icon("grid")}全部<span class="lib-count">${total}</span></button>
      ${cats.map((cat) => `
        <button class="lib-folder ${active === cat.name ? "active" : ""}" data-folder="${escapeHtml(cat.name)}">
          ${icon("folder")}<span class="lib-folder-name">${escapeHtml(cat.name)}</span>
          <span class="lib-count">${cat.count}</span>
        </button>`).join("")}
      <button class="lib-folder lib-folder-new" data-folder-new>${icon("plus")}新建分类</button>`;
    el.hidden = false;
  },

  hideFolderBar(containerId) {
    const el = $(`#${containerId}`);
    if (el) el.hidden = true;
  },

  async createCategory() {
    const name = await Dialog.prompt({
      title: "新建资产库分类", label: "分类名就是文件夹名",
      placeholder: "例如：角色素材", confirmText: "新建",
    });
    if (name === null) return "";
    if (!name) return toast("分类名不能为空", true);
    try {
      await API.libraryCreateCategory(name);
      await this.categories(true);
      toast(`已新建分类「${name}」`);
      this.refreshViews();
      return name;
    } catch (error) {
      Dialog.warn({ title: "新建失败", message: error.message });
      return "";
    }
  },

  // ---------- 右键菜单 ----------
  openFolderMenu(name, x, y) {
    this._menu = { type: "folder", name };
    const menu = $("#libMenu");
    menu.innerHTML = `
      <div class="menu-title">分类「${escapeHtml(name)}」</div>
      <button data-lib="rename">${icon("edit")}重命名</button>
      <button data-lib="copy-folder">${icon("copy")}复制分类</button>
      <div class="menu-sep"></div>
      <button data-lib="remove-folder" class="danger">${icon("trash")}删除分类（含里面的资产）</button>`;
    this.showMenu(menu, x, y);
  },

  /* 三种来源统一右键菜单 */
  openItemMenu(item, x, y) {
    this._menu = { type: "item", item };
    const menu = $("#libMenu");
    const isLib = item.source === "library";
    let html = `<div class="menu-title">${escapeHtml(item.name)}</div>
      <button data-lib="preview">${icon("expand")}预览</button>
      <button data-lib="copy-name">${icon("copy")}复制文件名</button>`;
    if (isLib) {
      html += `
      <div class="menu-sep"></div>
      <button data-lib="rename-item">${icon("edit")}重命名</button>
      <button data-lib="stage-move">${icon("folder")}移动到分类…</button>
      <button data-lib="stage-copy">${icon("copy")}复制到分类…</button>
      <div class="menu-sep"></div>
      <button data-lib="remove-item" class="danger">${icon("trash")}从资产库删除</button>`;
    } else {
      html += `<div class="menu-sep"></div>
      <button data-lib="save">${icon("folder")}保存到资产库…</button>`;
      if (item.source === "project") {
        html += `<button data-lib="remove-task" class="danger">${icon("trash")}删除作品</button>`;
      } else {
        html += `<button data-lib="remove-file" class="danger">${icon("trash")}删除文件</button>`;
      }
    }
    menu.innerHTML = html;
    this.showMenu(menu, x, y);
  },

  /* 移动 / 复制到分类：第二步选目标分类 */
  showTargets(action) {
    const target = this._menu;
    if (!target?.item) return;
    const menu = $("#libMenu");
    const current = target.item.category || "";
    const cats = this.cache.filter((cat) => cat.name !== current);
    menu.innerHTML = `
      <div class="menu-title">${action === "move" ? "移动到分类" : "复制到分类"}</div>
      ${cats.length ? cats.map((cat) => `
        <button data-lib="${action}" data-value="${escapeHtml(cat.name)}">
          ${icon("folder")}${escapeHtml(cat.name)}<span class="menu-count">${cat.count}</span>
        </button>`).join("") : `<div class="menu-title">还没有其他分类</div>`}
      <div class="menu-sep"></div>
      <button data-lib="${action}-new">${icon("plus")}新建分类并${action === "move" ? "移入" : "复制"}</button>
      <button data-lib="back">${icon("close")}返回</button>`;
    this.showMenu(menu, this._pos.x, this._pos.y);
  },

  showMenu(menu, x, y) {
    this._pos = { x, y };
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  },

  closeMenu() {
    const menu = $("#libMenu");
    if (menu) menu.hidden = true;
  },

  async runMenu(action, value) {
    const target = this._menu;
    if (!target) return;

    if (action === "back") {
      if (target.type === "item") this.openItemMenu(target.item, this._pos.x, this._pos.y);
      else this.openFolderMenu(target.name, this._pos.x, this._pos.y);
      return;
    }

    // ---- 资产类动作 ----
    if (target.type === "item") {
      const item = target.item;
      if (action === "preview") return this.preview(item);
      if (action === "copy-name") return this.copyText(item.name);
      if (action === "save") {
        const saveName = item.source === "project" ? (item.url || item.name) : item.name;
        return void this.openSave(item.source, saveName, item.name);
      }
      if (action === "rename-item") {
        const name = await Dialog.prompt({
          title: "重命名资产", label: "不改扩展名时自动沿用原格式",
          value: item.name, confirmText: "保存",
        });
        if (!name || name === item.name) return;
        try {
          await API.libraryRenameItem({ category: item.category, name: item.name, to: name });
          toast("已重命名");
          await this.categories(true);
          this.refreshViews();
        } catch (error) {
          Dialog.warn({ title: "重命名失败", message: error.message });
        }
        return;
      }
      if (action === "stage-move") return this.showTargets("move");
      if (action === "stage-copy") return this.showTargets("copy");
      if (action === "move" || action === "move-new") {
        let to = value;
        if (action === "move-new") {
          to = await this.createCategory();
          if (!to) return;
        }
        try {
          await API.libraryMove({ category: item.category, name: item.name, to });
          toast(`已移动到「${to}」`);
          await this.categories(true);
          this.refreshViews();
        } catch (error) {
          Dialog.warn({ title: "移动失败", message: error.message });
        }
        return;
      }
      if (action === "copy" || action === "copy-new") {
        let to = value;
        if (action === "copy-new") {
          to = await this.createCategory();
          if (!to) return;
        }
        try {
          await API.libraryCopyItem({ category: item.category, name: item.name, to });
          toast(`已复制到「${to}」`);
          await this.categories(true);
          this.refreshViews();
        } catch (error) {
          Dialog.warn({ title: "复制失败", message: error.message });
        }
        return;
      }
      if (action === "remove-item") {
        const ok = await Dialog.confirm({ title: "删除资产", message: `从资产库删除「${item.name}」？` });
        if (!ok) return;
        try {
          await API.libraryRemove({ category: item.category, name: item.name });
          toast("已从资产库删除");
          await this.categories(true);
          this.refreshViews();
        } catch (error) {
          Dialog.warn({ title: "删除失败", message: error.message });
        }
        return;
      }
      if (action === "remove-task") return this.deleteProjectItem(item);
      if (action === "remove-file") {
        const ok = await Dialog.confirm({
          title: "删除文件",
          message: `从 ComfyUI 的${item.source === "output" ? "输出" : "输入"}目录删除「${item.name}」？`,
        });
        if (!ok) return;
        try {
          await API.comfyDelete(item.source, item.name);
          toast("已删除文件");
          this.refreshViews();
        } catch (error) {
          Dialog.warn({ title: "删除失败", message: error.message });
        }
        return;
      }
      return;
    }

    // ---- 分类（文件夹）动作 ----
    if (action === "rename") {
      const name = await Dialog.prompt({
        title: "重命名分类", label: "分类名就是文件夹名", value: target.name, confirmText: "保存",
      });
      if (!name || name === target.name) return;
      try {
        await API.libraryRenameCategory(target.name, name);
        await this.categories(true);
        toast("分类已重命名");
        this.refreshViews();
      } catch (error) {
        Dialog.warn({ title: "重命名失败", message: error.message });
      }
      return;
    }
    if (action === "copy-folder") {
      const name = await Dialog.prompt({
        title: "复制分类", label: "新分类名（会连里面的资产一起复制）",
        value: `${target.name} 副本`, confirmText: "复制",
      });
      if (!name) return;
      try {
        await API.libraryCopyCategory({ name: target.name, to: name });
        await this.categories(true);
        toast(`已复制为「${name}」`);
        this.refreshViews();
      } catch (error) {
        Dialog.warn({ title: "复制失败", message: error.message });
      }
      return;
    }
    if (action === "remove-folder") {
      const ok = await Dialog.confirm({
        title: "删除分类", message: `「${target.name}」及里面的资产都会被删除，确定吗？`,
      });
      if (!ok) return;
      try {
        await API.libraryDeleteCategory(target.name);
        await this.categories(true);
        toast("分类已删除");
        this.refreshViews();
      } catch (error) {
        Dialog.warn({ title: "删除失败", message: error.message });
      }
    }
  },

  /* 批量删除：资产库走库删除，项目作品走图片删除，ComfyUI 目录走文件删除 */
  async deleteItems(items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return { library: 0, project: 0, comfy: 0 };
    const stat = { library: 0, project: 0, comfy: 0 };
    const failed = [];
    const libItems = list.filter((item) => item.source === "library");
    // 本项目作品：有任务记录的删记录+文件，没有记录的（卡片已移除）直接删文件
    const projItems = list.filter((item) => item.source === "project");
    const comfyItems = list.filter((item) => !item.task && (item.source === "input" || item.source === "output"));

    for (const item of libItems) {
      try {
        await API.libraryRemove({ category: item.category, name: item.name });
        stat.library += 1;
      } catch (error) { failed.push(`${item.name}: ${error.message}`); }
    }
    if (projItems.length) {
      try {
        const payload = projItems.map((item) => {
          const task = item.task || (State.tasks || []).find((t) => t.id === item.task_id);
          const index = Number.isInteger(item.index) && item.index >= 0
            ? item.index
            : (task ? (task.images || []).indexOf(item.url) : -1);
          return { task_id: task?.id || item.task_id || "", index, url: item.url };
        }).filter((row) => row.url);
        if (payload.length) {
          const result = await API.deleteImages(payload);
          stat.project = result.deleted || payload.length;
        }
      } catch (error) { failed.push(error.message); }
    }
    for (const item of comfyItems) {
      try {
        await API.comfyDelete(item.source, item.name);
        stat.comfy += 1;
      } catch (error) { failed.push(`${item.name}: ${error.message}`); }
    }

    await this.categories(true).catch(() => {});
    if (projItems.length) {
      // 画布上引用这些作品的节点同步清掉（结果删空的节点一并移除）
      try {
        window.Canvas?.dropResults?.(projItems.map((item) => item.url).filter(Boolean));
      } catch { /* 画布未初始化时忽略 */ }
      State.tasks = await API.tasks(State.activeId);
      await Projects.load();
      window.Main?.refreshAll();
    }
    this.refreshViews();
    return { ...stat, failed };
  },

  preview(item) {
    if (item.task) return Works.preview(item.task.id, item.url);
    Works.previewAsset({ url: item.url, name: item.name, kind: item.kind, source: item.source });
  },

  copyText(text) {
    const helper = document.createElement("textarea");
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    toast("已复制文件名");
  },

  /* 删除本项目作品：project 素材有 task_id，按图序号删 */
  async deleteProjectItem(item) {
    const task = item.task || (State.tasks || []).find((t) => t.id === item.task_id);
    const index = Number.isInteger(item.index) && item.index >= 0
      ? item.index
      : (task ? (task.images || []).indexOf(item.url) : -1);
    if (!task || index < 0) return toast("找不到这张作品记录", true);
    const ok = await Dialog.confirm({
      title: "删除作品", message: "这张图片会从作品记录和本地文件一起删除，确定吗？",
    });
    if (!ok) return;
    try {
      await API.deleteImages([{ task_id: task.id, index }]);
      State.tasks = await API.tasks(State.activeId);
      await Projects.load();
      window.Main?.refreshAll();
      this.refreshViews();
      toast("已删除作品");
    } catch (error) {
      Dialog.warn({ title: "删除失败", message: error.message });
    }
  },

  // ---------- 刷新打开中的弹窗 ----------
  refreshViews() {
    // Picker / Gallery 是 const 声明的模块，不挂在 window 上，直接用全局名字判断
    if (typeof Picker !== "undefined" && !$("#pickerModal").hidden) {
      Picker.load().catch(() => {});
    }
    if (typeof Gallery !== "undefined" && !$("#galleryModal").hidden) {
      Gallery.load().catch(() => {});
    }
  },
};

window.AssetLib = AssetLib;
