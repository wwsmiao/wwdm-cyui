/* 无限画布：平移 / 缩放 / 点阵背景 / 素材节点 / 端口连线 / 自动整理
   布局与连线按项目保存在 localStorage，不写后端。 */
const Canvas = {
  STORE: "wwdm-canvas-layouts",
  EDGE_ORIGIN: 200000,   // 连线 SVG 向四周扩出去，节点被拖到负坐标时连线也能点中
  layouts: {},
  projectId: "",
  view: "card",
  camera: { x: 44, y: 34, zoom: 1 },
  nodes: [],
  edges: [],
  selected: "",
  selection: new Set(),
  clipboard: null,
  history: [],
  future: [],
  menuNode: "",
  _pan: null,
  _move: null,
  _link: null,
  _box: null,
  _gmove: null,
  menuGroup: "",
  selectedGroup: "",
  textEditorNode: "",
  _justMoved: "",
  _mmQueued: false,

  // ---------- 持久化 ----------
  init() {
    this.layouts = this.readStore();
    this.bind();
  },

  readStore() {
    try { return JSON.parse(localStorage.getItem(this.STORE)) || {}; }
    catch { return {}; }
  },

  save() {
    try { localStorage.setItem(this.STORE, JSON.stringify(this.layouts)); }
    catch { /* 隐私模式下写不进去也不影响当次使用 */ }
    // 服务端也存一份：localStorage 换浏览器 / 换域名 / 清缓存就没了，服务端才是底稿
    this.queueServerSave();
  },

  queueServerSave() {
    const pid = this.projectId || State.activeId;
    if (!pid) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const layout = this.layouts[pid];
      if (!layout) return;
      API.saveProjectLayout(pid, layout).catch(() => { /* 网络抖动就先留在本地 */ });
    }, 500);
  },

  /* 拉服务端布局：服务端有就以它为准（本机缓存当首屏），服务端为空而本地有则迁移上去 */
  async hydrate(projectId = State.activeId) {
    if (!projectId || this._hydrating === projectId) return;
    this._hydrating = projectId;
    const score = (layout) => ["nodes", "gens", "texts", "assets"]
      .reduce((sum, key) => sum + Object.keys(layout?.[key] || {}).length, 0);
    try {
      const result = await API.projectLayout(projectId);
      const remote = result?.layout || {};
      const local = this.layouts[projectId] || {};
      if (!result?.exists) {
        // 服务端从没存过：把本地旧布局迁上去（老版本只用 localStorage）
        if (score(local)) {
          this.layouts[projectId] = local;
          API.saveProjectLayout(projectId, local).catch(() => {});
        }
      } else {
        // 服务端存过就以它为准，哪怕是空的（用户可能主动清空了画布）
        this.layouts[projectId] = remote;
        try { localStorage.setItem(this.STORE, JSON.stringify(this.layouts)); } catch { /* 忽略 */ }
      }
    } catch { /* 服务端暂时不可用：继续用本地缓存，下次再同步 */ }
    finally {
      this._hydrating = "";
    }
    if (projectId === State.activeId) this.render();
  },

  layout() {
    const id = State.activeId || "default";
    if (!this.layouts[id]) {
      this.layouts[id] = { nodes: {}, edges: [], assets: {}, gens: {}, texts: {}, groups: {}, camera: { x: 44, y: 34, zoom: 1 } };
    }
    const data = this.layouts[id];
    data.nodes ||= {};
    data.assets ||= {};
    data.gens ||= {};
    data.texts ||= {};
    data.groups ||= {};
    data.edges ||= [];
    return data;
  },

  syncProject() {
    if (this.projectId === State.activeId) return;
    this.projectId = State.activeId;
    this.selected = "";
    this.menuNode = "";
    this.selection = new Set();
    this.history = [];
    this.future = [];
    window.CanvasComposer?.hide();
    const saved = this.layout().camera || {};
    this.camera = {
      x: Number(saved.x) || 44,
      y: Number(saved.y) || 34,
      zoom: Math.max(.35, Math.min(2.2, Number(saved.zoom) || 1)),
    };
    State.zoom = this.camera.zoom;
    $("#zoomLabel").textContent = `${Math.round(this.camera.zoom * 100)}%`;
    // 切项目 / 首次进画布：把服务端布局拉下来（本地缓存先顶着，拉到后重渲染）
    this.hydrate(this.projectId);
  },

  saveCamera() {
    this.layout().camera = { ...this.camera };
    this.save();
  },

  // ---------- 数据 ----------
  kindOfTask(task) {
    const first = (task.images || [])[0] || "";
    if (task.kind === "video" || /\.(mp4|webm|mov|mkv|avi)$/i.test(first)) return "video";
    if (task.kind === "audio" || /\.(mp3|wav|flac|ogg|m4a)$/i.test(first)) return "audio";
    return "image";
  },

  labelOf(kind, type) {
    if (type === "asset") return { image: "参考图片", video: "参考视频", audio: "参考音频" }[kind] || "参考素材";
    if (type === "gen") return { image: "图片", video: "视频", prompt: "提示词" }[kind] || "生成";
    return { image: "图片", video: "视频", audio: "音频" }[kind] || "作品";
  },

  iconOf(kind) {
    return { image: "image", video: "video", audio: "mic", prompt: "text" }[kind] || "image";
  },

  workflowName(id) {
    return State.workflows.find((wf) => wf.id === id)?.name || "未选择工作流";
  },

  buildNodes() {
    const layout = this.layout();
    const nodes = [];
    Object.entries(layout.assets || {}).forEach(([id, asset]) => {
      const kind = asset.kind || "image";
      const ref = asset.ref || { source: "input", name: asset.name || id };
      let url = asset.url || "";
      if (!url) {
        url = ref.source === "project" ? ref.name : API.comfyFileUrl(ref.source || "input", ref.name);
      }
      nodes.push({
        id, type: "asset", kind, asset, ref,
        title: this.labelOf(kind, "asset"),
        name: asset.alias || asset.name || asset.origin || "素材",
        caption: asset.origin || "",
        media: url,
        width: Number(asset.width) || 0,
        height: Number(asset.height) || 0,
      });
    });
    Object.entries(layout.gens || {}).forEach(([id, gen]) => {
      const kind = gen.kind || "image";
      nodes.push({
        id, type: "gen", kind, gen,
        title: this.labelOf(kind, "gen"),
        name: this.resultName(gen),
        caption: gen.error ? `生成失败：${gen.error}` : gen.prompt || "",
        media: gen.result || "",
        status: gen.status || "idle",
        progress: gen.progress || 0,
        width: Number(gen.width) || 0,
        height: Number(gen.height) || 0,
      });
    });
    Object.entries(layout.texts || {}).forEach(([id, text]) => {
      nodes.push({
        id, type: "text", kind: "text", textNode: text,
        title: "文本", name: text.title || "文本节点", caption: text.text || "", media: "",
      });
    });
    nodes.forEach((node, index) => {
      const pos = layout.nodes[node.id] || {};
      node.x = Number.isFinite(Number(pos.x)) ? Number(pos.x) : 46 + (index % 4) * 292;
      node.y = Number.isFinite(Number(pos.y)) ? Number(pos.y) : 40 + Math.floor(index / 4) * 268;
      node.w = node.type === "gen" ? 304 : node.type === "text" ? 250 : 232;
      node.h = node.type === "gen" ? 262 : node.type === "text" ? 206 : 198;
    });
    return nodes;
  },

  resultName(gen) {
    if (gen.alias) return gen.alias;
    const list = gen.results || (gen.result ? [gen.result] : []);
    const index = Math.min(Number(gen.resultIndex) || 0, Math.max(0, list.length - 1));
    const current = String(list[index] || "");
    if (!current) return this.workflowName(gen.workflow);
    const task = (State.tasks || []).find((item) => (gen.taskIds || []).includes(item.id));
    if (task && window.Works?.titleOf) return Works.titleOf(task, current);
    return decodeURIComponent(current.split("/").pop() || "") || this.workflowName(gen.workflow);
  },

  /* 节点对应的作品任务：先按 taskIds，再按结果地址反查（素材节点 / 旧节点没有 taskIds） */
  nodeTaskOf(node) {
    const tasks = State.tasks || [];
    const ids = node?.gen?.taskIds || [];
    const url = node?.type === "gen" ? (node.gen?.result || "") : (node.media || "");
    return tasks.find((task) => ids.includes(task.id))
      || tasks.find((task) => url && (task.images || []).includes(url))
      || null;
  },

  /* 双击节点名字：作品图/视频改作品里的素材名（卡片、图库同步），其它节点改本节点显示名 */
  async renameNode(nodeId) {
    const node = this.byId(nodeId);
    if (!node) return;
    if (node.type === "text") {
      const name = await Dialog.prompt({
        title: "重命名文本节点",
        label: "给这个文本节点起个名字（留空恢复「文本节点」）",
        value: node.textNode?.title || "",
        placeholder: "例如：人物提示词",
        confirmText: "保存",
      });
      if (name === null) return;
      const text = this.layout().texts[nodeId];
      if (text) text.title = String(name).trim();
      this.save();
      this.render();
      return;
    }

    const task = this.nodeTaskOf(node);
    const url = node.type === "gen" ? (node.gen?.result || "") : (node.media || "");
    // 作品里真实存在的文件：改作品记录，卡片 / 图库 / 下载名一起变
    if (task && url && String(url).startsWith("/api/output/")) {
      const changed = await Works.renameMedia(task, url);
      if (changed) {
        if (node.type === "gen" && node.gen) node.gen.alias = "";
        this.save();
        this.render();
      }
      return;
    }
    // 外部素材 / 没有任务记录的节点：只改本节点显示名
    const name = await Dialog.prompt({
      title: "重命名节点",
      label: "节点上显示的名字（留空恢复默认）",
      value: node.name || "",
      placeholder: "例如：参考图 A",
      confirmText: "保存",
    });
    if (name === null) return;
    const clean = String(name).trim();
    if (node.type === "gen" && node.gen) node.gen.alias = clean;
    else {
      const asset = this.layout().assets[nodeId];
      if (asset) asset.alias = clean;
    }
    this.save();
    this.render();
  },



  byId(id) { return this.nodes.find((node) => node.id === id) || null; },

  elOf(id) { return $(`.cv-node[data-node="${CSS.escape(id)}"]`, $("#canvasNodes")); },

  portPos(id, side) {
    const node = this.byId(id);
    const port = $(`.cv-port--${side}`, this.elOf(id) || document);
    if (!node || !port) return null;
    // 连线层向负坐标扩了 EDGE_ORIGIN，SVG 坐标要整体平移进去
    return {
      x: node.x + port.offsetLeft + port.offsetWidth / 2 + this.EDGE_ORIGIN,
      y: node.y + port.offsetTop + port.offsetHeight / 2 + this.EDGE_ORIGIN,
    };
  },

  // ---------- 渲染 ----------
  /* 把生成节点和真实任务对上：进度、结果、报错都从任务里同步 */
  /* 图库/素材弹窗里删掉的作品：画布上引用它的节点同步清掉结果（空了连节点一起删） */
  dropResults(urls) {
    if (!urls?.length) return;
    const gone = new Set(urls);
    const layout = this.layout();
    const doomed = [];
    let changed = false;
    Object.entries(layout.gens || {}).forEach(([id, gen]) => {
      const before = gen.results || [];
      const kept = before.filter((url) => !gone.has(url));
      if (kept.length === before.length) return;
      changed = true;
      gen.results = kept;
      gen.result = kept[0] || "";
      if (!kept.length) {
        gen.status = "idle";
        gen.progress = 0;
        doomed.push(id);
      }
    });
    doomed.forEach((id) => {
      delete layout.gens[id];
      delete layout.nodes[id];
      layout.edges = (layout.edges || []).filter((edge) => edge.from !== id && edge.to !== id);
      if (this.selected === id) this.selected = "";
    });
    if (changed) {
      this.save();
      this.render();
      if (doomed.includes(window.CanvasComposer?.nodeId)) window.CanvasComposer?.hide();
    }
  },

  reconcile() {
    const layout = this.layout();
    const tasks = Array.isArray(State.tasks) ? State.tasks : [];
    let changed = false;
    this._missing = this._missing || {};
    const now = Date.now();
    Object.entries(layout.gens || {}).forEach(([gid, gen]) => {
      const ids = gen.taskIds || [];
      if (!ids.length) {
        // 没有任务号：状态由提交 / 停止逻辑自己维护，这里不要动
        delete this._missing[gid];
        return;
      }
      const found = ids.map((id) => tasks.find((task) => task.id === id)).filter(Boolean);
      if (!found.length) {
        // 任务刚提交还没轮到轮询（或任务列表还没刷新）：给一段宽限期，
        // 不能像以前那样立刻当成「任务被删了」把状态清回待生成，
        // 否则提交后进度层和「停止」按钮会瞬间消失。
        const since = this._missing[gid] || (this._missing[gid] = now);
        if (now - since < 8000) return;
        delete this._missing[gid];
        // 任务暂时查不到（列表还没刷新 / 服务端刚重启）时**不要清掉已经拿到的结果**：
        // 以前这里会把 results 清空并写回 localStorage，一次网络抖动就把画布内容永久抹掉。
        // 只把还在跑的状态收一下，等任务列表回来会自动重新对上。
        if (["queued", "submitting", "running"].includes(gen.status)) {
          gen.status = (gen.results || []).length ? "done" : "idle";
          gen.progress = (gen.results || []).length ? 100 : 0;
          changed = true;
        }
        return;
      }
      delete this._missing[gid];
      const results = found.flatMap((task) => task.images || []);
      const running = found.find((task) => ["queued", "submitting", "running"].includes(task.status));
      const failed = found.find((task) => task.status === "error");
      const cancelled = found.find((task) => task.status === "cancelled");
      const status = running ? running.status
        : results.length ? "done"
          : failed ? "error" : cancelled ? "cancelled" : "idle";
      // 多任务时按「已完成算 100%」求平均，进度条只往前走不来回跳
      const progress = running
        ? Math.round(found.reduce((sum, task) =>
          sum + (task.status === "done" ? 100 : (Number(task.progress) || 0)), 0) / found.length)
        : (results.length ? 100 : 0);
      const error = failed && !results.length ? failed.error : "";
      const sized = found.find((task) => Number(task.width) > 0 && Number(task.height) > 0);
      if (sized && (Number(gen.width) || 0) !== Number(sized.width)) {
        gen.width = Number(sized.width);
        gen.height = Number(sized.height);
        changed = true;
      }
      const keepIndex = Math.min(Number(gen.resultIndex) || 0, Math.max(0, results.length - 1));
      if (gen.status !== status || gen.progress !== progress || gen.result !== (results[keepIndex] || "")
        || gen.error !== error || JSON.stringify(gen.results || []) !== JSON.stringify(results)) {
        gen.status = status;
        gen.progress = progress;
        gen.resultIndex = Math.min(Number(gen.resultIndex) || 0, Math.max(0, results.length - 1));
        gen.result = results[gen.resultIndex] || results[0] || "";
        gen.results = results;
        gen.error = error;
        changed = true;
      }
    });
    if (changed) this.save();
  },

  render() {
    if (State.viewMode !== "canvas") return;
    this.syncProject();
    this.reconcile();
    this.nodes = this.buildNodes();
    const known = new Set(this.nodes.map((node) => node.id));
    const layout = this.layout();
    this.edges = (layout.edges || []).filter((edge) => known.has(edge.from) && known.has(edge.to));

    this.syncNodes();
    this.nodes.forEach((node) => {
      const el = this.elOf(node.id);
      if (!el) return;
      node.w = el.offsetWidth;
      node.h = el.offsetHeight;
      // 端口对齐到媒体框的垂直中心（素材卡片没有标题行、有说明文字时也准）
      const mediaEl = el.querySelector(".cv-node-media");
      const frameEl = el.querySelector(".cv-node-frame");
      const center = mediaEl
        ? mediaEl.offsetTop + mediaEl.offsetHeight / 2
        : (frameEl?.offsetHeight || el.offsetHeight) / 2;
      el.querySelectorAll(".cv-port").forEach((port) => { port.style.top = `${center}px`; });
    });
    this.syncGroups();
    this.drawEdges();
    this.applyCamera();
    this.refreshSelection();
    window.CanvasComposer?.refresh();
  },

  /* 增量渲染：只重建结构真正变化的节点，进度/名称原地更新 —— 运行中不再闪烁 */
  signatureOf(node) {
    if (node.type === "gen") {
      const gen = node.gen || {};
      return JSON.stringify([
        node.type, node.kind, node.media, (gen.results || []).length, gen.resultIndex || 0,
        ["queued", "submitting", "running"].includes(node.status) ? "run" : "idle",
        gen.status === "error" ? "error" : "",
        gen.kind === "prompt" ? "prompt" : "",
      ]);
    }
    return JSON.stringify([node.type, node.media, node.caption || ""]);
  },

  syncNodes() {
    const layer = $("#canvasNodes");
    if (!layer) return;
    const seen = new Set();
    this.nodes.forEach((node) => {
      seen.add(node.id);
      const selector = `[data-node="${CSS.escape(node.id)}"]`;
      let el = layer.querySelector(selector);
      const sig = this.signatureOf(node);
      if (!el || el._sig !== sig) {
        const holder = document.createElement("div");
        holder.innerHTML = this.nodeHtml(node).trim();
        const fresh = holder.firstElementChild;
        if (!fresh) return;
        fresh._sig = sig;
        if (el) el.replaceWith(fresh);
        else layer.appendChild(fresh);
        el = fresh;
      }
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.classList.toggle("selected", this.selection.has(node.id));
      // 名称 / 生成状态文案：原地改，不重建
      const nameEl = el.querySelector(".cv-node-name");
      if (nameEl) {
        const text = node.gen?.status === "error" ? "生成失败" : node.name;
        if (nameEl.textContent !== text) nameEl.textContent = text;
        nameEl.title = node.gen?.status === "error" ? (node.gen.error || "生成失败") : (node.name || "");
      }
      const progressLabel = el.querySelector(".cv-gen-progress span");
      if (progressLabel && node.type === "gen") {
        const [statusLabel] = this.genStatus(node.gen);
        const text = node.status === "running" && node.kind !== "prompt"
          ? `${node.progress || 0}%` : statusLabel;
        if (progressLabel.textContent !== text) progressLabel.textContent = text;
      }
      // 文本类节点：没在编辑时同步内容，避免打断输入
      const area = el.querySelector(".cv-text-node");
      if (area && document.activeElement !== area) {
        const want = node.type === "text" ? (node.textNode?.text || "") : (node.gen?.result || "");
        if (area.value !== want) area.value = want;
      }
    });
    [...layer.children].forEach((child) => {
      if (!seen.has(child.dataset.node)) child.remove();
    });
  },

  /* 组框：按成员包围盒自适应，空组自动解散 */
  syncGroups() {
    const layout = this.layout();
    const groups = layout.groups;
    const positions = new Map(this.nodes.map((node) => [node.id, node]));
    const pad = 18;
    const head = 34;
    let pruned = false;
    const html = [];
    Object.entries(groups || {}).forEach(([id, group]) => {
      const members = (group.members || []).map((mid) => positions.get(mid)).filter(Boolean);
      if (!members.length) {
        delete groups[id];
        pruned = true;
        return;
      }
      const minX = Math.min(...members.map((m) => m.x)) - pad;
      const minY = Math.min(...members.map((m) => m.y)) - pad - head;
      const maxX = Math.max(...members.map((m) => m.x + m.w)) + pad;
      const maxY = Math.max(...members.map((m) => m.y + m.h)) + pad;
      group.rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      html.push(`<div class="cv-group${this.selectedGroup === id ? " selected" : ""}"
        data-group="${escapeHtml(id)}" style="left:${Math.round(minX)}px;top:${Math.round(minY)}px;width:${Math.round(maxX - minX)}px;height:${Math.round(maxY - minY)}px">
        <div class="cv-group-head">
          <input class="cv-group-name" data-group-name="${escapeHtml(id)}" value="${escapeHtml(group.name || "组")}" spellcheck="false">
        </div>
      </div>`);
    });
    if (pruned) this.save();
    const layer = $("#canvasGroups");
    if (layer) layer.innerHTML = html.join("");
  },

  captureGroup() {
    const ids = [...this.selection].filter((id) => this.byId(id));
    if (!ids.length) return toast("先框选 / 多选要打组的节点（Ctrl+拖空白框选）", true);
    const layout = this.layout();
    const inOne = Object.values(layout.groups || {}).find((group) =>
      group.members?.length === ids.length && ids.every((id) => group.members.includes(id)));
    if (inOne) return toast(`这些节点已经在「${inOne.name || "组"}」里`);
    this.record();
    const id = this.uid("group");
    const name = `组 ${Object.keys(layout.groups || {}).length + 1}`;
    layout.groups[id] = { id, name, members: ids, createdAt: Date.now() };
    this.save();
    this.setSelection(ids, ids.length === 1 ? ids[0] : "");
    this.selectedGroup = id;
    this.syncGroups();
    toast(`已创建「${name}」：拖动组框可以整组移动，输入框可以改名`);
  },

  dissolveGroup(id) {
    const layout = this.layout();
    if (!layout.groups?.[id]) return;
    this.record();
    delete layout.groups[id];
    if (this.selectedGroup === id) this.selectedGroup = "";
    this.save();
    this.syncGroups();
    toast("已解散组（节点保留）");
  },

  clearCanvas() {
    const layout = this.layout();
    const count = Object.keys(layout.nodes).length;
    if (!count) return toast("画布已经是空的", true);
    this.record();
    layout.nodes = {};
    layout.edges = [];
    layout.assets = {};
    layout.gens = {};
    layout.texts = {};
    layout.groups = {};
    this.save();
    this.setSelection([], "");
    this.selectedGroup = "";
    this.render();
    toast(`画布已清空（${count} 个节点）`);
  },

  /* 素材卡片：完整素材 + 名称 + 类别；双击看素材/生成信息；操作都在右键菜单里 */
  materialCardHtml(node, media, { nameNode = null, extra = "" } = {}) {
    const selection = this.selection.has(node.id) ? " selected" : "";
    return `
      <div class="cv-node cv-node--${node.type}${selection}"
           data-node="${escapeHtml(node.id)}" style="left:${node.x}px;top:${node.y}px">
        <div class="cv-node-frame">
          ${media}
          <div class="cv-node-solo${extra ? " " + extra : ""}">
            ${nameNode ?? `<span class="cv-node-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>`}
          </div>
        </div>
        ${node.type === "gen"
          ? `<button class="cv-port cv-port--in" data-port="in" title="输入：接收上游素材 / 文本，自动传入本节点">${icon("minus")}</button>` : ""}
        <button class="cv-port cv-port--out" data-port="out" title="拖出连线：把本节点的素材 / 文本传给下游">${icon("plus")}</button>
      </div>`;
  },

  nodeHtml(node) {
    if (node.type === "gen") return this.genNodeHtml(node);
    if (node.type === "text") return this.textNodeHtml(node);
    return this.materialCardHtml(node, this.mediaHtml(node));
  },

  /* 生成卡片：结果出来后就是一张素材卡片；运行中只叠进度层 */
  genNodeHtml(node) {
    const gen = node.gen;
    const [statusLabel] = this.genStatus(gen);
    const running = ["queued", "submitting", "running"].includes(gen.status);
    const mediaWrap = (inner) => `<div class="cv-node-media" data-media="${escapeHtml(node.id)}">${inner}</div>`;
    let media;
    if (gen.kind === "prompt") {
      // 生成的文本直接显示为可编辑文字（与文本节点一致）
      const text = gen.result || "";
      media = text || !running
        ? `<div class="cv-node-media cv-node-media--flat" data-media="${escapeHtml(node.id)}">
             <textarea class="cv-text-node" data-gen-text="${escapeHtml(node.id)}"
               placeholder="生成后显示提示词文字，可直接编辑" spellcheck="false">${escapeHtml(text)}</textarea>
           </div>`
        : mediaWrap(`<div class="cv-node-empty">${icon("text")}<span>正在生成提示词…</span></div>`);
    } else if (node.media) {
      media = this.mediaHtml(node);
      const total = (gen.results || []).length;
      if (total > 1) {
        const index = Math.min(Number(gen.resultIndex) || 0, total - 1);
        media = media.replace(/<\/div>$/, `<button class="cv-gen-flip" data-gen-flip="${
          escapeHtml(node.id)}" title="切换这一组的其它图">${index + 1}/${total}</button></div>`);
      }
    } else {
      media = mediaWrap(`<div class="cv-node-empty">${icon(this.iconOf(gen.kind))}<span>选中节点后在旁边创作区配置并生成</span></div>`);
    }
    if (running) {
      const overlay = `<div class="cv-gen-progress"><div class="ring"></div><span>${
        gen.status === "running" && gen.kind !== "prompt" ? `${gen.progress || 0}%` : statusLabel}</span></div>`;
      // 进度层叠进媒体框内部
      const closeTag = "</div>";
      const index = media.lastIndexOf(closeTag);
      media = media.slice(0, index) + overlay + media.slice(index);
    }
    const isFailed = gen.status === "error";
    const nameNode = `<span class="cv-node-name${isFailed ? " error" : ""}" title="${escapeHtml(isFailed ? (gen.error || "生成失败") : node.name)}">${
      escapeHtml(isFailed ? "生成失败" : node.name)}</span>`;
    return this.materialCardHtml(node, media, { nameNode });
  },

  textNodeHtml(node) {
    const text = node.textNode?.text || "";
    const media = `<div class="cv-node-media cv-node-media--flat" data-media="${escapeHtml(node.id)}">
      <textarea class="cv-text-node" data-text-node="${escapeHtml(node.id)}"
        placeholder="输入文本 / 提示词…" spellcheck="false">${escapeHtml(text)}</textarea>
    </div>`;
    return this.materialCardHtml(node, media, { nameNode: `<span class="cv-node-name" title="双击改名">${escapeHtml(node.name || "文本节点")}</span>` });
  },

  genStatus(gen) {
    const map = {
      idle: ["待生成", ""], queued: ["排队中", ""], submitting: ["提交中", ""],
      running: ["生成中", ""], done: ["已完成", "done"], error: ["失败", "error"],
      cancelled: ["已停止", ""],
    };
    return map[gen.status] || [gen.status || "待生成", ""];
  },


  /* 已知素材宽高时让媒体框按原始比例自适应，图片/视频完整显示不裁切 */
  mediaAspect(node) {
    const width = Number(node?.width) || 0;
    const height = Number(node?.height) || 0;
    if (width > 0 && height > 0) return { width, height };
    return null;
  },

  mediaHtml(node) {
    if (!node.media) {
      return `<div class="cv-node-media" data-media="${escapeHtml(node.id)}">
        <div class="cv-node-empty">${icon("image")}<span>选中节点后在下方配置并生成</span></div></div>`;
    }
    if (node.kind === "audio") {
      return `<div class="cv-node-media" data-media="${escapeHtml(node.id)}">
        <div class="cv-node-audio">${icon("mic")}<span>${escapeHtml(node.name)}</span></div></div>`;
    }
    const size = this.mediaAspect(node);
    const style = size ? ` style="height:auto;aspect-ratio:${size.width} / ${size.height};"` : "";
    const tag = node.kind === "video"
      ? `<video src="${escapeHtml(node.media)}" muted loop playsinline preload="metadata"></video>`
      : `<img src="${escapeHtml(node.media)}" alt="" loading="lazy" draggable="false">`;
    return `<div class="cv-node-media" data-media="${escapeHtml(node.id)}"${style}>
      ${tag}<span class="cv-kind">${node.kind === "video" ? "视频" : "图片"}</span></div>`;
  },

  curve(a, b) {
    const bend = Math.max(46, Math.abs(b.x - a.x) * .45);
    const r = (value) => Math.round(value);
    return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + bend)} ${r(a.y)}, ${r(b.x - bend)} ${r(b.y)}, ${r(b.x)} ${r(b.y)}`;
  },

  drawEdges(tempPath) {
    const svg = $("#canvasEdges");
    if (!svg) return;
    const defs = `<defs>
      <marker id="cvArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 Z" fill="context-stroke"></path>
      </marker>
    </defs>`;
    const parts = this.edges.map((edge, index) => {
      const a = this.portPos(edge.from, "out");
      const b = this.portPos(edge.to, "in");
      if (!a || !b) return "";
      const d = this.curve(a, b);
      const emph = this.selection.has(edge.from) || this.selection.has(edge.to) ? " emph" : "";
      return `<g class="cv-edge${emph}" data-edge="${index}">
                <path class="cv-edge-hit" d="${d}"></path>
                <path class="cv-edge-line" d="${d}" marker-end="url(#cvArrow)"></path>
                <path class="cv-edge-flow" d="${d}"></path>
              </g>`;
    });
    if (tempPath) parts.push(`<g class="cv-edge temp"><path class="cv-edge-line" d="${tempPath}"></path></g>`);
    svg.innerHTML = defs + parts.join("");
  },

  applyCamera() {
    const world = $("#canvasInner");
    const view = $("#canvasView");
    if (!world || !view) return;
    world.style.transform = `translate(${Math.round(this.camera.x)}px, ${Math.round(this.camera.y)}px) scale(${this.camera.zoom})`;
    const grid = 22 * this.camera.zoom;
    view.style.setProperty("--cv-grid", `${grid}px ${grid}px`);
    view.style.setProperty("--cv-bg-x", `${Math.round(this.camera.x)}px`);
    view.style.setProperty("--cv-bg-y", `${Math.round(this.camera.y)}px`);
    this.queueMinimap();
    window.CanvasComposer?.follow();
  },

  // ---------- 视图操作 ----------
  onView(mode) {
    this.view = mode;
    this.closeMenu();
    this.closeAddMenu();
    if (mode !== "canvas") {
      window.CanvasComposer?.hide();
      return;
    }
    this.render();
    State.zoom = this.camera.zoom;
    $("#zoomLabel").textContent = `${Math.round(this.camera.zoom * 100)}%`;
    if (this.selected) window.CanvasComposer?.showFor(this.selected);
    else window.CanvasComposer?.hide();
  },

  zoomAt(target, px, py) {
    target = Math.max(.35, Math.min(2.2, Number(target) || 1));
    const old = this.camera.zoom;
    if (Math.abs(target - old) < .001) return;
    this.camera.x = px - (px - this.camera.x) * (target / old);
    this.camera.y = py - (py - this.camera.y) * (target / old);
    this.camera.zoom = target;
    State.zoom = target;
    $("#zoomLabel").textContent = `${Math.round(target * 100)}%`;
    this.applyCamera();
    this.saveCamera();
  },

  setZoom(value) {
    const view = $("#canvasView");
    this.zoomAt(value, view.clientWidth / 2, view.clientHeight / 2);
  },

  fit() {
    const view = $("#canvasView");
    if (!this.nodes.length) {
      this.camera = { x: 44, y: 34, zoom: 1 };
    } else {
      const minX = Math.min(...this.nodes.map((n) => n.x));
      const minY = Math.min(...this.nodes.map((n) => n.y));
      const maxX = Math.max(...this.nodes.map((n) => n.x + n.w));
      const maxY = Math.max(...this.nodes.map((n) => n.y + n.h));
      // 视口很矮时按百分比留白，避免适应视图一下缩到最小倍率
      const width = Math.max(1, view.clientWidth - Math.min(120, view.clientWidth * .1));
      const occluded = window.CanvasComposer?.visible() ? 200 : 0;
      const height = Math.max(1, view.clientHeight - Math.min(100, view.clientHeight * .15) - occluded);
      const zoom = Math.max(.35, Math.min(1.2, width / (maxX - minX), height / (maxY - minY)));
      this.camera.zoom = zoom;
      this.camera.x = (view.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom;
      this.camera.y = (view.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom;
    }
    State.zoom = this.camera.zoom;
    $("#zoomLabel").textContent = `${Math.round(this.camera.zoom * 100)}%`;
    this.applyCamera();
    this.saveCamera();
  },

  /* 整理：按连线深度分层，同层竖排，清掉重叠 */
  tidy() {
    if (!this.nodes.length) return toast("画布里还没有节点", true);
    const depth = new Map(this.nodes.map((node) => [node.id, 0]));
    for (let pass = 0; pass < this.nodes.length; pass += 1) {
      let changed = false;
      this.edges.forEach((edge) => {
        const next = (depth.get(edge.from) || 0) + 1;
        if (next > (depth.get(edge.to) || 0) && next <= this.nodes.length) {
          depth.set(edge.to, next);
          changed = true;
        }
      });
      if (!changed) break;
    }
    const rows = new Map();
    const layout = this.layout();
    this.nodes
      .slice()
      .sort((a, b) => (depth.get(a.id) || 0) - (depth.get(b.id) || 0))
      .forEach((node) => {
        const col = Math.min(depth.get(node.id) || 0, 12);
        const row = rows.get(col) || 0;
        rows.set(col, row + 1);
        layout.nodes[node.id] = { x: 46 + col * 310, y: 40 + row * 270 };
      });
    this.save();
    this.render();
    this.fit();
    toast(`已整理 ${this.nodes.length} 个节点`);
  },

  // ---------- 连线与素材 ----------
  /* 直接上游（只看相邻连线）：A→B→C 时 C 只收 B 的输入，禁止 A 直传 C */
  directInputsOf(id) {
    const result = [];
    (this.layout().edges || []).forEach((edge) => {
      if (edge.to === id && edge.from !== id && !result.includes(edge.from)) result.push(edge.from);
    });
    return result;
  },

  upstreamOf(id) {
    const result = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      this.edges.filter((edge) => edge.to === current).forEach((edge) => {
        if (seen.has(edge.from)) return;
        seen.add(edge.from);
        result.unshift(edge.from);
        queue.push(edge.from);
      });
    }
    return result;
  },

  refsOf(id) {
    const node = this.byId(id);
    if (!node) return [];
    if (node.type === "task") {
      return (node.task.images || []).map((url) => ({
        source: "project", name: url, kind: node.kind,
        origin: node.task.prompt || node.title, url,
      }));
    }
    if (node.type === "gen") {
      const gen = node.gen;
      if (!gen) return [];
      // 提示词节点不产出文件，但它引用过的素材要继续往下游传
      if (gen.kind === "prompt") return (gen.refs || []).map((ref) => ({ ...ref, auto: false }));
      // 已出结果 → 把结果当素材传给下游；还没出结果 → 传它手动引用的素材
      // 只沿相邻连线传递：A→B→C 时 C 收 B 的素材，不收 A 的
      const results = (gen.results || (gen.result ? [gen.result] : [])).map((url) => ({
        source: "project", name: url, kind: gen.kind,
        origin: gen.prompt || node.title, url,
      }));
      if (results.length) return results;
      return (gen.refs || []).map((ref) => ({ ...ref, auto: false }));
    }
    if (node.type === "text") return [];
    return [{
      source: node.ref?.source || "input",
      name: node.ref?.name || node.name,
      kind: node.kind,
      origin: node.asset?.origin || node.name,
      url: node.media,
    }];
  },

  /* 上游素材 + 节点手动添加的素材，auto 标记用于「智能引用」显示 */
  mediaRefsFor(id) {
    const gen = this.layout().gens?.[id] || {};
    const auto = gen.autoRef === false ? [] : this.directInputsOf(id).flatMap((nodeId) => this.refsOf(nodeId));
    const manual = (gen.refs || []).map((ref) => ({ ...ref, auto: false }));
    const seen = new Set();
    return [...auto.map((ref) => ({ ...ref, auto: true })), ...manual].filter((ref) => {
      const key = `${ref.source}:${ref.name}`;
      if (!ref.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  /* 上游提示词节点的结果，作为下游生成节点的提示词 */
  upstreamPromptText(id) {
    return this.directInputsOf(id)
      .map((nodeId) => this.byId(nodeId))
      .map((node) => {
        if (node?.type === "text") return node.textNode?.text || "";
        if (node?.type === "gen" && node.gen.kind === "prompt") {
          return node.gen.result || node.gen.prompt || "";
        }
        // 图片 / 视频创作节点：没有独立提示词输出，把它写过的描述当作文本传下去
        if (node?.type === "gen") return node.gen.prompt || "";
        return "";
      })
      .filter((text) => text.trim())
      .join("\n\n");
  },

  async prepareRefs(refs) {
    if (!refs.length) return [];
    const result = await API.importReferences(refs.map((ref) => ({ source: ref.source, name: ref.name })));
    return (result.items || []).map((item, index) => ({
      ...item,
      kind: refs[index]?.kind || "image",
      origin: refs[index]?.origin || item.origin,
    }));
  },

  defaultWorkflowFor(kind, hasMedia = true) {
    const type = kind === "prompt" ? "llm" : kind;
    // 局部重绘只从作品卡片的遮罩弹窗里用，画布节点不默认选它
    const list = (State.workflows || []).filter(
      (wf) => (wf.kind || "image") === type && wf.category !== "inpaint" && wf.category !== "tool"
        && wf.available !== false);
    // 图片节点：有上游素材优先图生图，没有素材（如提示词节点下游）用文生图
    const fits = (wf) => (kind !== "image" ? true : !!wf.needs_image === !!hasMedia);
    // 纯放大类（scale）工作流不当默认，避免新节点一接图就变成放大；
    // 纯 Python 的网格拼接也是专用工具，只有它是唯一选择时才当默认
    const match = (wf) => !wf.scale && wf.engine !== "python" && fits(wf);
    const saved = localStorage.getItem(`wwdm-cv-workflow-${kind}`);
    // 提示词节点优先本地 ComfyUI 的 LLM 工作流，没配置 API Key 时也不会一上来就失败
    const preferred = ["llm-qwen3vl-提示词", "llm-gemma4-提示词"];
    const fallback = kind === "prompt"
      ? preferred.map((id) => list.find((wf) => wf.id === id)).find(Boolean) || list[0]
      : list.find(match) || list.find(fits) || list[0];
    // 用户手动选过（记在本地）就尊重手动选择，放大工作流也一样
    const remembered = list.find((wf) => wf.id === saved && fits(wf));
    return (remembered || fallback)?.id || "";
  },

  defaultParamsFor(kind) {
    return {
      ratio: "1:1", resolution: "1k", batch: 1,
      custom: false, custom_width: 1024, custom_height: 1024,
      video_ratio: "16:9", quality: 1, duration: 3,
    };
  },

  uid(prefix = "gen") {
    return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  },

  /* 新建生成节点：kind=image|video|prompt，fromIds 为上游素材节点 */
  createGenNode(kind, options = {}) {
    const layout = this.layout();
    const id = this.uid("gen");
    const near = options.near ? this.byId(options.near) : null;
    let x = Number(options.x);
    let y = Number(options.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      // 从端口拖到空白处：让节点中心落在松手位置
      x -= 152;
      y -= 110;
    } else if (near) {
      x = near.x + near.w + 88;
      y = near.y;
    } else {
      const view = $("#canvasView");
      x = (view.clientWidth / 2 - this.camera.x) / this.camera.zoom - 150;
      y = (view.clientHeight / 2 - this.camera.y) / this.camera.zoom - 110;
    }
    const preset = options.data || {};
    const hasMedia = (options.fromIds || [])
      .flatMap((from) => this.refsOf(from))
      .some((ref) => (ref.kind || "image") === "image");
    this.record();
    layout.gens[id] = {
      id, kind,
      prompt: preset.prompt || "",
      workflow: preset.workflow || this.defaultWorkflowFor(kind, hasMedia),
      params: { ...this.defaultParamsFor(kind), ...(preset.params || {}) },
      refs: preset.refs || [],
      function: preset.function || "",
      autoRef: preset.autoRef !== false,
      status: "idle", progress: 0, taskIds: [], results: [], result: "", error: "",
      createdAt: Date.now(),
    };
    layout.nodes[id] = { x: Math.round(x), y: Math.round(y) };
    (options.fromIds || []).forEach((from) => {
      if (!from || from === id) return;
      if (!(layout.edges || []).some((edge) => edge.from === from && edge.to === id)) {
        layout.edges.push({ from, to: id });
      }
    });
    // 上游有文本时直接写进新节点的提示词，打开就是可用的
    if (!(layout.gens[id].prompt || "").trim()) {
      const text = this.upstreamPromptText(id);
      if (text) layout.gens[id].prompt = text;
    }
    this.save();
    this.render();
    this.select(id);
    if (options.openComposer !== false) window.CanvasComposer?.openFor(id);
    return id;
  },

  /* 画布节点 → 局部重绘：弹出遮罩编辑，提交后的结果落成旁边的新节点 */
  openInpaint(id) {
    const node = this.byId(id);
    if (!node) return;
    const url = node.type === "gen" ? node.gen?.result : node.media;
    if (!url) return toast("这个节点还没有图片", true);
    if (!this.inpaintable(node)) {
      return Dialog.warn({
        title: "没有局部重绘工作流",
        message: "需要先有一个「局部重绘」类型的工作流，才能在这个节点上涂遮罩重绘。",
      });
    }
    const name = node.type === "gen" ? this.resultName(node.gen) : node.name;
    MaskEditor.open({
      url,
      name,
      label: "画布节点",
      width: node.width,
      height: node.height,
      projectId: State.activeId,
      onCreated: (created) => this.addInpaintNode(id, created),
    });
  },

  /* 局部重绘结果：新建一个生成节点接住这条任务，进度 / 出图由 reconcile 同步 */
  addInpaintNode(sourceId, created) {
    if (!created?.id) return;
    const id = this.createGenNode("image", {
      near: this.byId(sourceId) ? sourceId : undefined,
      openComposer: false,
      data: {
        workflow: created.workflow,
        prompt: created.prompt || "",
        params: { ...(created.params || {}) },
      },
    });
    const gen = this.layout().gens?.[id];
    if (gen) {
      gen.taskIds = [created.id];
      gen.status = created.status || "queued";
      gen.progress = Number(created.progress) || 0;
      this.save();
      this.render();
    }
    // 让新任务进 State.tasks，画布节点的进度条才会动
    window.Main?.refreshAll?.();
    this.select(id);
    toast("已提交局部重绘，节点会显示进度");
  },

  /* 视频节点 → 取最后一帧，落成旁边的一张新图片节点（本地 ffmpeg，不经过 ComfyUI） */
  async lastFrameNode(id) {
    const node = this.byId(id);
    if (!node) return;
    const url = node.type === "gen" ? (node.gen?.result || "") : (node.media || "");
    if (!url) return toast("这个节点还没有视频", true);
    if (this._frameBusy) return;
    this._frameBusy = true;
    toast("正在提取视频尾帧…");
    try {
      const result = await API.videoLastFrame(url, State.activeId);
      const task = result?.task;
      if (!task) return toast("没有取到尾帧", true);
      this.addFrameNode(id, task);
      // 新任务要进 State.tasks，作品列表 / 画布同步都能看到
      window.Main?.refreshAll?.();
    } catch (error) {
      Dialog.warn({ title: "提取尾帧失败", message: error.message });
    } finally {
      this._frameBusy = false;
    }
  },

  /* 尾帧落到画布：源节点右侧新建一个图片节点，并从源节点拉一条线标明出处 */
  addFrameNode(sourceId, task) {
    const url = (task.images || [])[0] || "";
    if (!url) return;
    const src = this.byId(sourceId);
    const layout = this.layout();
    const center = this.viewCenterWorld?.() || { x: 0, y: 0 };
    this.record();
    const id = `asset:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    layout.assets[id] = {
      id,
      kind: "image",
      name: task.prompt || "视频尾帧",
      origin: "视频尾帧",
      url,
      ref: { source: "project", name: url },
      width: Number(task.width) || 0,
      height: Number(task.height) || 0,
      taskId: task.id || "",
    };
    layout.nodes[id] = {
      x: Math.round(src ? src.x + (src.w || 232) + 56 : center.x),
      y: Math.round(src ? src.y : center.y),
    };
    if (src) {
      layout.edges = layout.edges || [];
      layout.edges.push({ from: sourceId, to: id });
    }
    this.save();
    this.render();
    this.select(id);
    toast("已把尾帧图片放到画布，可以继续拉线创作");
  },

  /* 批量删除：按 id 类型清掉节点数据与相关连线，一次撤销 */
  deleteNodes(ids) {
    const list = [...(ids instanceof Set ? ids : ids || [])];
    if (!list.length) return;
    this.record();
    const layout = this.layout();
    let removed = 0;
    list.forEach((id) => {
      if (layout.gens?.[id]) {
        delete layout.gens[id];
        removed += 1;
      } else if (layout.assets?.[id]) {
        delete layout.assets[id];
        removed += 1;
      } else if (layout.texts?.[id]) {
        delete layout.texts[id];
        removed += 1;
      }
      delete layout.nodes[id];
    });
    layout.edges = (layout.edges || []).filter((edge) => !list.includes(edge.from) && !list.includes(edge.to));
    const remaining = [...this.selection].filter((id) => !list.includes(id));
    const primary = remaining.length === 1 ? remaining[0] : "";
    if (remaining.length !== this.selection.size || list.includes(this.selected)) {
      this.setSelection(remaining, primary);
    } else if (list.includes(this.selected)) {
      this.selected = "";
      window.CanvasComposer?.hide();
    }
    this.save();
    this.render();
    toast(removed > 1 ? `已从画布移除 ${removed} 个节点` : "已从画布移除节点");
  },

  deleteGenNode(id) {
    this.deleteNodes([id]);
  },

  createTextNode(options = {}) {
    const layout = this.layout();
    const id = this.uid("text");
    const view = $("#canvasView");
    let x = Number(options.x);
    let y = Number(options.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      x -= 125;
      y -= 70;
    } else {
      x = (view.clientWidth / 2 - this.camera.x) / this.camera.zoom - 125;
      y = (view.clientHeight / 2 - this.camera.y) / this.camera.zoom - 70;
    }
    this.record();
    layout.texts[id] = { id, text: options.text || "" };
    layout.nodes[id] = { x: Math.round(x), y: Math.round(y) };
    this.save();
    this.render();
    this.select(id);
    setTimeout(() => {
      const area = $(`.cv-text-node[data-text-node="${CSS.escape(id)}"]`);
      area?.focus();
      area?.setSelectionRange(area.value.length, area.value.length);
    }, 0);
    return id;
  },

  deleteTextNode(id) {
    this.deleteNodes([id]);
  },

  /* 输入节点右上角的「使用」：基于它新建一个生成节点，创作区会跟到新节点下方 */
  useNode(id) {
    const node = this.byId(id);
    if (!node) return;
    const refs = this.refsOf(id);
    const hasImage = refs.some((ref) => (ref.kind || "image") === "image");
    const kind = node.type === "text" || hasImage ? "image" : "prompt";
    this.createGenNode(kind, { near: id, fromIds: [id] });
  },

  /* 双击文本 / 生成文本节点：大弹窗编辑并保存 */
  openTextEditor(id) {
    const node = this.byId(id);
    if (!node) return;
    const isText = node.type === "text";
    const isGenText = node.type === "gen" && node.gen?.kind === "prompt";
    if (!isText && !isGenText) return;
    this.textEditorNode = id;
    const layer = $("#textEditorLayer");
    const input = $("#textEditorInput");
    $("#textEditorTitle").textContent = isText ? "编辑文本" : "编辑生成的提示词";
    $("#textEditorTip").textContent = isText
      ? "Ctrl + Enter 保存 · Esc 取消"
      : "Ctrl + Enter 保存 · Esc 取消 · 保存后下游连线会用修订后的文字";
    input.value = isText ? (node.textNode?.text || "") : (node.gen.result || node.gen.prompt || "");
    layer.hidden = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  },

  saveTextEditor() {
    const id = this.textEditorNode;
    const node = id ? this.byId(id) : null;
    const value = $("#textEditorInput").value;
    if (!node) return this.closeTextEditor();
    this.record();
    if (node.type === "text" && node.textNode) {
      node.textNode.text = value;
      node.caption = value;
    } else if (node.type === "gen" && node.gen?.kind === "prompt") {
      node.gen.result = value;
      node.gen.results = value ? [value] : [];
      node.gen.status = value ? "done" : "idle";
    }
    this.save();
    this.render();
    window.CanvasComposer?.refresh();
    this.closeTextEditor();
    toast("已保存文本");
  },

  closeTextEditor() {
    this.textEditorNode = "";
    const layer = $("#textEditorLayer");
    if (layer) layer.hidden = true;
  },

  previewNode(id) {
    const node = this.byId(id);
    if (!node) return;
    if (node.type === "gen" && node.gen.taskIds?.length) {
      const taskId = node.gen.taskIds[0];
      if (State.tasks?.some((task) => task.id === taskId && (task.images || []).length)) {
        Works.preview(taskId, node.media || (State.tasks.find((task) => task.id === taskId).images || [])[0]);
        return;
      }
    }
    if (node.type === "asset" && node.asset?.taskId) {
      const taskId = node.asset.taskId;
      if (State.tasks?.some((task) => task.id === taskId && (task.images || []).length)) {
        Works.preview(taskId, node.media || (State.tasks.find((task) => task.id === taskId).images || [])[0]);
        return;
      }
    }
    if (node.type === "task") {
      Works.preview(node.task.id, node.media || (node.task.images || [])[0]);
      return;
    }
    if (node.type === "gen") {
      if (node.gen.kind === "prompt") {
        return Dialog.info({
          title: "生成的提示词",
          message: node.gen.result || "这个提示词节点还没有生成结果。",
        });
      }
      if (!node.gen.result) return toast("这个节点还没有生成结果", true);
      Works.previewAsset({
        url: node.gen.result,
        name: String(node.gen.result).split("/").pop(),
        kind: node.gen.kind,
        source: "project",
      });
      return;
    }
    Works.previewAsset({
      url: node.media,
      name: node.name,
      kind: node.kind,
      source: node.ref?.source || "input",
    });
  },

  addEdge(from, to) {
    if (from === to) return;
    if (this.byId(to)?.type !== "gen") return toast("只能连到图片 / 视频 / 提示词节点", true);
    const layout = this.layout();
    if ((layout.edges || []).some((edge) => edge.from === from && edge.to === to)) {
      return toast("这两个节点已经连过了");
    }
    this.record();
    layout.edges.push({ from, to });
    // 连上就把上游文本自动灌进下游提示词（下游已有内容则不覆盖）
    const target = this.byId(to);
    let injected = false;
    if (target?.type === "gen" && !(target.gen.prompt || "").trim()) {
      const text = this.upstreamPromptText(to);
      if (text) { target.gen.prompt = text; injected = true; }
    }
    this.save();
    this.render();
    if (injected) toast("已连线：上游文本已自动传入下游提示词");
    else toast("已连线：上游素材会作为下游节点的输入");
  },

  disconnect(id) {
    const layout = this.layout();
    const before = layout.edges.length;
    const after = layout.edges.filter((edge) => edge.from !== id && edge.to !== id);
    if (before === after.length) return toast("这个节点没有连线");
    this.record();
    layout.edges = after;
    this.save();
    this.render();
    toast("已断开连线");
  },

  viewCenterWorld() {
    const view = $("#canvasView");
    return {
      x: (view.clientWidth / 2 - this.camera.x) / this.camera.zoom,
      y: (view.clientHeight / 2 - this.camera.y) / this.camera.zoom,
    };
  },

  /* kind=all|image|video|audio：右键「图片 / 视频 / 音频 / 从资产库选择」都走这里 */
  pickAssets(point, kind = "all") {
    Picker.open((picked) => this.placeAssets(picked, point), {
      allowMedia: true,
      kind,
    });
  },

  placeAssets(picked, point) {
    if (!picked?.length) return [];
    const layout = this.layout();
    const base = point || this.viewCenterWorld();
    this.record();
    const ids = [];
    picked.forEach((item, index) => {
      const id = `asset:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${index}`;
      const ref = item.ref || { source: item.source || "input", name: item.name };
      layout.assets[id] = {
        id, kind: item.kind || "image", name: item.name,
        origin: item.origin || item.name, url: item.url || "", ref,
        width: Number(item.width) || 0, height: Number(item.height) || 0,
        taskId: item.task_id || item.taskId || "",
      };
      layout.nodes[id] = {
        x: Math.round(base.x - 116 + (index % 3) * 250),
        y: Math.round(base.y - 100 + Math.floor(index / 3) * 250),
      };
      ids.push(id);
    });
    this.save();
    this.render();
    toast(`已把 ${picked.length} 个素材放到画布`);
    return ids;
  },

  addAssets() {
    this.pickAssets(this.viewCenterWorld(), "all");
  },

  // ---------- 撤销 / 重做 ----------
  snapshot() {
    const layout = this.layout();
    return JSON.stringify({
      nodes: layout.nodes, edges: layout.edges,
      assets: layout.assets, gens: layout.gens, texts: layout.texts,
    });
  },

  /* 用户改动前调用：把当前布局压进撤销栈 */
  record() {
    const snap = this.snapshot();
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 60) this.history.shift();
    this.future = [];
    this.updateHistoryUi();
  },

  undo() {
    if (!this.history.length) return toast("没有可以撤销的操作", true);
    const current = this.snapshot();
    const previous = this.history.pop();
    this.future.push(current);
    this.restore(previous);
  },

  redo() {
    if (!this.future.length) return toast("没有可以重做的操作", true);
    const current = this.snapshot();
    const next = this.future.pop();
    this.history.push(current);
    this.restore(next);
  },

  restore(snapshot) {
    try {
      const layout = this.layout();
      const data = JSON.parse(snapshot);
      layout.nodes = data.nodes || {};
      layout.edges = data.edges || [];
      layout.assets = data.assets || {};
      layout.gens = data.gens || {};
      layout.texts = data.texts || {};
      layout.groups = data.groups || {};
    } catch {
      return;
    }
    this.save();
    this.render();
    this.updateHistoryUi();
  },

  updateHistoryUi() {
    const undoBtn = $("#canvasUndo");
    const redoBtn = $("#canvasRedo");
    if (undoBtn) undoBtn.disabled = !this.history.length;
    if (redoBtn) redoBtn.disabled = !this.future.length;
  },

  // ---------- 复制 / 粘贴 / 副本 ----------
  typeOfId(id) {
    if (id.startsWith("gen:")) return "gen";
    if (id.startsWith("text:")) return "text";
    if (id.startsWith("asset:")) return "asset";
    return "task";
  },

  copySelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    const layout = this.layout();
    const items = [];
    const edges = [];
    ids.forEach((id) => {
      const type = this.typeOfId(id);
      if (type === "task") return;   // 作品节点来自任务记录，不可复制
      const bucket = type === "gen" ? layout.gens : type === "text" ? layout.texts : layout.assets;
      if (!bucket?.[id]) return;
      items.push({
        id, type,
        data: JSON.parse(JSON.stringify(bucket[id])),
        x: Number(layout.nodes[id]?.x) || 0,
        y: Number(layout.nodes[id]?.y) || 0,
      });
    });
    if (!items.length) return toast("选中的节点不支持复制", true);
    (layout.edges || []).forEach((edge) => {
      if (ids.includes(edge.from) && ids.includes(edge.to)) edges.push({ from: edge.from, to: edge.to });
    });
    this.clipboard = { items, edges };
    toast(`已复制 ${items.length} 个节点，Ctrl+V 粘贴`);
  },

  pasteNodes() {
    const clip = this.clipboard;
    if (!clip?.items?.length) return;
    this.record();
    const layout = this.layout();
    const target = this.viewCenterWorld();
    const minX = Math.min(...clip.items.map((item) => item.x));
    const maxX = Math.max(...clip.items.map((item) => item.x));
    const minY = Math.min(...clip.items.map((item) => item.y));
    const maxY = Math.max(...clip.items.map((item) => item.y));
    const dx = target.x - (minX + maxX) / 2;
    const dy = target.y - (minY + maxY) / 2;
    const map = new Map();
    clip.items.forEach((item) => map.set(item.id, this.uid(item.type === "gen" ? "gen" : item.type)));
    clip.items.forEach((item) => {
      const newId = map.get(item.id);
      const data = { ...JSON.parse(JSON.stringify(item.data)), id: newId };
      if (item.type === "gen") {
        // 复制的是参数与提示词，不再挂旧任务；结果图保留用于显示
        data.taskIds = [];
        if (!data.results?.length) { data.results = []; }
        data.status = data.result ? "done" : "idle";
        data.progress = data.result ? 100 : 0;
        layout.gens[newId] = data;
      } else if (item.type === "text") {
        layout.texts[newId] = data;
      } else {
        layout.assets[newId] = data;
      }
      layout.nodes[newId] = { x: Math.round(item.x + dx), y: Math.round(item.y + dy) };
    });
    const kept = (layout.edges || []).filter((edge) => map.has(edge.from) && map.has(edge.to))
      .map((edge) => ({ from: map.get(edge.from), to: map.get(edge.to) }));
    layout.edges = [...(layout.edges || []), ...kept.filter((edge) =>
      !(layout.edges || []).some((old) => old.from === edge.from && old.to === edge.to))];
    this.save();
    this.setSelection(map.size === 1 ? [[...map.values()][0]] : [...map.values()],
      map.size === 1 ? [...map.values()][0] : "");
    toast(`已粘贴 ${clip.items.length} 个节点`);
  },

  duplicateSelection() {
    if (!this.selection.size) return;
    this.copySelection();
    this.clipboard && this.pasteNodes();
  },

  // ---------- 文件拖入 / 剪贴板 ----------
  kindOfUrl(name) {
    const lower = String(name).toLowerCase();
    if (/\.(mp4|webm|mov|mkv|avi)$/.test(lower)) return "video";
    if (/\.(mp3|wav|flac|ogg|m4a)$/.test(lower)) return "audio";
    return "image";
  },

  async uploadFiles(files, point) {
    if (!files?.length) return;
    toast(`正在上传 ${files.length} 个文件…`);
    try {
      this.record();
      const result = await API.uploadReferences(files, State.activeId);
      const items = (result.items || []).map((item) => ({
        name: item.name,
        source: "upload",
        kind: this.kindOfUrl(item.name),
        origin: item.origin || item.name,
        url: API.comfyFileUrl("input", item.name),
        width: 0, height: 0,
      }));
      if (!items.length) throw new Error("上传没有返回素材");
      this.placeAssets(items, point);
    } catch (error) {
      Dialog.warn({ title: "上传失败", message: error.message });
    }
  },

  // ---------- 导入 / 导出 ----------
  exportCanvas() {
    const layout = this.layout();
    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      project: State.activeProject()?.name || "",
      layout: {
        nodes: layout.nodes, edges: layout.edges,
        assets: layout.assets, gens: layout.gens, texts: layout.texts,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `canvas-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast("画布布局已导出");
  },

  async importCanvas(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      return Dialog.warn({ title: "导入失败", message: "这个文件不是有效的画布布局 JSON。" });
    }
    const incoming = payload.layout || payload;
    if (!incoming || typeof incoming !== "object" || !incoming.nodes) {
      return Dialog.warn({ title: "导入失败", message: "文件里没有找到画布布局数据。" });
    }
    const nodeCount = Object.keys(incoming.nodes).length;
    const edgeCount = (incoming.edges || []).length;
    const ok = await Dialog.confirm({
      title: "导入画布布局",
      message: `将替换当前画布的 ${nodeCount} 个节点、${edgeCount} 条连线，现有布局会进入撤销记录。确定导入吗？`,
      confirmText: "替换导入",
    });
    if (!ok) return;
    this.record();
    const layout = this.layout();
    layout.nodes = JSON.parse(JSON.stringify(incoming.nodes || {}));
    layout.edges = JSON.parse(JSON.stringify(incoming.edges || []));
    layout.assets = JSON.parse(JSON.stringify(incoming.assets || {}));
    layout.gens = JSON.parse(JSON.stringify(incoming.gens || {}));
    layout.texts = JSON.parse(JSON.stringify(incoming.texts || {}));
    layout.groups = JSON.parse(JSON.stringify(incoming.groups || {}));
    // 只保留两端都在布局里的连线
    layout.edges = layout.edges.filter((edge) => layout.nodes[edge.from] && layout.nodes[edge.to]);
    this.save();
    this.setSelection([], "");
    this.render();
    this.fit();
    toast(`已导入 ${nodeCount} 个节点、${layout.edges.length} 条连线`);
  },

  // ---------- 小地图 ----------
  drawMinimap() {
    const canvas = $("#cvMinimapCanvas");
    if (!canvas || $("#cvMinimap")?.hidden) return;
    const view = $("#canvasView");
    if (!view) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const zoom = this.camera.zoom;
    const viewport = {
      x: -this.camera.x / zoom,
      y: -this.camera.y / zoom,
      w: view.clientWidth / zoom,
      h: view.clientHeight / zoom,
    };
    // 包围盒只跟节点走：空画布时退回视口自身。
    // 绝不把「当前视口」并入包围盒——否则拖动视口会拉伸地图并造成定位漂移
    const base = this.nodes.length
      ? this.nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }))
      : [viewport];
    const minX = Math.min(...base.map((r) => r.x));
    const minY = Math.min(...base.map((r) => r.y));
    const maxX = Math.max(...base.map((r) => r.x + r.w));
    const maxY = Math.max(...base.map((r) => r.y + r.h));
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = Math.min(2, (W - 24) / bw, (H - 24) / bh);
    const ox = (W - bw * scale) / 2 - minX * scale;
    const oy = (H - bh * scale) / 2 - minY * scale;
    this._minimapBounds = { minX, minY, scale, ox, oy };
    if (this._miniDragBounds) this._miniDragBounds = { ...this._minimapBounds };
    ctx.fillStyle = "rgba(20,22,20,.0)";
    ctx.strokeStyle = "rgba(157,166,157,.32)";
    ctx.lineWidth = 2;
    this.edges.forEach((edge) => {
      const a = this.byId(edge.from);
      const b = this.byId(edge.to);
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(ox + (a.x + a.w / 2 - minX) * scale, oy + (a.y + a.h / 2 - minY) * scale);
      ctx.lineTo(ox + (b.x + b.w / 2 - minX) * scale, oy + (b.y + b.h / 2 - minY) * scale);
      ctx.stroke();
    });
    this.nodes.forEach((node) => {
      ctx.fillStyle = node.type === "gen" ? "rgba(214,245,58,.75)"
        : node.type === "text" ? "rgba(120,170,240,.7)"
          : "rgba(154,163,154,.6)";
      ctx.fillRect(ox + (node.x - minX) * scale, oy + (node.y - minY) * scale,
        Math.max(3, node.w * scale), Math.max(3, node.h * scale));
      if (this.selection.has(node.id)) {
        ctx.strokeStyle = "rgba(214,245,58,.95)";
        ctx.strokeRect(ox + (node.x - minX) * scale, oy + (node.y - minY) * scale,
          Math.max(3, node.w * scale), Math.max(3, node.h * scale));
      }
    });
    Object.values(this.layout().groups || {}).forEach((group) => {
      if (!group.rect) return;
      ctx.strokeStyle = "rgba(214,245,58,.4)";
      ctx.strokeRect(ox + (group.rect.x - minX) * scale, oy + (group.rect.y - minY) * scale,
        group.rect.w * scale, group.rect.h * scale);
    });
    ctx.strokeStyle = "rgba(214,245,58,.9)";
    ctx.strokeRect(ox + (viewport.x - minX) * scale, oy + (viewport.y - minY) * scale,
      viewport.w * scale, viewport.h * scale);
  },

  queueMinimap() {
    if (this._mmQueued) return;
    this._mmQueued = true;
    requestAnimationFrame(() => {
      this._mmQueued = false;
      this.drawMinimap();
    });
  },

  /* 拿最新图片：把节点对应任务的结果从 ComfyUI 历史重新取回；
     节点没有任务号时（停止过 / 旧布局恢复），退回「同工作流最新一张图」挂上来 */
  async refetchNode(id) {
    const gen = this.layout().gens?.[id];
    if (!gen) return;
    // 只剩还算存在的任务号；任务记录被删过的直接走下面的兜底
    const ids = [...(gen.taskIds || [])].filter((taskId) =>
      (State.tasks || []).some((task) => task.id === taskId));
    if (ids.length) {
      let any = false;
      for (const taskId of ids) {
        const result = await Works.refetch(taskId);
        if (result) any = true;
      }
      if (any) this.render();
      return;
    }
    gen.taskIds = [];
    const candidates = (State.tasks || [])
      .filter((task) => (task.images || []).length
        && (!gen.workflow || task.workflow === gen.workflow)
        && ((gen.kind === "video") === (task.kind === "video")))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const latest = candidates[0];
    if (!latest) return toast("当前项目里还没有这个工作流出过图", true);
    gen.taskIds = [latest.id];
    gen.results = [...latest.images];
    gen.result = latest.images[0];
    gen.status = "done";
    gen.progress = 100;
    gen.error = "";
    if (Number(latest.width) > 0) {
      gen.width = Number(latest.width);
      gen.height = Number(latest.height);
    }
    this.save();
    this.render();
    toast("已把最新一张图挂到这个节点");
  },

  // ---------- 选择 / 菜单 ----------
  refreshSelection() {
    $$(".cv-node").forEach((el) => el.classList.toggle("selected", this.selection.has(el.dataset.node)));
    const tip = $("#canvasBottomTip");
    if (!tip) return;
    if (this.selection.size > 1) {
      tip.textContent = `已选 ${this.selection.size} 个节点 · 拖动整组移动 · Delete 删除 · Ctrl+C 复制 · Ctrl+D 复制副本`;
      return;
    }
    const node = this.byId(this.selected);
    if (!node) {
      tip.textContent = "拖空白平移 · Ctrl 拖空白框选 · 右键空白添加 / 打组 · 双击素材卡片看生成信息";
      return;
    }
    if (node.type === "gen") {
      tip.textContent = `已选中「${node.title}」节点 · 创作区已跟随到节点旁 · 右键更多操作`;
      return;
    }
    if (node.type === "text") {
      tip.textContent = "已选中「文本」节点 · 节点内可直接编辑，双击可放大编辑，拖右侧圆点连到生成节点作为提示词";
      return;
    }
    const upstream = this.directInputsOf(node.id).length;
    tip.textContent = `已选中「${node.title}」 · 点右上角按钮基于它新建生成节点，或拖右侧圆点 · 直连上游 ${upstream} 个`;
  },

  setSelection(ids, primary = "") {
    this.selection = new Set(ids || []);
    this.selected = primary || (this.selection.size === 1 ? [...this.selection][0] : "");
    this.selectedGroup = "";
    $$(".cv-group.selected").forEach((el) => el.classList.remove("selected"));
    this.refreshSelection();
    if (this.selected) {
      const node = this.byId(this.selected);
      if (node?.type === "gen") window.CanvasComposer?.openFor(this.selected);
      else window.CanvasComposer?.hide();
    } else {
      window.CanvasComposer?.hide();
    }
  },

  select(id) {
    this.setSelection(id ? [id] : [], id);
  },

  /* 能不能局部重绘：节点上有图片，且至少有一个「局部重绘」工作流 */
  inpaintable(node) {
    if (!(State.workflows || []).some((wf) => wf.category === "inpaint" && wf.available !== false)) return false;
    const url = node?.type === "gen" ? node.gen?.result : node?.media;
    if (!url) return false;
    if (node.type === "gen" && node.gen?.kind && node.gen.kind !== "image") return false;
    return !/\.(mp4|webm|mov|mkv|mp3|wav|m4a|flac)$/i.test(String(url));
  },

  /* 能不能取尾帧：节点上挂的是视频文件（后端还会再校验 ffmpeg） */
  lastFrameable(node) {
    const url = node?.type === "gen" ? (node.gen?.result || "") : (node?.media || "");
    if (!url) return false;
    if (node.type === "gen" && node.gen?.kind && node.gen.kind !== "video") return false;
    if (node?.kind === "video") return true;
    return /\.(mp4|webm|mov|mkv|avi)(?:$|\?)/i.test(String(url));
  },

  typeMenuFor(node) {
    const groupCount = this.selection.size;
    const groupItem = `<button data-menu="group">${icon("grid")}打组（与选中 ${groupCount} 个节点）</button>`;
    const inpaintItem = this.inpaintable(node)
      ? `<button data-menu="inpaint">${icon("mask")}局部重绘…</button>`
      : "";
    const lastFrameItem = this.lastFrameable(node)
      ? `<button data-menu="last-frame">${icon("image")}提取视频尾帧</button>`
      : "";
    if (node?.type === "gen") {
      const status = node.gen.status;
      const running = ["queued", "submitting", "running"].includes(status);
      return `
        ${running ? `<button data-menu="stop">${icon("stop")}停止生成</button>` : ""}
        <button data-menu="edit">${icon("edit")}${status === "done" ? "继续创作 / 重新生成" : "打开创作区"}</button>
        <button data-menu="run">${icon("sparkle")}${status === "done" ? "重新生成" : "生成"}</button>
        ${node.gen.result ? `<button data-menu="preview">${icon("expand")}查看素材生成信息</button>` : ""}
        ${inpaintItem}
        ${lastFrameItem}
        ${node.gen.kind === "prompt" && node.gen.result
          ? `<button data-menu="download">${icon("download")}下载文本（.txt）</button>`
          : node.gen.result ? `<button data-menu="download">${icon("download")}下载当前素材</button>` : ""}
        ${node.gen.kind === "prompt" && node.gen.result
          ? `<button data-menu="copy-text">${icon("copy")}复制文本</button>` : ""}
        ${node.gen.kind === "prompt" ? "" : `<button data-menu="refetch">${icon("rotate")}拿最新图片</button>`}
        <div class="menu-sep"></div>
        <button data-menu="dup">${icon("copy")}复制副本</button>
        ${node.gen.result && node.gen.kind !== "prompt" ? `<button data-menu="library">${icon("folder")}添加到资产库</button>` : ""}
        ${groupCount ? groupItem : ""}
        <div class="menu-sep"></div>
        <button data-menu="disconnect">${icon("close")}断开相关连线</button>
        <button data-menu="delete-gen">${icon("trash")}从画布移除</button>
        <div class="menu-sep"></div>
        <button data-menu="tidy">${icon("grid")}整理画布</button>`;
    }
    const isText = node?.type === "text";
    const hasMedia = isText ? false : !!node.media;
    return `
      <button data-menu="use">${icon("sparkle")}${isText ? "用此文本创作" : "基于此素材创作"}</button>
      ${inpaintItem}
      ${lastFrameItem}
      <button data-menu="preview">${icon("expand")}查看素材生成信息</button>
      <button data-menu="download">${icon("download")}${isText ? "下载文本（.txt）" : "下载素材"}</button>
      ${isText ? `<button data-menu="edit">${icon("edit")}编辑文本</button>` : ""}
      ${isText ? `<button data-menu="copy-text">${icon("copy")}复制文本</button>` : ""}
      ${groupCount ? groupItem : ""}
      <div class="menu-sep"></div>
      <button data-menu="dup">${icon("copy")}复制副本</button>
      <button data-menu="disconnect">${icon("close")}断开相关连线</button>
      <button data-menu="delete-node">${icon("trash")}从画布移除</button>
      <div class="menu-sep"></div>
      <button data-menu="tidy">${icon("grid")}整理画布</button>`;
  },

  /* 下载节点内容：文本 → txt，图片/视频/音频 → 原文件 */
  downloadNode(id) {
    const node = this.byId(id);
    if (!node) return;
    if (node.type === "text") {
      return this.downloadText(node.textNode?.text || "", node.name || "文本");
    }
    if (node.type === "gen") {
      if (node.gen.kind === "prompt") {
        return this.downloadText(node.gen.result || "", this.resultName(node.gen) || "提示词");
      }
      const url = node.gen.result;
      if (!url) return toast("这个节点还没有生成结果", true);
      return this.downloadUrl(url, `${this.resultName(node.gen)}${this.extOf(url)}`);
    }
    if (!node.media) return toast("这个素材没有可下载的文件", true);
    return this.downloadUrl(node.media, `${node.name || "素材"}${this.extOf(node.media)}`);
  },

  extOf(url) {
    const match = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(String(url || ""));
    return match ? `.${match[1].toLowerCase()}` : "";
  },

  downloadUrl(url, name) {
    const link = document.createElement("a");
    link.href = url;
    link.download = String(name || url.split("/").pop() || "素材").replace(/[\\/:*?"<>|]/g, "_");
    document.body.appendChild(link);
    link.click();
    link.remove();
  },

  downloadText(text, name) {
    const blob = new Blob([String(text || "")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${String(name || "文本").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast("文本已下载");
  },

  openMenu(id, x, y) {
    this.menuNode = id;
    const node = this.byId(id);
    const menu = $("#canvasNodeMenu");
    menu.innerHTML = this.typeMenuFor(node);
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    $$(".cv-node").forEach((el) => el.classList.toggle("menu-target", el.dataset.node === id));
  },

  /* 组框右键：重命名 / 解散 / 删除组内节点 */
  openGroupMenu(id, x, y) {
    this.menuGroup = id;
    const group = this.layout().groups?.[id];
    const menu = $("#canvasNodeMenu");
    menu.innerHTML = `
      <div class="menu-title">组「${escapeHtml(group?.name || "")}」</div>
      <button data-menu="g-rename">${icon("edit")}重命名</button>
      <button data-menu="g-clear">${icon("trash")}删除组内节点</button>
      <button data-menu="g-dissolve">${icon("close")}解散组（节点保留）</button>`;
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  },

  closeMenu() {
    const menu = $("#canvasNodeMenu");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $$(".cv-node.menu-target").forEach((el) => el.classList.remove("menu-target"));
  },

  /* 画布空白处右键：创作节点 + 纯输入节点 */
  openAddMenu(x, y, point) {
    this._addPoint = point || this.viewCenterWorld();
    const menu = $("#canvasAddMenu");
    const selectedCount = this.selection.size;
    menu.innerHTML = `
      <div class="menu-title">创作节点（图片 / 视频 / 提示词合一，可切换）</div>
      <button data-add="gen">${icon("sparkle")}新建创作节点</button>
      ${selectedCount ? `
      <div class="menu-sep"></div>
      <button data-add="group">${icon("grid")}为选中的 ${selectedCount} 个节点打组</button>` : ""}
      <div class="menu-sep"></div>
      <div class="menu-title">输入节点（只作为上游）</div>
      <button data-add="text">${icon("text")}文本</button>
      <button data-add="audio">${icon("mic")}音频</button>
      <button data-add="image">${icon("image")}图片</button>
      <button data-add="video">${icon("video")}视频</button>
      <button data-add="library">${icon("folder")}从资产库选择</button>
      <div class="menu-sep"></div>
      <button data-add="tidy">${icon("grid")}整理画布</button>
      <button data-add="fit">${icon("expand")}适应视图</button>
      <button data-add="clear">${icon("eraser")}清空画布</button>`;
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  },

  closeAddMenu() {
    const menu = $("#canvasAddMenu");
    if (menu && !menu.hidden) menu.hidden = true;
  },

  // ---------- 事件 ----------
  bind() {
    const view = $("#canvasView");
    const nodesLayer = $("#canvasNodes");

    view.addEventListener("pointerdown", (event) => {
      // 点连线要交给连线的 click 处理，不能被画布当成平移起点（捕获指针会吞掉 click）
      if (event.target.closest(".cv-node, .canvas-toolbar, .cv-edge, .cv-composer, .popover, .cv-minimap, .cv-group")) return;
      // 上一次手势没收到 pointerup（松手在窗口外 / 捕获失败）时先收尾，别让旧状态跟着新手势走
      if (this.hasGesture()) this.abortGesture();
      if (event.button === 1) {
        // 中键平移：不取消选中
        event.preventDefault();
        this._pan = {
          sx: event.clientX, sy: event.clientY,
          cx: this.camera.x, cy: this.camera.y, moved: true,
          pointerId: event.pointerId,
        };
        view.classList.add("panning");
        try { view.setPointerCapture(event.pointerId); } catch { /* 合成事件忽略 */ }
        return;
      }
      if (event.button !== 0) return;
      this.closeMenu();
      this.closeAddMenu();
      if ((event.ctrlKey || event.shiftKey) && !event.altKey) {
        // Ctrl + 拖空白 = 框选（Shift 兼容）
        this._box = { sx: event.clientX, sy: event.clientY, pointerId: event.pointerId };
        try { view.setPointerCapture(event.pointerId); } catch { /* 合成事件忽略 */ }
        return;
      }
      // 拖动空白是平移，不取消选中（创作区要跟着节点走）；只有没拖动的点击才取消选中
      this._pan = {
        sx: event.clientX, sy: event.clientY,
        cx: this.camera.x, cy: this.camera.y, moved: false,
        pointerId: event.pointerId,
      };
      view.classList.add("panning");
      try { view.setPointerCapture(event.pointerId); } catch { /* 合成事件忽略 */ }
    });

    view.addEventListener("pointermove", (event) => this.onPointerMove(event));
    view.addEventListener("pointerup", (event) => this.onPointerUp(event));
    view.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    // 指针捕获被系统收回（切窗口 / 元素重建）：当成松手收尾
    view.addEventListener("lostpointercapture", (event) => {
      if (this.hasGesture()) this.onPointerUp(event);
    });
    // 兜底：松手落在画布外面（工具栏、侧栏、窗口边缘）时也能结束手势
    document.addEventListener("pointerup", (event) => {
      if (this.hasGesture()) this.onPointerUp(event);
    });
    // 切到别的窗口 / 最小化时鼠标不会再回来，直接把手势收干净
    window.addEventListener("blur", () => this.abortGesture());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.abortGesture();
    });

    view.addEventListener("wheel", (event) => {
      if (event.target.closest(".canvas-toolbar, .cv-composer, .popover")) return;
      event.preventDefault();
      const rect = view.getBoundingClientRect();
      this.zoomAt(
        this.camera.zoom * (event.deltaY < 0 ? 1.09 : 1 / 1.09),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    }, { passive: false });

    nodesLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const el = event.target.closest(".cv-node");
      if (!el) return;
      event.stopPropagation();
      // 上一次手势没收到 pointerup 就先把状态清掉，避免节点 / 画布被“粘”在鼠标上
      if (this.hasGesture()) this.abortGesture();
      this.closeMenu();
      this.closeAddMenu();
      this._justMoved = "";
      const id = el.dataset.node;
      const port = event.target.closest(".cv-port");
      if (port) {
        if (port.dataset.port !== "out") return;
        this._link = {
          from: id, sx: event.clientX, sy: event.clientY, moved: false,
          pointerId: event.pointerId,
        };
        el.classList.add("linking");
        try { view.setPointerCapture(event.pointerId); } catch { /* 合成事件忽略 */ }
        return;
      }
      if (event.shiftKey || event.ctrlKey) {
        // Shift/Ctrl + 点节点：把节点加入/移出多选
        const ids = new Set(this.selection);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        this.setSelection([...ids], [...ids][ids.size - 1] || "");
        return;
      }
      if (event.target.closest("button")) return;   // 按钮保持点击语义
      const node = this.byId(id);
      if (!node) return;
      // 多选集整体拖动；拖没选中的节点就是单选
      const items = this.selection.has(id)
        ? [...this.selection].map((nid) => {
            const n = this.byId(nid);
            return { id: nid, x: n.x, y: n.y };
          })
        : [{ id, x: node.x, y: node.y }];
      const drag = {
        id, sx: event.clientX, sy: event.clientY,
        ox: node.x, oy: node.y,
        moved: false, pointerId: event.pointerId, items,
      };
      // 文本区里按下先记成「待拖」：没移动就是普通点击（进入编辑），
      // 移动超过阈值才转成拖节点，这样节点任何位置都能拖走
      if (event.target.closest("textarea, input, [contenteditable]")) {
        this._pendingDrag = drag;
        this._dragField = event.target;
        return;
      }
      this._move = drag;
      Works._dragging = true;   // 轮询期间不要重建 DOM，否则会打断拖拽
      // 先不抓指针：没拖动时要让 click 正常落在节点上，拖过阈值再抓
    });

    nodesLayer.addEventListener("click", (event) => {
      const run = event.target.closest("[data-gen-run]");
      if (run) return void window.CanvasComposer?.generate(run.dataset.genRun);
      const flip = event.target.closest("[data-gen-flip]");
      if (flip) {
        const gen = this.layout().gens?.[flip.dataset.genFlip];
        if (gen) {
          const total = (gen.results || []).length;
          if (total > 1) {
            gen.resultIndex = ((Number(gen.resultIndex) || 0) + 1) % total;
            gen.result = gen.results[gen.resultIndex] || gen.result;
            this.save();
            this.render();
          }
        }
        return;
      }
      const genPreview = event.target.closest("[data-gen-preview]");
      if (genPreview) return this.previewNode(genPreview.dataset.genPreview);
      const genDel = event.target.closest("[data-gen-del]");
      if (genDel) return void this.deleteGenNode(genDel.dataset.genDel);
      const textDel = event.target.closest("[data-text-del]");
      if (textDel) return void this.deleteTextNode(textDel.dataset.textDel);
      const use = event.target.closest("[data-node-use]");
      if (use) return void this.useNode(use.dataset.nodeUse);
      const del = event.target.closest("[data-node-del]");
      if (del) return void this.deleteAsset(del.dataset.nodeDel);
      const preview = event.target.closest("[data-node-preview]");
      if (preview) return this.previewNode(preview.dataset.nodePreview);
      if (event.target.closest(".cv-port")) return;
      const el = event.target.closest(".cv-node");
      if (el && !this._justMoved) this.select(el.dataset.node);
    });

    nodesLayer.addEventListener("dblclick", (event) => {
      const el = event.target.closest(".cv-node");
      const node = el ? this.byId(el.dataset.node) : null;
      // 双击节点名字：所有类型都进改名（文本节点改标题，图片/视频改素材名）
      if (node && event.target.closest(".cv-node-name")) return void this.renameNode(node.id);
      if (node && (node.type === "text" || (node.type === "gen" && node.gen?.kind === "prompt"))) {
        return this.openTextEditor(node.id);
      }
      const media = event.target.closest("[data-media]");
      if (media) this.previewNode(media.dataset.media);
    });

    // ---- 组框：点选 = 选中成员；拖动 = 整组移动；输入框改名 ----
    const groupsLayer = $("#canvasGroups");
    groupsLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const el = event.target.closest(".cv-group");
      if (!el) return;
      event.stopPropagation();
      if (this.hasGesture()) this.abortGesture();
      this.closeMenu();
      this.closeAddMenu();
      const id = el.dataset.group;
      const group = this.layout().groups?.[id];
      if (!group) return;
      const memberIds = (group.members || []).filter((mid) => this.byId(mid));
      if (event.target.closest(".cv-group-name")) {
        // 点输入框：选中组并聚焦改名
        this.selectedGroup = id;
        $$(".cv-group").forEach((node2) => node2.classList.toggle("selected", node2.dataset.group === id));
        event.target.focus();
        return;
      }
      this.setSelection(memberIds, memberIds.length === 1 ? memberIds[0] : "");
      this.selectedGroup = id;
      $$(".cv-group").forEach((node2) => node2.classList.toggle("selected", node2.dataset.group === id));
      const items = memberIds.map((nid) => {
        const n = this.byId(nid);
        return { id: nid, x: n.x, y: n.y };
      });
      this._gmove = {
        id, sx: event.clientX, sy: event.clientY, moved: false,
        pointerId: event.pointerId, items,
        groupX: parseFloat(el.style.left) || group.rect?.x || 0,
        groupY: parseFloat(el.style.top) || group.rect?.y || 0,
      };
      Works._dragging = true;
      // 先不抓指针：没拖动时让 click 正常落在组框上，超过阈值再抓
    });

    groupsLayer.addEventListener("input", (event) => {
      const input = event.target.closest("[data-group-name]");
      if (!input) return;
      const group = this.layout().groups?.[input.dataset.groupName];
      if (!group) return;
      group.name = input.value;
      clearTimeout(this._groupNameTimer);
      this._groupNameTimer = setTimeout(() => {
        this.record();
        this.save();
      }, 400);
    });

    groupsLayer.addEventListener("dblclick", (event) => {
      const input = event.target.closest("[data-group-name]");
      if (!input) return;
      input.focus();
      input.select();
    });

    nodesLayer.addEventListener("focusin", (event) => {
      const area = event.target.closest("[data-text-node]");
      if (area) return this.select(area.dataset.textNode);
      const genArea = event.target.closest("[data-gen-text]");
      if (genArea) this.select(genArea.dataset.genText);
    });

    nodesLayer.addEventListener("input", (event) => {
      const textArea = event.target.closest("[data-text-node]");
      if (textArea) {
        const node = this.byId(textArea.dataset.textNode);
        if (!node?.textNode) return;
        node.textNode.text = textArea.value;
        node.caption = textArea.value;
        clearTimeout(this._textTimer);
        this._textTimer = setTimeout(() => {
          this.save();
          window.CanvasComposer?.refresh();
        }, 300);
        return;
      }
      // 生成的提示词文本：编辑即写回结果，下游连线继续传修订后的文字
      const genArea = event.target.closest("[data-gen-text]");
      if (!genArea) return;
      const gen = this.layout().gens?.[genArea.dataset.genText];
      if (!gen) return;
      gen.result = genArea.value;
      gen.results = genArea.value ? [genArea.value] : [];
      clearTimeout(this._textTimer);
      this._textTimer = setTimeout(() => {
        this.save();
        window.CanvasComposer?.refresh();
      }, 300);
    });

    view.addEventListener("contextmenu", (event) => {
      // 输入框里保留系统右键（复制 / 粘贴）；但画布节点自带的文本区要出节点菜单
      const inNodeField = event.target.closest(".cv-node textarea, .cv-node input, .cv-node [contenteditable]");
      if (!inNodeField && event.target.closest("textarea, input, .cv-composer, .popover, .cv-minimap")) return;
      const groupEl = event.target.closest(".cv-group");
      if (groupEl) {
        event.preventDefault();
        this.closeMenu();
        this.openGroupMenu(groupEl.dataset.group, event.clientX, event.clientY);
        return;
      }
      const el = event.target.closest(".cv-node");
      event.preventDefault();
      if (el) {
        this.closeAddMenu();
        this.openMenu(el.dataset.node, event.clientX, event.clientY);
        return;
      }
      this.closeMenu();
      const rect = view.getBoundingClientRect();
      this.openAddMenu(event.clientX, event.clientY, {
        x: Math.max(0, (event.clientX - rect.left - this.camera.x) / this.camera.zoom),
        y: Math.max(0, (event.clientY - rect.top - this.camera.y) / this.camera.zoom),
      });
    });

    $("#canvasEdges").addEventListener("click", (event) => {
      const edge = event.target.closest("[data-edge]");
      if (!edge) return;
      this.record();
      const layout = this.layout();
      layout.edges.splice(Number(edge.dataset.edge), 1);
      this.save();
      this.render();
      toast("已删除连线");
    });

    $("#canvasNodeMenu").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-menu]");
      if (!btn) return;
      const id = this.menuNode;
      const action = btn.dataset.menu;
      this.closeMenu();
      if (action === "download") return this.downloadNode(id);
      if (action === "copy-text") {
        const node = this.byId(id);
        const text = node?.type === "text" ? (node.textNode?.text || "")
          : (node?.gen?.result || node?.gen?.prompt || "");
        if (!text) return toast("这个节点还没有文本", true);
        navigator.clipboard?.writeText(text).then(
          () => toast("文本已复制"),
          () => toast("复制失败", true),
        );
        return;
      }
      if (action === "use") return void this.useNode(id);
      if (action === "group") return this.captureGroup();
      if (action === "g-rename") {
        $(`.cv-group-name[data-group-name="${CSS.escape(this.menuGroup || "")}"]`)?.focus();
        return;
      }
      if (action === "g-dissolve") return this.dissolveGroup(this.menuGroup);
      if (action === "g-clear") {
        const group = this.layout().groups?.[this.menuGroup];
        if (group) this.deleteNodes(group.members);
        return;
      }
      if (action === "edit") {
        const node = this.byId(id);
        if (node?.type === "text") {
          this.select(id);
          $(`.cv-text-node[data-text-node="${CSS.escape(id)}"]`)?.focus();
        } else if (node?.type === "gen") {
          this.select(id);
          $("#cvPrompt")?.focus();
        } else {
          this.useNode(id);
        }
        return;
      }
      if (action === "run") return void window.CanvasComposer?.generate(id);
      if (action === "library") {
        const node = this.byId(id);
        if (!node?.gen?.result) return toast("这个节点还没有生成结果", true);
        if (node.gen.kind === "prompt") return toast("提示词是文本，不能保存为素材", true);
        return void window.AssetLib?.openSave("project", node.gen.result, node.gen.prompt || "");
      }
      if (action === "stop") return void window.CanvasComposer?.stop(id);
      if (action === "refetch") return void this.refetchNode(id);
      if (action === "preview") return this.previewNode(id);
      if (action === "dup") {
        if (!this.selection.has(id)) this.setSelection([id], id);
        this.duplicateSelection();
        return;
      }
      if (action === "disconnect") return this.disconnect(id);
      if (action === "delete-node" || action === "delete" || action === "delete-gen" || action === "delete-text") {
        return void this.deleteNodes([id]);
      }
      if (action === "tidy") return this.tidy();
      if (action === "inpaint") return this.openInpaint(id);
      if (action === "last-frame") return void this.lastFrameNode(id);
    });

    $("#canvasAddMenu").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-add]");
      if (!btn) return;
      const action = btn.dataset.add;
      const point = this._addPoint || this.viewCenterWorld();
      this.closeAddMenu();
      if (action === "gen") return void this.createGenNode("image", { x: point.x, y: point.y });
      if (action === "group") return this.captureGroup();
      if (action === "text") return void this.createTextNode({ x: point.x, y: point.y });
      if (action === "image") return void this.pickAssets(point, "image");
      if (action === "video") return void this.pickAssets(point, "video");
      if (action === "audio") return void this.pickAssets(point, "audio");
      if (action === "library") return void this.pickAssets(point, "all");
      if (action === "tidy") return this.tidy();
      if (action === "fit") return this.fit();
      if (action === "clear") return void this.clearCanvas();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#canvasNodeMenu, .cv-node")) this.closeMenu();
      if (!event.target.closest("#canvasAddMenu")) this.closeAddMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.closeMenu(); this.closeAddMenu();
        if (State.viewMode === "canvas" && this.selection.size > 1) {
          this.setSelection([], "");
        }
        return;
      }
      if (State.viewMode !== "canvas") return;
      const onInput = event.target.closest("input, textarea, [contenteditable]");
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === "z" && !onInput) {
        event.preventDefault();
        return event.shiftKey ? this.redo() : this.undo();
      }
      if (ctrl && event.key.toLowerCase() === "y" && !onInput) {
        event.preventDefault();
        return this.redo();
      }
      if (ctrl && event.key.toLowerCase() === "c" && !onInput && this.selection.size) {
        return this.copySelection();
      }
      if (ctrl && event.key.toLowerCase() === "d" && !onInput && this.selection.size) {
        event.preventDefault();
        return this.duplicateSelection();
      }
      if (ctrl && event.key.toLowerCase() === "g" && !onInput && this.selection.size) {
        event.preventDefault();
        return this.captureGroup();
      }
      if (event.key === "Delete" || (event.key === "Backspace" && !onInput)) {
        if (onInput) return;
        if (!this.selection.size) return;
        event.preventDefault();
        return void this.deleteNodes(this.selection);
      }
    });
    window.addEventListener("resize", () => {
      this.closeMenu(); this.closeAddMenu();
      window.CanvasComposer?.follow();
      this.queueMinimap();
    });

    $("#canvasAddAsset").addEventListener("click", () => this.addAssets());
    // 工具条收缩：收起后只剩一个箭头按钮，状态记住
    const toolbar = $("#canvasToolbar");
    const applyToggle = (collapsed) => {
      toolbar.classList.toggle("collapsed", collapsed);
      $("#canvasTbToggle")?.setAttribute("title", collapsed ? "展开工具栏" : "收起工具栏");
      $("#canvasTbToggle use")?.setAttribute("href", collapsed ? "#i-chevron" : "#i-chevron-up");
      localStorage.setItem("wwdm-canvas-toolbar", collapsed ? "1" : "0");
    };
    applyToggle(localStorage.getItem("wwdm-canvas-toolbar") === "1");
    $("#canvasTbToggle").addEventListener("click", () => {
      applyToggle(!toolbar.classList.contains("collapsed"));
    });
    $("#canvasFit").addEventListener("click", () => this.fit());
    $("#canvasTidy").addEventListener("click", () => this.tidy());
    $("#canvasUndo").addEventListener("click", () => this.undo());
    $("#canvasRedo").addEventListener("click", () => this.redo());
    // 文本大编辑弹窗
    $("#textEditorClose").addEventListener("click", () => this.closeTextEditor());
    $("#textEditorCancel").addEventListener("click", () => this.closeTextEditor());
    $("#textEditorSave").addEventListener("click", () => this.saveTextEditor());
    $("#textEditorLayer").addEventListener("click", (event) => {
      if (event.target.id === "textEditorLayer") this.closeTextEditor();
    });
    document.addEventListener("keydown", (event) => {
      if ($("#textEditorLayer")?.hidden) return;
      if (event.key === "Escape") { event.preventDefault(); this.closeTextEditor(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.saveTextEditor();
      }
    });

    // 导入/导出已从左上角菜单移除（保留实现，供以后快捷键或菜单调用）
    $("#canvasImportInput")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) this.importCanvas(file);
    });

    // 拖文件进画布：上传成输入节点
    view.addEventListener("dragover", (event) => {
      if (State.viewMode !== "canvas") return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      view.classList.add("dropping");
    });
    view.addEventListener("dragleave", () => view.classList.remove("dropping"));
    view.addEventListener("drop", (event) => {
      event.preventDefault();
      view.classList.remove("dropping");
      if (State.viewMode !== "canvas" || this._dropping) return;
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      const rect = view.getBoundingClientRect();
      const point = {
        x: (event.clientX - rect.left - this.camera.x) / this.camera.zoom,
        y: (event.clientY - rect.top - this.camera.y) / this.camera.zoom,
      };
      this._dropping = true;
      this.uploadFiles(files, point).finally(() => { this._dropping = false; });
    });

    // 剪贴板：有复制过的节点就粘贴节点，有图片文件就上传成输入节点，纯文本生成文本节点
    document.addEventListener("paste", (event) => {
      if (State.viewMode !== "canvas") return;
      if (event.target?.closest?.("input, textarea, [contenteditable]")) return;
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) {
        event.preventDefault();
        this.uploadFiles(files, this.viewCenterWorld());
        return;
      }
      if (this.clipboard?.items?.length) {
        event.preventDefault();
        this.pasteNodes();
        return;
      }
      const text = (event.clipboardData?.getData("text/plain") || "").trim();
      if (text) {
        event.preventDefault();
        const center = this.viewCenterWorld();
        this.createTextNode({ text, x: center.x, y: center.y });
      }
    });

    // 双击空白 = 打开添加节点菜单
    view.addEventListener("dblclick", (event) => {
      if (event.target.closest(".cv-node, .canvas-toolbar, .cv-composer, .popover, .cv-minimap, .cv-edge")) return;
      const rect = view.getBoundingClientRect();
      this.openAddMenu(event.clientX, event.clientY, {
        x: (event.clientX - rect.left - this.camera.x) / this.camera.zoom,
        y: (event.clientY - rect.top - this.camera.y) / this.camera.zoom,
      });
    });

    // 工具栏：清空画布
    $("#canvasClear").addEventListener("click", () => this.clearCanvas());

    // ---- 小地图：点击/拖动定位（按画布元素精确换算，拖动期间冻结包围盒） ----
    const map = $("#cvMinimap");
    const canvas = $("#cvMinimapCanvas");
    const jump = (clientX, clientY) => {
      const bounds = this._miniDragBounds || this._minimapBounds;
      if (!bounds) return;
      const cRect = canvas.getBoundingClientRect();
      const mx = (clientX - cRect.left) * (canvas.width / cRect.width);
      const my = (clientY - cRect.top) * (canvas.height / cRect.height);
      const realX = bounds.minX + (mx - bounds.ox) / bounds.scale;
      const realY = bounds.minY + (my - bounds.oy) / bounds.scale;
      this.camera.x = view.clientWidth / 2 - realX * this.camera.zoom;
      this.camera.y = view.clientHeight / 2 - realY * this.camera.zoom;
      this.applyCamera();
    };
    map.addEventListener("pointerdown", (event) => {
      if (event.target.closest("#cvMinimapClose")) return;
      if (!this._minimapBounds) return;
      event.preventDefault();
      event.stopPropagation();
      this._miniDragBounds = { ...this._minimapBounds };
      jump(event.clientX, event.clientY);
      try { map.setPointerCapture(event.pointerId); } catch { /* 合成事件忽略 */ }
      const move = (ev) => jump(ev.clientX, ev.clientY);
      const stop = () => {
        this._miniDragBounds = null;
        this.saveCamera();
        try { map.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
        map.removeEventListener("pointermove", move);
        map.removeEventListener("pointerup", stop);
        map.removeEventListener("pointercancel", stop);
      };
      map.addEventListener("pointermove", move);
      map.addEventListener("pointerup", stop);
      map.addEventListener("pointercancel", stop);
    });
    // 可关闭 + 工具栏开关（记忆偏好）
    map.hidden = localStorage.getItem("wwdm-cv-minimap") === "off";
    $("#canvasMinimap").classList.toggle("active", !map.hidden);
    $("#cvMinimapClose").addEventListener("click", (event) => {
      event.stopPropagation();
      map.hidden = true;
      localStorage.setItem("wwdm-cv-minimap", "off");
      $("#canvasMinimap").classList.remove("active");
    });
    $("#canvasMinimap").addEventListener("click", () => {
      const show = map.hidden;
      map.hidden = !show;
      localStorage.setItem("wwdm-cv-minimap", show ? "on" : "off");
      $("#canvasMinimap").classList.toggle("active", show);
      if (show) this.queueMinimap();
    });
  },

  deleteAsset(id) {
    this.deleteNodes([id]);
  },

  /* 当前有没有进行中的指针手势（平移 / 框选 / 连线 / 拖节点 / 拖组 / 文本区待拖） */
  hasGesture() {
    return !!(this._pan || this._box || this._link || this._gmove || this._move || this._pendingDrag);
  },

  /* 把拖拽后的节点位置写回布局并保存 */
  persistDragPositions(items) {
    const layout = this.layout();
    let changed = false;
    (items || []).forEach((item) => {
      const node = this.byId(item.id);
      if (!node) return;
      layout.nodes[node.id] = { x: Math.round(node.x), y: Math.round(node.y) };
      changed = true;
    });
    if (changed) this.save();
  },

  /* 手势被打断（窗口失焦 / 指针取消 / 松手事件丢失）时就地收尾。
     不清理的话，画布或节点会一直跟着鼠标走 —— 就是「拖到全局」那个问题。 */
  abortGesture() {
    if (!this.hasGesture()) return;
    if (this._box) {
      const marquee = $("#canvasMarquee");
      if (marquee) marquee.hidden = true;
      this._box = null;
    }
    if (this._link) {
      $$(".cv-port.link-target").forEach((el) => el.classList.remove("link-target"));
      $$(".cv-node.linking, .cv-node.linking-target")
        .forEach((el) => el.classList.remove("linking", "linking-target"));
      this._link = null;
      this.drawEdges();
    }
    if (this._gmove) {
      if (this._gmove.moved) this.persistDragPositions(this._gmove.items);
      this._gmove = null;
    }
    if (this._move) {
      this.elOf(this._move.id)?.classList.remove("dragging");
      if (this._move.moved) this.persistDragPositions(this._move.items);
      this._move = null;
    }
    if (this._pan) {
      $("#canvasView")?.classList.remove("panning");
      this.saveCamera();
      this._pan = null;
    }
    this._pendingDrag = null;
    this._dragField = null;
    // 作品卡片拖拽时 _dragging 是个对象，别把它一起清掉
    if (Works._dragging === true) Works._dragging = false;
  },

  onPointerMove(event) {
    const view = $("#canvasView");
    const gesture = this._pan || this._box || this._link || this._gmove || this._move || this._pendingDrag;
    if (!gesture) return;
    // 多指 / 触控板另一根手指的事件不要串到当前手势上
    if (gesture.pointerId != null && event.pointerId != null && gesture.pointerId !== event.pointerId) return;
    // 松手事件丢了（在窗口外松开、指针捕获失败）：当成就地松手收尾，
    // 否则画布会一直跟着鼠标跑（以前「拖到全局」就是这个原因）
    if (event.buttons === 0) {
      this.onPointerUp(event);
      return;
    }
    if (this._box) {
      const rect = view.getBoundingClientRect();
      const left = Math.max(0, Math.min(this._box.sx, event.clientX) - rect.left);
      const top = Math.max(0, Math.min(this._box.sy, event.clientY) - rect.top);
      const width = Math.abs(event.clientX - this._box.sx);
      const height = Math.abs(event.clientY - this._box.sy);
      const marquee = $("#canvasMarquee");
      if (marquee) {
        marquee.hidden = false;
        marquee.style.left = `${Math.round(left)}px`;
        marquee.style.top = `${Math.round(top)}px`;
        marquee.style.width = `${Math.round(width)}px`;
        marquee.style.height = `${Math.round(height)}px`;
      }
      return;
    }
    if (this._gmove) {
      const dx = (event.clientX - this._gmove.sx) / this.camera.zoom;
      const dy = (event.clientY - this._gmove.sy) / this.camera.zoom;
      if (!this._gmove.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        this._gmove.moved = true;
        this.record();   // 组拖动前记录布局，可撤销
        try { view.setPointerCapture(this._gmove.pointerId); } catch { /* 忽略 */ }
      }
      if (!this._gmove.moved) return;
      this._gmove.items.forEach((item) => {
        const node = this.byId(item.id);
        if (!node) return;
        node.x = item.x + dx;
        node.y = item.y + dy;
        const el = this.elOf(item.id);
        if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
      });
      const groupEl = $(`.cv-group[data-group="${CSS.escape(this._gmove.id)}"]`);
      if (groupEl) {
        groupEl.style.left = `${Math.round(this._gmove.groupX + dx)}px`;
        groupEl.style.top = `${Math.round(this._gmove.groupY + dy)}px`;
      }
      this.drawEdges();
      window.CanvasComposer?.follow();
      return;
    }
    if (this._pan) {
      const dx = event.clientX - this._pan.sx;
      const dy = event.clientY - this._pan.sy;
      if (!this._pan.moved && Math.abs(dx) + Math.abs(dy) > 3) this._pan.moved = true;
      // 只是点一下空白：别因为手抖几个像素就把画布带走
      if (!this._pan.moved) return;
      this.camera.x = this._pan.cx + dx;
      this.camera.y = this._pan.cy + dy;
      this.applyCamera();
      return;
    }
    if (this._link) {
      if (Math.abs(event.clientX - this._link.sx) + Math.abs(event.clientY - this._link.sy) > 4) {
        this._link.moved = true;
      }
      const rect = view.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - this.camera.x) / this.camera.zoom;
      const worldY = (event.clientY - rect.top - this.camera.y) / this.camera.zoom;
      const start = this.portPos(this._link.from, "out");
      if (start) {
        this.drawEdges(this.curve(start, {
          x: worldX + this.EDGE_ORIGIN,
          y: worldY + this.EDGE_ORIGIN,
        }));
      }
      $$(".cv-port.link-target").forEach((el) => el.classList.remove("link-target"));
      const under2 = document.elementFromPoint(event.clientX, event.clientY);
      const hit = under2?.closest(".cv-port--in");
      const hoverNode = hit?.closest(".cv-node") || under2?.closest(".cv-node--gen");
      const hitNode = hoverNode?.dataset.node;
      if (hitNode && hitNode !== this._link.from) {
        (hit || hoverNode.querySelector(".cv-port--in"))?.classList.add("link-target");
        hoverNode.classList.add("linking-target");
      } else {
        $$(".cv-node.linking-target").forEach((el) => el.classList.remove("linking-target"));
      }
      return;
    }
    if (this._pendingDrag) {
      const pending = this._pendingDrag;
      if (Math.abs(event.clientX - pending.sx) + Math.abs(event.clientY - pending.sy) <= 4) return;
      this._pendingDrag = null;
      // 拖节点时别顺手选中一片文字
      try { this._dragField?.blur(); } catch { /* 已失焦 */ }
      this._dragField = null;
      window.getSelection()?.removeAllRanges();
      this._move = pending;
      Works._dragging = true;
    }
    if (this._move) {
      const dx = (event.clientX - this._move.sx) / this.camera.zoom;
      const dy = (event.clientY - this._move.sy) / this.camera.zoom;
      if (!this._move.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        this._move.moved = true;
        this.record();   // 记下拖动前的布局，Ctrl+Z 可以回到拖动前
        this.elOf(this._move.id)?.classList.add("dragging");
        try { view.setPointerCapture(this._move.pointerId); } catch { /* 指针已释放 */ }
      }
      if (!this._move.moved) return;
      this._move.items.forEach((item) => {
        const node = this.byId(item.id);
        if (!node) return;
        node.x = item.x + dx;
        node.y = item.y + dy;
        const el = this.elOf(item.id);
        if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
      });
      this.drawEdges();
      window.CanvasComposer?.follow();
    }
  },

  onPointerUp(event) {
    const view = $("#canvasView");
    // 只认发起手势的那根指针：别让另一根手指 / 合成事件提前结束当前手势
    const active = this._pan || this._box || this._link || this._gmove || this._move || this._pendingDrag;
    if (active?.pointerId != null && event?.pointerId != null && active.pointerId !== event.pointerId) return;
    // 文本区里只是点了一下：清掉「待拖」状态，别让它留到下一次
    if (this._pendingDrag) {
      this._pendingDrag = null;
      this._dragField = null;
    }
    if (this._box) {
      const rect = view.getBoundingClientRect();
      const marquee = $("#canvasMarquee");
      if (marquee) marquee.hidden = true;
      const box = this._box;
      this._box = null;
      if (Math.abs(event.clientX - box.sx) + Math.abs(event.clientY - box.sy) < 8) {
        this.setSelection([], "");
        return;
      }
      // 换算成世界坐标，选中与框相交的节点
      const rx1 = (Math.min(box.sx, event.clientX) - rect.left - this.camera.x) / this.camera.zoom;
      const ry1 = (Math.min(box.sy, event.clientY) - rect.top - this.camera.y) / this.camera.zoom;
      const rx2 = (Math.max(box.sx, event.clientX) - rect.left - this.camera.x) / this.camera.zoom;
      const ry2 = (Math.max(box.sy, event.clientY) - rect.top - this.camera.y) / this.camera.zoom;
      const inside = this.nodes
        .filter((node) => node.type !== "view" && node.x < rx2 && node.x + node.w > rx1
          && node.y < ry2 && node.y + node.h > ry1)
        .map((node) => node.id);
      // Shift 是在现有选择上追加，普通框选直接替换
      const ids = event.shiftKey
        ? [...new Set([...this.selection, ...inside])]
        : inside;
      this.setSelection(ids, inside[0] || "");
      return;
    }
    if (this._link) {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const hit = under?.closest(".cv-port--in");
      // 落到创作节点卡面上也算接入（端口太小不好瞄）
      const hoverNode = hit?.closest(".cv-node") || under?.closest(".cv-node--gen");
      const target = hoverNode?.dataset.node;
      const from = this._link.from;
      const moved = this._link.moved;
      const rect = view.getBoundingClientRect();
      // 松在画布外面（侧栏 / 工具栏 / 窗口外）：只收尾，不建节点
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      const worldPoint = {
        x: (event.clientX - rect.left - this.camera.x) / this.camera.zoom,
        y: (event.clientY - rect.top - this.camera.y) / this.camera.zoom,
      };
      $$(".cv-port.link-target").forEach((el) => el.classList.remove("link-target"));
      $$(".cv-node.linking, .cv-node.linking-target").forEach((el) => el.classList.remove("linking", "linking-target"));
      this._link = null;
      this.drawEdges();
      if (target && target !== from) this.addEdge(from, target);
      else if (under?.closest(".cv-node")) {
        toast("连线要落到创作节点上（左侧圆点或卡片）", true);
      } else if (!outside && !under?.closest(".cv-composer, .popover, .canvas-toolbar")) {
        // 松在空白处：直接建合一创作节点（类型可在创作区里切换）
        // 只是点了一下端口（没拖动）就建在源节点右侧，避免和源节点重叠
        this.createGenNode("image", moved
          ? { fromIds: [from], x: worldPoint.x, y: worldPoint.y }
          : { fromIds: [from], near: from });
      }
    }
    if (this._gmove) {
      if (this._gmove.moved) this.persistDragPositions(this._gmove.items);
      this._gmove = null;
    }
    if (this._move) {
      this.elOf(this._move.id)?.classList.remove("dragging");
      if (this._move.moved) {
        this._justMoved = this._move.id;
        clearTimeout(this._justMovedTimer);
        this._justMovedTimer = setTimeout(() => { this._justMoved = ""; }, 80);
        this.persistDragPositions(this._move.items);
      }
      this._move = null;
    }
    if (this._pan) {
      const wasClick = !this._pan.moved;
      this._pan = null;
      view.classList.remove("panning");
      this.saveCamera();
      if (wasClick) this.setSelection([], "");
    }
    // 手势全部结束：恢复轮询重建 DOM（否则进度刷新会一直停着）
    if (!this.hasGesture() && Works._dragging === true) Works._dragging = false;
  },
};

// 顶层 const 不会自动成为 window 属性，显式暴露给 Works / Main 调用
window.Canvas = Canvas;
