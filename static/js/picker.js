/* 资源选择弹窗：全部可用（ComfyUI 输入+输出）/ 本项目，按视频·图片·音频分类 + 搜索 */
const Picker = {
  scope: "all",       // all | project
  kind: "all",        // all | image | video | audio
  query: "",
  view: (localStorage.getItem("wwdm-picker-view") === "grid" ? "grid" : "waterfall"),
  libraryCategory: "",   // 资产库页签当前分类（空 = 全部）
  items: [],          // 当前作用域的全部素材
  shown: [],          // 过滤后的素材
  selected: new Map(),// key -> item（跨作用域保留已选）
  loading: false,
  onConfirm: null,

  KIND_LABEL: { image: "图片", video: "视频", audio: "音频" },
  KIND_ICON: { image: "image", video: "video", audio: "mic" },

  init() {
    $("#pickerClose").addEventListener("click", () => this.close());
    $("#pickerCancel").addEventListener("click", () => this.close());
    $("#pickerModal").addEventListener("click", (event) => {
      if (event.target.id === "pickerModal") this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || $("#pickerModal").hidden) return;
      event.stopImmediatePropagation();
      this.close();
    });

    $("#pickerFolders").addEventListener("click", async (event) => {
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
    $("#pickerFolders").addEventListener("contextmenu", (event) => {
      const chip = event.target.closest("[data-folder]");
      if (!chip || !chip.dataset.folder) return;
      event.preventDefault();
      AssetLib.openFolderMenu(chip.dataset.folder, event.clientX, event.clientY);
    });
    // 所有页签统一右键菜单：资产库移动/复制/删除，其他页签保存到资产库
    $("#pickerGrid").addEventListener("contextmenu", (event) => {
      const tile = event.target.closest("[data-key]");
      if (!tile) return;
      const item = this.shown.find((entry) => this.keyOf(entry) === tile.dataset.key);
      if (!item) return;
      event.preventDefault();
      AssetLib.openItemMenu(item, event.clientX, event.clientY);
    });

    $("#pickerScope").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-scope]");
      if (!btn || btn.dataset.scope === this.scope) return;
      this.scope = btn.dataset.scope;
      this.libraryCategory = "";
      this.markScope();
      this.load();
    });

    $("#pickerViews").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-view]");
      if (!btn || btn.dataset.view === this.view) return;
      this.view = btn.dataset.view;
      localStorage.setItem("wwdm-picker-view", this.view);
      this.markViews();
      this.render();
    });

    $("#pickerKinds").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-kind]");
      if (!btn || btn.dataset.kind === this.kind) return;
      this.kind = btn.dataset.kind;
      this.markKinds();
      this.render();
    });

    const search = $("#pickerSearch");
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      $("#pickerSearchClear").hidden = !search.value;
      this.render();
    });
    $("#pickerSearchClear").addEventListener("click", () => {
      search.value = "";
      this.query = "";
      $("#pickerSearchClear").hidden = true;
      this.render();
    });

    $("#pickerGrid").addEventListener("click", (event) => {
      const tile = event.target.closest("[data-key]");
      if (!tile) return;
      this.toggle(tile.dataset.key);
    });
    $("#pickerGrid").addEventListener("dblclick", (event) => {
      const tile = event.target.closest("[data-key]");
      if (!tile) return;
      const item = this.shown.find((entry) => this.keyOf(entry) === tile.dataset.key);
      if (!item) return;
      Works.previewAsset({ url: item.url, name: item.name, kind: item.kind, source: item.source });
    });

    $("#pickerSelectAll").addEventListener("click", () => {
      this.shown.forEach((item) => {
        if (this.selectable(item)) this.selected.set(item.key, item);
      });
      this.render();
    });
    $("#pickerClear").addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });
    $("#pickerDelete").addEventListener("click", () => this.deleteSelected());
    $("#pickerChosen").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-drop]");
      if (!btn) return;
      this.selected.delete(btn.dataset.drop);
      this.render();
    });
    $("#pickerUpload").addEventListener("click", () => {
      $("#refFileInput").dataset.from = "picker";
      $("#refFileInput").click();
    });
    $("#pickerConfirm").addEventListener("click", () => this.confirm());
  },

  /* 把两个作用域合并成唯一 key：project 素材的 key 自带 project: 前缀 */
  keyOf(item) {
    return item.key || `${item.source}:${item.name}`;
  },

  /* 参考图默认只接受图片；提示词模式下允许选视频 / 音频 */
  selectable(item) {
    if (item.kind === "text") return false;   // 提示词 txt 不能当素材喂给工作流
    return this.allowMedia ? true : item.kind === "image";
  },

  async open(onConfirm, options = {}) {
    this.onConfirm = onConfirm || null;
    this.allowMedia = !!options.allowMedia;
    this.selected.clear();
    this.query = "";
    this.kind = options.kind || "all";
    if (options.scope) this.scope = options.scope;
    $("#pickerSearch").value = "";
    $("#pickerSearchClear").hidden = true;
    this.markKinds();
    this.markScope();
    this.markViews();
    $("#pickerModal").hidden = false;
    await this.load();
  },

  close() {
    $("#pickerModal").hidden = true;
    this.selected.clear();
  },

  markScope() {
    $$("#pickerScope button").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.scope === this.scope));
  },

  markViews() {
    $$("#pickerViews button").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.view === this.view));
  },

  /* 分辨率文案：宽 × 高 */
  resText(item) {
    const width = Number(item.width) || 0;
    const height = Number(item.height) || 0;
    return width && height ? `${width} × ${height}` : "";
  },

  markKinds() {
    $$("#pickerKinds button").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.kind === this.kind));
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    $("#pickerGrid").innerHTML = `<div class="picker-empty">正在读取素材…</div>`;
    try {
      if (this.scope === "library") {
        const data = await API.libraryAssets(this.libraryCategory);
        this.items = data.items || [];
        AssetLib.cache = data.categories || [];
        $("#pickerDir").textContent = `资产库 ${this.items.length} 项`;
        this.render();
        return;
      }
      const data = await API.assets(this.scope, State.activeId);
      this.items = data.items || [];
      $("#pickerDir").textContent = this.scope === "all"
        ? (data.fallback ? `接口模式 · 共 ${data.total ?? this.items.length} 项` : `共 ${data.total ?? this.items.length} 项`)
        : `本项目 ${this.items.length} 项`;
    } catch (error) {
      this.items = [];
      $("#pickerGrid").innerHTML = `<div class="picker-empty">读取失败：${escapeHtml(error.message)}</div>`;
      $("#pickerDir").textContent = "读取失败";
      this.loading = false;
      this.updateFooter();
      return;
    } finally {
      this.loading = false;
    }
    this.render();
  },

  render() {
    // 资产库页签：顶部显示分类（文件夹）栏
    if (this.scope === "library") {
      AssetLib.folderBar("pickerFolders", this.libraryCategory).catch(() => {});
    } else {
      AssetLib.hideFolderBar("pickerFolders");
    }
    const query = this.query;
    this.shown = this.items.filter((item) => {
      if (this.kind !== "all" && item.kind !== this.kind) return false;
      if (!query) return true;
      return `${item.name} ${item.caption || ""}`.toLowerCase().includes(query);
    });

    if (!this.shown.length) {
      const empty = this.items.length
        ? (query ? "没有匹配的素材" : `这个分类下还没有${this.KIND_LABEL[this.kind] || "素材"}`)
        : (this.scope === "project" ? "本项目还没有素材" : "没有读取到素材");
      $("#pickerGrid").innerHTML = `<div class="picker-empty">${empty}</div>`;
      this.updateFooter();
      return;
    }

    const grid = $("#pickerGrid");
    grid.classList.toggle("waterfall", this.view === "waterfall");
    if (this.view === "waterfall") {
      grid.innerHTML = this.renderWaterfall(this.shown);
    } else {
      grid.innerHTML = this.shown.map((item) => this.tileHtml(item)).join("");
    }
    this.updateFooter();
  },

  tileHtml(item) {
    const key = this.keyOf(item);
    const on = this.selected.has(key);
    const usable = this.selectable(item);
    const caption = item.source === "library" ? `资产库 · ${item.category || "未分类"}`
      : (item.caption && item.caption !== "输入目录" && item.caption !== "输出目录"
        ? item.caption : (item.source === "output" ? "输出目录" : item.source === "project" ? "本项目作品" : "输入目录"));
    const res = this.resText(item);
    // 瀑布流下图片按真实比例撑开
    const ratio = this.view === "waterfall" && item.kind === "image" && item.width && item.height
      ? ` style="aspect-ratio:${item.width}/${item.height}"` : "";
    return `
      <div class="picker-tile ${on ? "selected" : ""} ${usable ? "" : "locked"}"
           data-key="${escapeHtml(key)}" title="${escapeHtml(item.name)}">
        ${item.kind === "image"
          ? `<img src="${item.url}" alt="" loading="lazy"${ratio}>`
          : item.kind === "video"
            ? `<video class="tile-video" src="${item.url}#t=0.1" muted playsinline preload="metadata"${ratio}></video>
               <span class="tile-play">${icon("video")}</span>`
            : `<div class="picker-ph">${icon(this.KIND_ICON[item.kind] || "image")}<span>${this.KIND_LABEL[item.kind] || "素材"}</span></div>`}
        <span class="check">${icon("check")}</span>
        <span class="picker-meta">
          <span class="picker-kind">${this.KIND_LABEL[item.kind] || "素材"}${res ? ` · ${res}` : ""}</span>
          <span class="picker-name">${escapeHtml(item.name)}</span>
          <span class="picker-caption">${escapeHtml(caption)}</span>
        </span>
      </div>`;
  },

  /* 瀑布流：按最短列分发，列宽由可用宽度决定 */
  renderWaterfall(items) {
    const width = $("#pickerGrid").clientWidth || 1000;
    const count = Math.max(2, Math.min(6, Math.floor(width / 220)));
    const columns = Array.from({ length: count }, () => ({ weight: 0, html: "" }));
    items.forEach((item) => {
      const w = Number(item.width) || 0;
      const h = Number(item.height) || 0;
      const target = columns.reduce((a, b) => (a.weight <= b.weight ? a : b));
      target.weight += (w && h ? h / w : 1) + 1.9;   // 图片比例 + 文字信息高度
      target.html += this.tileHtml(item);
    });
    return `<div class="waterfall-cols" style="grid-template-columns:repeat(${count},minmax(0,1fr))">${
      columns.map((column) => `<div class="waterfall-col">${column.html}</div>`).join("")
    }</div>`;
  },

  toggle(key) {
    const item = this.shown.find((entry) => this.keyOf(entry) === key)
      || this.items.find((entry) => this.keyOf(entry) === key);
    if (!item) return;
    if (!this.selectable(item)) {
      toast("参考图只能选图片，切到「提示词」模式才能选视频 / 音频");
      return;
    }
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.set(key, item);
    const tile = $(`#pickerGrid .picker-tile[data-key="${CSS.escape(key)}"]`);
    tile?.classList.toggle("selected", this.selected.has(key));
    this.updateFooter();
  },

  async deleteSelected() {
    const items = [...this.selected.values()];
    if (!items.length) return;
    if (!await Dialog.confirm({
      title: "删除选中素材",
      message: `确定删除选中的 ${items.length} 项吗？\n资产库会删库文件、本项目会连作品记录一起删、其余会删 ComfyUI 目录里的文件。`,
      confirmText: `删除 ${items.length} 项`,
    })) return;
    this.selected.clear();
    const result = await AssetLib.deleteItems(items);
    await this.load();
    const failed = result.failed?.length || 0;
    toast(`已删除 ${result.library + result.project + result.comfy} 项${failed ? `，${failed} 项失败` : ""}`);
    if (failed) Dialog.warn({ title: "部分删除失败", message: result.failed.slice(0, 5).join("\n") });
  },

  updateFooter() {
    const count = this.selected.size;
    const total = this.shown.length;
    $("#pickerConfirm").disabled = count === 0;
    $("#pickerConfirm").textContent = count ? `添加已选（${count}）` : "添加已选";
    $("#pickerClear").disabled = count === 0;
    $("#pickerDelete").disabled = count === 0;
    $("#pickerSelectAll").disabled = total === 0;
    $("#pickerInfo").textContent = total ? `显示 ${total} 项` : "";

    const chosen = $("#pickerChosen");
    if (!count) {
      chosen.innerHTML = `<span class="picker-chosen-empty">尚未选择素材</span>`;
      return;
    }
    chosen.innerHTML = `<span class="picker-chosen-count">已选 ${count} 项</span>` +
      [...this.selected.values()].slice(0, 8).map((item) => `
        <span class="picker-chosen-chip" title="${escapeHtml(item.name)}">
          ${item.kind === "image" ? `<img src="${item.url}" alt="">`
            : `<span class="chosen-ph">${icon(this.KIND_ICON[item.kind] || "image")}</span>`}
          <button data-drop="${escapeHtml(this.keyOf(item))}" title="移除">${icon("close")}</button>
        </span>`).join("") +
      (count > 8 ? `<span class="picker-chosen-more">+${count - 8}</span>` : "");
  },

  async confirm() {
    const picked = [...this.selected.values()];
    if (!picked.length) return;
    const btn = $("#pickerConfirm");
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      const payload = picked.map((item) => item.ref || { source: item.source, name: item.name });
      const result = await API.importReferences(payload);
      const items = (result.items || []).map((item, index) => ({
        name: item.name,
        source: item.source,
        kind: picked[index]?.kind || "image",
        origin: picked[index]?.name || item.origin || item.name,
        // 画布素材节点需要原图地址和导入引用，创作框会忽略这三个字段
        url: picked[index]?.url || "",
        ref: picked[index]?.ref || { source: item.source, name: item.name },
        width: Number(picked[index]?.width) || 0,
        height: Number(picked[index]?.height) || 0,
        taskId: picked[index]?.task_id || picked[index]?.taskId || "",
      }));
      this.close();
      this.onConfirm?.(items);
    } catch (error) {
      Dialog.warn({ title: "导入失败", message: error.message });
      btn.disabled = false;
      this.updateFooter();
    }
  },
};
