/* 统一小弹窗：确认 / 信息 / 警告，返回 Promise */
const Dialog = {
  resolver: null,

  init() {
    $("#dialogLayer").addEventListener("click", (event) => {
      if (event.target.id === "dialogLayer") this.close(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#dialogLayer").hidden) this.close(false);
    });
  },

  open(options) {
    return new Promise((resolve) => {
      const opts = {
        title: "提示", message: "", type: "info",
        confirmText: "确定", cancelText: "取消", showCancel: false,
        danger: false, ...options,
      };
      this.resolver = resolve;
      const layer = $("#dialogLayer");
      const iconMap = {
        info: ["i-info", "info"],
        warn: ["i-alert", "warn"],
        danger: ["i-trash", "danger"],
        confirm: ["i-trash", "danger"],
      };
      const [symbol, cls] = iconMap[opts.type] || iconMap.info;
      $("#dialogIcon").className = `dialog-icon ${opts.danger || opts.type === "danger" || opts.type === "confirm" ? "danger" : cls}`;
      $("#dialogIcon").innerHTML = icon(symbol);
      $("#dialogTitle").textContent = opts.title;
      $("#dialogMessage").textContent = opts.message;

      const actions = $("#dialogActions");
      actions.innerHTML = `
        ${opts.showCancel ? `<button class="soft-btn" data-dialog="cancel">${escapeHtml(opts.cancelText)}</button>` : ""}
        <button class="${opts.danger || opts.type === "danger" || opts.type === "confirm" ? "btn-danger" : "primary-btn"}" data-dialog="ok">${escapeHtml(opts.confirmText)}</button>`;
      actions.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => this.close(btn.dataset.dialog === "ok"));
      });
      layer.hidden = false;
      actions.querySelector('[data-dialog="ok"]')?.focus();
    });
  },

  /* 输入框弹窗：用于新建 / 重命名分类等，返回输入值或 null */
  prompt(options = {}) {
    return new Promise((resolve) => {
      const opts = {
        title: "输入", label: "", value: "", placeholder: "",
        confirmText: "确定", cancelText: "取消", ...options,
      };
      const layer = $("#promptLayer");
      const input = $("#promptField");
      $("#promptTitle").textContent = opts.title;
      $("#promptLabel").textContent = opts.label;
      $("#promptLabel").hidden = !opts.label;
      $("#promptOk").textContent = opts.confirmText;
      $("#promptCancel").textContent = opts.cancelText;
      input.value = opts.value || "";
      input.placeholder = opts.placeholder || "";
      layer.hidden = false;
      input.focus();
      input.select();

      const finish = (value) => {
        layer.hidden = true;
        $("#promptOk").removeEventListener("click", ok);
        $("#promptCancel").removeEventListener("click", cancel);
        input.removeEventListener("keydown", onKey);
        resolve(value);
      };
      const ok = () => finish(input.value.trim());
      const cancel = () => finish(null);
      const onKey = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); ok(); }
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
      };
      $("#promptOk").addEventListener("click", ok);
      $("#promptCancel").addEventListener("click", cancel);
      input.addEventListener("keydown", onKey);
    });
  },

  confirm(options) {
    return this.open({ type: "danger", showCancel: true, confirmText: "删除", ...options });
  },

  info(options) {
    return this.open({ type: "info", showCancel: false, confirmText: "知道了", ...options });
  },

  /* 纯文本查看（提示词 txt）：保留换行，可选中复制 */
  text(options = {}) {
    return this.open({ type: "info", showCancel: false, confirmText: "关闭", ...options });
  },

  warn(options) {
    return this.open({ type: "warn", showCancel: false, confirmText: "知道了", ...options });
  },

  close(result) {
    const layer = $("#dialogLayer");
    if (layer.hidden) return;
    layer.hidden = true;
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.(result);
  },
};
