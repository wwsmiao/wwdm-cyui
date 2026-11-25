/* 启动编排：装配各模块 + 顶栏杂项 + 统一轮询 */
window.Main = {
  refreshAll() {
    Works.reset();
    Works.load().catch(() => {});
    Monitor.refreshStats().catch(() => {});
    Notes.refresh();
  },
};

async function initSettings() {
  const modal = $("#settingsModal");
  const close = () => { modal.hidden = true; };

  /* 当前实例能干什么：节点数 + 哪些工作流跑不起来（远程实例最常见的就是缺自定义节点） */
  const refreshInstance = async () => {
    const box = $("#comfyInstanceNote");
    if (!box) return;
    box.textContent = "正在检查当前实例…";
    box.classList.remove("warn");
    try {
      const status = await API.comfyStatus();
      const inst = status.instance || {};
      const parts = [status.online ? "实例在线" : "实例离线"];
      if (inst.local === false) parts.push("远程");
      else if (inst.local === true) parts.push("本机");
      if (inst.node_count) parts.push(`${inst.node_count} 个节点`);
      if (inst.unavailable?.length) {
        parts.push(`${inst.unavailable.length} 个工作流跑不起来：` +
          inst.unavailable.map((item) => item.name).join("、"));
        box.classList.add("warn");
      } else if (inst.workflow_count) {
        parts.push(`${inst.workflow_count} 个工作流全部可用`);
      }
      box.textContent = parts.join(" · ");
    } catch (error) {
      box.textContent = `当前实例检查失败：${error.message}`;
      box.classList.add("warn");
    }
  };
  window.Main.refreshInstance = refreshInstance;

  const load = async () => {
    try {
      const settings = await API.settings();
      if (settings.workflow_params && Object.keys(settings.workflow_params).length) {
        WorkflowParams.data = {
          ...WorkflowParams.data,
          ...Object.fromEntries(Object.entries(settings.workflow_params).map(
            ([id, values]) => [id, { ...(WorkflowParams.data[id] || {}), ...values }]
          )),
        };
      }
      $("#comfyUrlInput").value = settings.comfy_url || "";
      $("#comfyUrlInput").dataset.loaded = settings.comfy_url || "";
      $("#comfyDirInput").value = settings.comfy_dir || "";
      $("#clientIdInput").value = settings.client_id || "";
      $("#timeoutInput").value = settings.task_timeout || 1800;
    } catch { /* 加载失败时保留输入框当前内容 */ }
  };

  $("#settingsBtn").addEventListener("click", async () => {
    await load();
    modal.hidden = false;
    refreshInstance();
  });
  $("#settingsClose").addEventListener("click", close);
  $("#settingsCancel").addEventListener("click", close);
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) close();
  });

  $("#settingsMenu").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-section]");
    if (!btn) return;
    $$("#settingsMenu button").forEach((node) => node.classList.toggle("active", node === btn));
    $$(".settings-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== btn.dataset.section;
    });
    if (btn.dataset.section === "workflow" || btn.dataset.section === "video") WorkflowParams.load().catch(() => {});
    if (btn.dataset.section === "manifest") Manifest.load().catch(() => {});
    if (btn.dataset.section === "templates") PromptTemplates.load().catch(() => {});
    if (btn.dataset.section === "prompt") PromptParams.load().catch(() => {});
  });

  // 关于页：微信号 / QQ / 群号点一下就能复制
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-about-copy]");
    if (!target) return;
    const text = target.dataset.aboutCopy || "";
    navigator.clipboard?.writeText(text).then(
      () => toast(`已复制：${text}`),
      () => toast("复制失败", true),
    );
  });

  $("#settingsSave").addEventListener("click", async () => {
    try {
      const payload = {
        comfy_url: $("#comfyUrlInput").value.trim() || "http://127.0.0.1:8188",
        comfy_dir: $("#comfyDirInput").value.trim(),
        client_id: $("#clientIdInput").value.trim() || "wwdm-comfy-proxy",
        task_timeout: Number($("#timeoutInput").value) || 1800,
      };
      if (typeof Agent !== "undefined" && Agent.cfg) payload.agent = Agent.collectForm();
      if (WorkflowParams.loaded) payload.workflow_params = WorkflowParams.values();
      if (PromptParams.loaded) payload.prompt_params = PromptParams.values();
      await API.saveSettings(payload);
      // 保存后停留在设置弹窗，仅用按钮状态反馈，用户自己关闭才退出
      const saveBtn = $("#settingsSave");
      saveBtn.textContent = "已保存";
      saveBtn.classList.add("saved");
      clearTimeout(saveBtn._timer);
      saveBtn._timer = setTimeout(() => {
        saveBtn.textContent = "保存";
        saveBtn.classList.remove("saved");
      }, 1600);
      toast("设置已保存");
      Monitor.refreshStats();
      // 换了 ComfyUI 地址：模型清单和实例能力都要重新拉，否则下拉框还是旧实例的文件名
      const prevUrl = $("#comfyUrlInput").dataset.loaded || "";
      const urlChanged = payload.comfy_url !== prevUrl;
      if (urlChanged) {
        $("#comfyUrlInput").dataset.loaded = payload.comfy_url;
        WorkflowParams.loaded = false;
        await Composer.loadWorkflows().catch(() => {});
      }
      if (WorkflowParams.loaded || urlChanged) WorkflowParams.load(true).catch(() => {});
      refreshInstance();
    } catch (error) {
      Dialog.warn({ title: "操作失败", message: error.message });
    }
  });
}

function initTopbar() {
  const applyZoom = () => {
    if (State.viewMode === "canvas") {
      window.Canvas?.setZoom(State.zoom);
      return;
    }
    $("#worksGrid").style.zoom = State.zoom;
    State.cardZoom = State.zoom;
    $("#zoomLabel").textContent = `${Math.round(State.zoom * 100)}%`;
  };
  $("#zoomIn").addEventListener("click", () => { State.zoom = Math.min(2, State.zoom + .1); applyZoom(); });
  $("#zoomOut").addEventListener("click", () => { State.zoom = Math.max(.5, State.zoom - .1); applyZoom(); });

  $("#filterBtn").addEventListener("click", () => Dialog.info({
    title: "筛选", message: "当前显示全部作品。",
  }));
  $("#searchBtn").addEventListener("click", () => Dialog.info({
    title: "搜索", message: "搜索功能将在后续版本开放。",
  }));
  $("#tidyBtn").addEventListener("click", () => {
    if (State.viewMode === "canvas") window.Canvas?.tidy();
    else Works.tidy();
  });
}

async function bootstrap() {
  Dialog.init();
  Projects.bind();
  Works.bind();
  window.Canvas?.init();
  window.CanvasComposer?.init();
  CardMenu.init();
  // 局部重绘弹窗（作品卡片 → 画面修复 → 局部重绘）
  if (typeof MaskEditor !== "undefined") MaskEditor.init();
  // AI Agent（独立模块：悬浮球 + 面板 + 设置接入）
  if (typeof Agent !== "undefined") Agent.init();
  // 工作台内联编辑器（顶层 const，不挂 window，直接按标识符调用）
  if (typeof WbEdit !== "undefined") WbEdit.init();
  Notes.init();
  PromptTemplates.init();
  Monitor.init();
  Gallery.init();
  Picker.init();
  AssetLib.init();
  initTopbar();
  await initSettings();

  try {
    await Projects.load();
    await Composer.init();
    await Works.load();
    await Monitor.refreshStats();
  } catch (error) {
    Dialog.warn({ title: "操作失败", message: error.message });
  }

  // 刷新后停在离开时的页面（文本 / 卡片 / 画布）：
  // State.viewMode 启动时已经按 localStorage 初始化，这里必须无条件应用一次，
  // 才能把顶部按钮、笔记区、画布相机都切到正确状态
  if (["text", "card", "canvas"].includes(State.viewMode)) {
    Works.setViewMode(State.viewMode);
  }

  setInterval(() => {
    Works.load().catch(() => {});
    Monitor.refreshStats().catch(() => {});
    window.Composer?.updateSendButton();   // 任务结束后按钮自动从「停止」变回「生成」
  }, 1500);
}

document.addEventListener("DOMContentLoaded", bootstrap);
