/* 设置 → 项目清单：列出本项目需要的 ComfyUI 版本、自定义节点与模型来源。
   数据由后端 /api/manifest 从工作流图扫出来，再套人工维护的仓库地址表。 */
const Manifest = {
  data: null,

  async load(force = false) {
    const box = $("#manifestBody");
    if (this.data && !force) return this.render();
    if (box) box.innerHTML = `<div class="wf-empty">正在整理清单…</div>`;
    try {
      this.data = await API.manifest();
    } catch (error) {
      if (box) box.innerHTML = `<div class="wf-empty">清单读取失败：${escapeHtml(error.message)}</div>`;
      return;
    }
    this.render();
  },

  row({ name, meta = "", repo = "", repoLabel = "仓库", install = "", status = "", emptyText = "" }) {
    const statusHtml = status
      ? `<em class="mf-status ${status === "实例缺" || status === "当前实例缺" ? "miss" : ""}">${escapeHtml(status)}</em>`
      : "";
    const link = repo
      ? `<a class="about-link" href="${escapeHtml(repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoLabel)} →</a>`
      : (emptyText ? `<span class="mf-muted">${escapeHtml(emptyText)}</span>` : "");
    const copy = install
      ? `<button type="button" class="soft-btn mf-copy" data-mf-copy="${escapeHtml(install)}" title="复制到 custom_nodes 里执行">复制命令</button>`
      : "";
    return `
      <div class="mf-row">
        <div class="mf-main">
          <div class="mf-title"><b>${escapeHtml(name)}</b>${statusHtml}</div>
          ${meta ? `<div class="mf-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
        <div class="mf-side">${link}${copy}</div>
      </div>`;
  },

  group(title, rows) {
    if (!rows || !rows.length) return "";
    return `
      <div class="mf-group">
        <div class="mf-group-head">${escapeHtml(title)}<span>${rows.length}</span></div>
        ${rows.join("")}
      </div>`;
  },

  render() {
    const box = $("#manifestBody");
    if (!box || !this.data) return;
    const core = this.data.core || {};
    const parts = [];

    parts.push(this.group("运行环境", [this.row({
      name: `${core.name || "ComfyUI"} ≥ ${core.min_version || "0.44"}`,
      meta: core.note || "",
      repo: core.repo || "",
      repoLabel: "官方仓库",
    })]));

    const plugins = this.data.plugins || [];
    parts.push(this.group("自定义节点", plugins.map((item) => this.row({
      name: item.name,
      meta: [item.purpose,
        item.nodes?.length ? `节点：${item.nodes.join("、")}` : "",
        item.workflows?.length ? `用于：${item.workflows.join("、")}` : ""].filter(Boolean).join(" · "),
      repo: item.repo,
      repoLabel: "GitHub",
      install: item.install,
      status: item.installed === true ? "已安装" : item.installed === false ? "当前实例缺" : "",
    }))));

    for (const section of this.data.groups || []) {
      parts.push(this.group(`模型 · ${section.folder}`, section.items.map((item) => this.row({
        name: item.name,
        meta: [`放 ComfyUI/models/${item.folder}`,
          item.optional ? "可选，没有会自动跳过" : "",
          item.workflows?.length ? `用于：${item.workflows.join("、")}` : "",
          item.note || ""].filter(Boolean).join(" · "),
        repo: item.repo,
        repoLabel: "模型地址",
        emptyText: "自备文件（无公开地址）",
        status: item.present === true ? "实例已有" : item.present === false ? "实例缺" : "",
      }))));
    }

    const totalModels = (this.data.models || []).length;
    box.innerHTML = `
      <p class="mf-summary">共 ${plugins.length} 个节点包 · ${totalModels} 个模型文件。
        状态按当前连接的 ComfyUI 实例判断；换实例后点右上角「重新读取」即可刷新。</p>
      <div class="mf-toolbar"><button class="soft-btn" id="mfReload">重新读取</button></div>
      ${parts.join("")}`;
    $("#mfReload")?.addEventListener("click", () => this.load(true));
    this.bindCopy(box);
  },

  bindCopy(box) {
    box.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-mf-copy]");
      if (!btn) return;
      const text = btn.dataset.mfCopy || "";
      navigator.clipboard?.writeText(text).then(
        () => {
          const old = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(() => { btn.textContent = old; }, 1200);
        },
        () => toast("复制失败，可手动选中命令", true),
      );
    });
  },
};
