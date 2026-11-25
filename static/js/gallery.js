/* 图库：全部可用（ComfyUI 输入+输出）/ 本项目，网格·瀑布流预览，双击看生图信息 */
const Gallery = {
  scope: "all",       // all | project
  kind: "all",        // all | image | video | audio
  mode: (localStorage.getItem("wwdm-gallery-view") === "grid" ? "grid" : "waterfall"),
  query: "",
  libraryCategory: "",   // 资产库页签当前分类（空 = 全部）
  items: [],          // 当前作用域的原始列表
  selected: new Map(),// key -> item
  loading: false,
  returnToGallery: false,
  justResumed: false,

  KIND_LABEL: { image: "图片", video: "视频", audio: "音频", text: "文本" },
  KIND_ICON: { image: "image", video: "video", audio: "mic", text: "text" },

  init() {
    $("#galleryBtn").addEventListener("click", () => this.open());
    $("#galleryClose").addEventListener("click", () => this.close());
    $("#galleryModal").addEventListener("click", (event) => {
      if (event.target.id === "galleryModal") this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || $("#galleryModal").hidden) return;
      // 刚从生图详情返回时，同一次 Esc 不应把图库也关掉
      if (this.justResumed) return;
      this.close();
    });

    $("#galleryScope").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-scope]");
      if (!btn || btn.dataset.scope === this.scope) return;
      this.scope = btn.dataset.scope;
      this.libraryCategory = "";
      $$("#galleryScope button").forEach((node) => node.classList.toggle("active", node === btn));
      this.load();
    });

    $("#galleryKinds").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-kind]");
      if (!btn || btn.dataset.kind === this.kind) return;
      this.kind = btn.dataset.kind;
      $$("#galleryKinds button").forEach((node) => node.classList.toggle("active", node === btn));
      this.render();
    });

    $("#galleryModes").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-mode]");
      if (!btn || btn.dataset.mode === this.mode) return;
      this.mode = btn.dataset.mode;
      localStorage.setItem("wwdm-gallery-view", this.mode);
      this.markModes();
      this.render();
    });

    const search = $("#gallerySearch");
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      $("#gallerySearchClear").hidden = !search.value;
      this.render();
    });
    $("#gallerySearchClear").addEventListener("click", () => {
      search.value = "";
      this.query = "";
      $("#gallerySearchClear").hidden = true;
      this.render();
    });

    // 瀑布流按列宽分发，窗口变化后重排
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      if (this.mode !== "waterfall" || $("#galleryModal").hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.render(), 160);
    });

    $("#galleryGrid").addEventListener("click", (event) => {
      const tile = event.target.closest("[data-key]");
      if (tile) this.toggle(tile.dataset.key);
    });
    $("#galleryGrid").addEventListener("dblclick", async (event) => {
      // 双击名称行 = 重命名；双击其它位置 = 看生图信息
      const nameCell = event.target.closest("[data-tile-name]");
      if (nameCell) {
        event.preventDefault();
        event.stopPropagation();
        const item = this.items.find((entry) => entry.key === nameCell.dataset.tileName);
        if (item?.task && window.Works) {
          const changed = await Works.renameMedia(item.task, item.url);
          if (changed) this.load();
        }
        return;
      }
      const tile = event.target.closest("[data-key]");
      if (tile) this.openInfo(tile.dataset.key);
    });

    $("#gallerySelectAll").addEventListener("click", () => {
      this.filtered().forEach((item) => this.selected.set(item.key, item));
      this.render();
    });
    $("#galleryClearSelection").addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });
    $("#galleryFolders").addEventListener("click", async (event) => {
      const add = event.target.closest("[data-folder-new]");
      if (add) {
        const name = await AssetLib.createCategory();
        if (name) { this.libraryCategory = name; this.load(); }
        return;
      }
      const chip = event.target.closest("[data-folder]");
      if (!chip) return;
      this.libraryCategory = chip.dataset.folder || "";
      this.load();
    });
    $("#galleryFolders").addEventListener("contextmenu", (event) => {
      const chip = event.target.closest("[data-folder]");
      if (!chip || !chip.dataset.folder) return;
      event.preventDefault();
      AssetLib.openFolderMenu(chip.dataset.folder, event.clientX, event.clientY);
    });
    // 所有页签统一右键菜单：资产库移动/复制/删除，其他页签保存到资产库 / 删除作品
    $("#galleryGrid").addEventListener("contextmenu", (event) => {
      const tile = event.target.closest("[data-key]");
      if (!tile) return;
      const item = this.items.find((entry) => entry.key === tile.dataset.key);
      if (!item) return;
      event.preventDefault();
      AssetLib.openItemMenu(item, event.clientX, event.clientY);
    });

    $("#galleryDelete").addEventListener("click", () => this.deleteSelected());
    $("#galleryDownload").addEventListener("click", () => this.downloadSelected());
  },

  /* 作用域切换：向 /api/assets 拉列表，本项目的作品会挂上任务记录以便看生图信息 */
  async load() {
    if (this.loading) return;
    this.loading = true;
    $("#galleryGrid").innerHTML = `<div class="gallery-empty">正在读取素材…</div>`;
    try {
      if (this.scope === "library") {
        const data = await API.libraryAssets(this.libraryCategory);
        this.items = (data.items || []).map((item) => ({ ...item, task: null, index: 0 }));
        AssetLib.cache = data.categories || [];
        this.selected = new Map([...this.selected].filter(([key]) =>
          this.items.some((item) => item.key === key)));
        this.render();
        this.loading = false;
        return;
      }
      const data = await API.assets(this.scope, State.activeId);
      this.items = (data.items || []).map((item) => {
        const task = item.task_id ? State.tasks.find((t) => t.id === item.task_id) : null;
        const index = task ? (task.images || []).indexOf(item.url) : -1;
        const linked = task && index >= 0 ? task : null;
        // 图库名称也用真实名（提示词摘要 / 用户自定义名），不再只显示 1.png
        const title = linked && window.Works?.titleOf ? Works.titleOf(linked, item.url) : item.name;
        return { ...item, name: title || item.name, task: linked, index: Math.max(0, index) };
      });
    } catch (error) {
      this.items = [];
      $("#galleryGrid").innerHTML = `<div class="gallery-empty">读取失败：${escapeHtml(error.message)}</div>`;
      this.loading = false;
      this.updateFooter();
      return;
    } finally {
      this.loading = false;
    }
    const keys = new Set(this.items.map((item) => item.key));
    this.selected = new Map([...this.selected].filter(([key]) => keys.has(key)));
    this.render();
  },

  /* 分类 + 搜索过滤 */
  filtered() {
    const query = this.query;
    return this.items.filter((item) => {
      if (this.kind !== "all" && item.kind !== this.kind) return false;
      if (!query) return true;
      const text = `${item.name} ${item.caption || ""} ${this.sizeText(item)}`.toLowerCase();
      return text.includes(query);
    });
  },

  sizeText(item) {
    const width = item.width || item.task?.width || 0;
    const height = item.height || item.task?.height || 0;
    return width && height ? `${width} × ${height}` : "";
  },

  markModes() {
    $$("#galleryModes button").forEach((node) =>
      node.classList.toggle("active", node.dataset.mode === this.mode));
  },

  open() {
    this.markModes();
    $("#galleryModal").hidden = false;
    this.load();
  },

  close() { $("#galleryModal").hidden = true; },

  toggle(key) {
    if (this.selected.has(key)) this.selected.delete(key);
    else {
      const item = this.filtered().find((entry) => entry.key === key);
      if (item) this.selected.set(key, item);
    }
    // 只切换样式，不重建网格，否则双击会被 DOM 替换打断
    const tile = $(`.gallery-tile[data-key="${CSS.escape(key)}"]`);
    tile?.classList.toggle("selected", this.selected.has(key));
    this.updateFooter();
  },

  updateFooter() {
    const count = this.selected.size;
    const total = this.items.length;
    const shown = this.filtered().length;
    const project = State.activeProject();
    $("#galleryProjectName").textContent = project ? `${project.name} · ` : "";
    $("#galleryStats").textContent = count ? `共 ${total} 项 · 已选 ${count} 项` : `共 ${total} 项`;
    $("#galleryShown").textContent = `显示 ${shown} 项`;
    $("#gallerySelected").textContent = count
      ? `已选择 ${count} 项 · 双击可查看生图信息`
      : "尚未选择素材，单击选择 · 双击查看生图信息";
    // 三种来源都支持删除：资产库删库文件、本项目删作品记录、ComfyUI 目录删文件
    $("#galleryDelete").disabled = count === 0;
    $("#galleryDelete").title = count ? `删除选中的 ${count} 项` : "删除选中素材";
    $("#galleryDownload").disabled = count === 0;
    $("#galleryClearSelection").disabled = count === 0;
    $("#gallerySelectAll").disabled = shown === 0;
  },

  /* 双击：有任务记录走生图信息（视频会在灯箱里播放），否则给一份素材信息 */
  openInfo(key) {
    const item = this.items.find((entry) => entry.key === key);
    if (!item) return;
    if (item.kind === "text") return this.openText(item);
    this.returnToGallery = true;
    this.close();
    if (item.task) Works.preview(item.task.id, item.url);
    else Works.previewAsset(item);
  },

  /* 提示词 txt：读出来直接看，可选中复制 */
  async openText(item) {
    try {
      const text = await fetch(item.url).then((res) => res.text());
      Dialog.text({ title: item.name, message: text });
    } catch (error) {
      toast(`读取失败：${error.message}`, true);
    }
  },

  resume() {
    if (!this.returnToGallery) return;
    this.returnToGallery = false;
    this.open();
    this.justResumed = true;
    setTimeout(() => { this.justResumed = false; }, 0);
  },

  chosen() {
    return [...this.selected.values()];
  },

  downloadSelected() {
    this.chosen().forEach((item) => {
      const link = document.createElement("a");
      link.href = item.url;
      // 有作品记录就用提示词标题，否则退回文件名；两者都补上真实扩展名
      link.download = item.task && window.Works?.downloadName
        ? Works.downloadName(item.task, item.url)
        : (item.name || "asset");
      link.click();
    });
  },

  async deleteSelected() {
    const items = this.chosen();
    if (!items.length) return;
    if (!await Dialog.confirm({
      title: "删除选中素材",
      message: `确定删除选中的 ${items.length} 项吗？\n资产库会删库文件、本项目会连作品记录一起删、其余会删 ComfyUI 目录里的文件。`,
      confirmText: `删除 ${items.length} 项`,
    })) return;
    this.selected.clear();
    const result = await AssetLib.deleteItems(items);
    await this.load();
    window.Main?.refreshAll();   // 图库删掉的作品，卡片区立刻跟着消失
    const failed = result.failed?.length || 0;
    toast(`已删除 ${result.library + result.project + result.comfy} 项${failed ? `，${failed} 项失败` : ""}`);
    if (failed) Dialog.warn({ title: "部分删除失败", message: result.failed.slice(0, 5).join("\n") });
  },

  /* 瀑布流需要的宽高：任务记录的尺寸优先，其次是后端读到的图片尺寸 */
  ratioOf(item) {
    const width = item.width || item.task?.width || 0;
    const height = item.height || item.task?.height || 0;
    if (width && height) return { width, height };
    return item.kind === "video" ? { width: 16, height: 9 } : { width: 1, height: 1 };
  },

  tileHtml(item) {
    const { width, height } = this.ratioOf(item);
    const ratio = this.mode === "waterfall" && item.kind === "image"
      ? ` style="aspect-ratio:${width}/${height}"` : "";
    const source = item.source === "library" ? `资产库 · ${item.category || "未分类"}`
      : item.source === "output" ? "输出目录"
        : item.source === "project" ? "本项目作品"
          : item.source === "input" ? "输入目录" : "";
    const meta2 = this.sizeText(item) || "";
    const meta3 = item.task ? escapeHtml(item.task.prompt || "") : escapeHtml(item.caption || source);
    const preview = item.kind === "image"
      ? `<img src="${item.url}" alt="作品" loading="lazy"${ratio}>`
      : item.kind === "video"
        ? `<video class="tile-video" src="${item.url}#t=0.1" muted playsinline preload="metadata"${ratio}></video>
           <span class="tile-play">${icon("video")}</span>`
        : `<div class="gallery-ph${item.kind === "text" ? " gallery-ph-text" : ""}"${ratio}>${icon(this.KIND_ICON[item.kind] || "image")}<span>${this.KIND_LABEL[item.kind] || "素材"}</span></div>`;
    return `
      <div class="gallery-tile ${this.selected.has(item.key) ? "selected" : ""}" data-key="${escapeHtml(item.key)}" title="单击选择 · 双击查看生图信息">
        ${preview}
        <span class="check">${icon("check")}</span>
        <div class="tile-meta">
          <div class="tile-kind">${this.KIND_LABEL[item.kind] || "素材"}${meta2 ? ` · ${escapeHtml(meta2)}` : ""}</div>
          <div class="tile-res" data-tile-name="${escapeHtml(item.key)}" title="双击可重命名">${escapeHtml(item.name)}</div>
          <div class="tile-prompt">${meta3}</div>
        </div>
      </div>`;
  },

  /* 瀑布流列数：按可用宽度切分，保持 240~320px 的列宽手感 */
  columnCount() {
    const width = $("#galleryGrid").clientWidth || 1000;
    return Math.max(2, Math.min(5, Math.floor(width / 250)));
  },

  /* 按「最短列优先」分发，保证列高均衡且顺序自上而下 */
  renderWaterfall(items) {
    const count = this.columnCount();
    const columns = Array.from({ length: count }, () => ({ weight: 0, html: "" }));
    items.forEach((item) => {
      const { width, height } = this.ratioOf(item);
      const target = columns.reduce((a, b) => (a.weight <= b.weight ? a : b));
      target.weight += height / Math.max(width, 1) + 0.26; // 图片高宽比 + 底部信息条
      target.html += this.tileHtml(item);
    });
    return `<div class="waterfall-cols" style="grid-template-columns:repeat(${count},minmax(0,1fr))">${
      columns.map((column) => `<div class="waterfall-col">${column.html}</div>`).join("")
    }</div>`;
  },

  render() {
    // 资产库页签：顶部显示分类（文件夹）栏
    if (this.scope === "library") {
      AssetLib.folderBar("galleryFolders", this.libraryCategory).catch(() => {});
    } else {
      AssetLib.hideFolderBar("galleryFolders");
    }
    const items = this.filtered();
    const grid = $("#galleryGrid");
    grid.classList.toggle("waterfall", this.mode === "waterfall");

    if (!items.length) {
      const empty = this.items.length
        ? (this.query ? "没有匹配的素材，换个关键词试试。" : `这个分类下还没有${this.KIND_LABEL[this.kind] || "素材"}。`)
        : (this.scope === "project" ? "本项目还没有作品，先去创作框描述一张吧。" : "没有读取到素材。");
      grid.innerHTML = `<div class="gallery-empty">${empty}</div>`;
    } else if (this.mode === "waterfall") {
      grid.innerHTML = this.renderWaterfall(items);
    } else {
      grid.innerHTML = items.map((item) => this.tileHtml(item)).join("");
    }
    this.updateFooter();
  },
};
