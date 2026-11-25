/* ============ AI Agent（独立模块）：悬浮球 + 右侧可伸缩面板 + 设置接入 ============ */
const Agent = {
  cfg: null,
  messages: [],
  pendingImages: [],
  busy: false,
  opened: false,
  mode: "dock",           // dock | full
  width: 420,
  drag: null,
  skills: [
    { title: "一键出图", desc: "建提示词节点 + 创作节点 + 连线 + 提交", art: "⚡", tint: "linear-gradient(140deg,#3a4a2a,#6a8f3a)", prompt: "在画布上给我搭一条最简流程：一个提示词节点写上「窗台上的橘猫，午后柔光，浅景深」，再建一个图片创作节点连过去，用最合适的文生图工作流，然后直接提交生成。" },
    { title: "批量出四版", desc: "同一提示词出四个不同风格节点", art: "🎛", tint: "linear-gradient(140deg,#2a2f3a,#4a6a8f)", prompt: "用同一个主体提示词，在画布上并排建 4 个创作节点，分别对应写实、国风、电影感、插画四种风格（提示词你来改），都连到同一个提示词节点，然后一起提交。" },
    { title: "调 LoRA 风格", desc: "换 LoRA 槽位与权重再出图", art: "🧬", tint: "linear-gradient(140deg,#3a2a3e,#8f4a8a)", prompt: "先告诉我当前图片工作流里有哪些 LoRA 可用，然后给我的创作节点配一个合适的人像 LoRA（权重 0.8），再提交生成。" },
    { title: "参数调优", desc: "步数 / CFG / 采样器对比出图", art: "🎚", tint: "linear-gradient(140deg,#3a3226,#8f7a4a)", prompt: "帮我把当前图片工作流调成适合人像写真的参数（步数、CFG、采样器），说明理由，然后重新生成一张。" },
    { title: "参考图改造", desc: "把画布上的素材接到创作节点再生成", art: "🖼", tint: "linear-gradient(140deg,#2a3a3a,#4a8f8a)", prompt: "看看我画布上有没有图片素材，把它连到一个图生图的创作节点，写一段合适的提示词，然后提交生成。" },
    { title: "整理画布", desc: "把散乱的节点按依赖关系排好", art: "🧹", tint: "linear-gradient(140deg,#2a2a30,#5a6a8a)", prompt: "帮我整理一下画布，节点不要重叠，按依赖从左到右排列，然后告诉我每个节点是干什么的。" },
    { title: "高清放大", desc: "接上分块放大工作流出一张大图", art: "🔍", tint: "linear-gradient(140deg,#33302a,#8a7a5a)", prompt: "把画布上最新的那张作品，接到高清放大工作流放大 2 倍，然后提交。" },
    { title: "分镜脚本", desc: "把一句话拆成三个镜头节点", art: "🎬", tint: "linear-gradient(140deg,#2a2a3a,#7a4a8f)", prompt: "把我接下来这句话拆成三个镜头的视频创作节点，排成一排并各自写好镜头提示词：" },
  ],
  visibleSkills: [],

  /* ---------------- 初始化 ---------------- */
  init() {
    if (!$("#agentOrb")) return;
    this.orb = $("#agentOrb");
    this.layer = $("#agentLayer");
    this.panel = $("#agentPanel");
    this.body = $("#agentBody");
    this.input = $("#agentInput");
    this.visibleSkills = this.pickSkills();
    this.bindOrb();
    this.bindPanel();
    this.bindSettings();
    this.restoreLayout();
    this.renderWelcome();
    this.loadConfig();
  },

  async loadConfig() {
    try {
      this.cfg = await API.agentConfig();
    } catch {
      this.cfg = null;
    }
    this.syncChrome();
    this.renderWelcome();
  },

  configured() {
    return !!this.cfg?.api_key;
  },

  syncChrome() {
    const tag = $("#agentModelTag");
    if (tag) tag.textContent = this.configured() ? (this.cfg.model || "未选模型") : "未接入";
    const head = $("#agentHeadModel");
    if (head) head.textContent = this.configured() ? this.cfg.model || "" : "";
    this.orb.classList.toggle("hidden", this.cfg ? this.cfg.enabled === false : false);
  },

  /* ---------------- 悬浮球：拖动 + 点击 ---------------- */
  bindOrb() {
    let start = null;
    this.orb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const rect = this.orb.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      try { this.orb.setPointerCapture(event.pointerId); } catch { /* 合成事件没有真实指针 */ }
      this.orb.classList.add("dragging");
    });
    this.orb.addEventListener("pointermove", (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      const size = this.orb.offsetWidth || 54;
      const left = Math.min(window.innerWidth - size - 6, Math.max(6, start.left + dx));
      const top = Math.min(window.innerHeight - size - 6, Math.max(6, start.top + dy));
      this.orb.style.left = `${left}px`;
      this.orb.style.top = `${top}px`;
      this.orb.style.right = "auto";
      this.orb.style.bottom = "auto";
    });
    const finish = () => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      this.orb.classList.remove("dragging");
      if (moved) {
        const rect = this.orb.getBoundingClientRect();
        localStorage.setItem("wwdm-agent-orb", JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
      } else {
        this.toggle();
      }
    };
    this.orb.addEventListener("pointerup", finish);
    this.orb.addEventListener("pointercancel", finish);
    window.addEventListener("resize", () => this.clampOrb());
  },

  clampOrb() {
    const rect = this.orb.getBoundingClientRect();
    const size = this.orb.offsetWidth || 54;
    if (rect.top > window.innerHeight - size || rect.left > window.innerWidth - size) {
      this.orb.style.left = `${Math.max(6, window.innerWidth - size - 24)}px`;
      this.orb.style.top = `${Math.max(6, window.innerHeight - size - 96)}px`;
      this.orb.style.right = "auto";
      this.orb.style.bottom = "auto";
    }
  },

  /* ---------------- 面板 ---------------- */
  bindPanel() {
    $("#agentClose").addEventListener("click", () => this.close());
    $("#agentToggleFull").addEventListener("click", () => this.setMode(this.mode === "full" ? "dock" : "full"));
    $("#agentSend").addEventListener("click", () => this.send());
    $("#agentInputExpand").addEventListener("click", () => this.setMode("full"));
    $("#agentAttachBtn").addEventListener("click", () => $("#agentFile").click());
    // 工具行：Skills（今晚只做入口文案，技能体系待接入）/ 语音 / 模型标签
    $(".agent-tools")?.addEventListener("click", (event) => {
      const tool = event.target.closest("[data-agent-tool]");
      if (!tool) return;
      if (tool.dataset.agentTool === "skill") this.openSkills();
      if (tool.dataset.agentTool === "mic") this.toggleVoice();
    });
    $("#agentModelTag")?.addEventListener("click", () => this.openSettings());
    $("#agentFile").addEventListener("change", (event) => {
      this.addImages([...(event.target.files || [])]);
      event.target.value = "";
    });
    $("#agentInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });
    $("#agentInput").addEventListener("input", () => this.autosize());
    $("#agentInput").addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      this.addImages(files);
    });
    this.body.addEventListener("click", (event) => {
      const skill = event.target.closest("[data-skill]");
      if (skill) return this.useSkill(Number(skill.dataset.skill));
      if (event.target.closest("[data-agent-shuffle]")) {
        this.visibleSkills = this.pickSkills();
        return this.renderWelcome();
      }
      if (event.target.closest("[data-agent-setup]")) return this.openSettings();
      const copy = event.target.closest("[data-agent-copy]");
      if (copy) {
        const text = this.messages[Number(copy.dataset.agentCopy)]?.content;
        if (typeof text === "string") navigator.clipboard?.writeText(text).then(() => toast("已复制"));
      }
    });
    this.layer.addEventListener("click", (event) => {
      if (event.target === this.layer && this.mode === "full") this.setMode("dock");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.opened && event.target.closest("#agentPanel, #agentInput")) this.close();
    });
    this.bindResize();
  },

  bindResize() {
    const handle = $("#agentResize");
    let start = null;
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      start = { x: event.clientX, width: this.panel.offsetWidth };
      try { handle.setPointerCapture(event.pointerId); } catch { /* 合成事件没有真实指针 */ }
      document.body.style.cursor = "ew-resize";
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start) return;
      const next = Math.min(760, Math.max(340, start.width - (event.clientX - start.x)));
      this.width = next;
      this.panel.style.setProperty("--agent-w", `${next}px`);
    });
    const stop = () => {
      if (!start) return;
      start = null;
      document.body.style.cursor = "";
      localStorage.setItem("wwdm-agent-width", String(this.width));
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  },

  restoreLayout() {
    try {
      const pos = JSON.parse(localStorage.getItem("wwdm-agent-orb") || "null");
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        this.orb.style.left = `${pos.x}px`;
        this.orb.style.top = `${pos.y}px`;
        this.orb.style.right = "auto";
        this.orb.style.bottom = "auto";
      }
    } catch { /* 位置坏了就用默认位置 */ }
    const width = Number(localStorage.getItem("wwdm-agent-width")) || 420;
    this.width = Math.min(760, Math.max(340, width));
    this.panel.style.setProperty("--agent-w", `${this.width}px`);
  },

  toggle() {
    if (this.opened) this.close();
    else this.openPanel();
  },

  openPanel() {
    this.opened = true;
    this.orb.classList.add("away");
    this.layer.hidden = false;
    requestAnimationFrame(() => this.layer.classList.add("open"));
    if (!this.messages.length) this.renderWelcome();
    setTimeout(() => this.input.focus(), 260);
  },

  close() {
    this.stopVoice();
    try { window.speechSynthesis?.cancel(); } catch { /* 忽略 */ }
    this.opened = false;
    this.orb.classList.remove("away");
    this.layer.classList.remove("open");
    this.setMode("dock", true);
    setTimeout(() => {
      if (!this.opened) this.layer.hidden = true;
    }, 260);
  },

  setMode(mode, silent = false) {
    this.mode = mode;
    this.layer.dataset.mode = mode;
    $("#agentToggleFull")?.classList.toggle("active", mode === "full");
    if (!silent && mode === "full") setTimeout(() => this.input.focus(), 200);
  },

  /* 技能库入口：今晚只做入口，技能体系下一版接 */
  openSkills() {
    Dialog.info({
      title: "技能库（准备中）",
      message: "技能库还在准备中，下一版接入。\n现在直接说需求就行，我可以帮你在画布上建节点、配工作流、调 LoRA、提交生成。",
    });
  },

  /* ---------------- 语音对话 ---------------- */
  voiceActive: false,

  voiceSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  toggleVoice() {
    if (this.voiceActive) return this.stopVoice();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      return Dialog.warn({
        title: "这个浏览器不支持语音输入",
        message: "建议用 Edge 或 Chrome。也可以直接把想说的打出来。",
      });
    }
    if (this.busy) return toast("等这次回复结束再说话", true);

    const rec = new Recognition();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = this.input.value.trim();
    let finalText = "";
    let failed = "";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      this.input.value = `${base}${base && (finalText || interim) ? " " : ""}${finalText}${interim}`.trim();
      this.autosize();
      this.scrollToEnd();
    };
    rec.onerror = (event) => {
      failed = {
        "not-allowed": "没有麦克风权限，请在浏览器地址栏允许后重试",
        "service-not-allowed": "系统没有开放语音服务",
        "no-speech": "没听清，再说一次？",
        network: "语音识别需要联网（浏览器自带服务）",
        aborted: "",
      }[event.error] || `语音识别出错：${event.error}`;
    };
    rec.onend = () => {
      this.stopVoice();
      if (failed) {
        if (failed) toast(failed, true);
        return;
      }
      if (this.input.value.trim()) this.send();
    };

    try {
      rec.start();
    } catch (error) {
      return toast(`麦克风启动失败：${error.message}`, true);
    }
    this.voiceRec = rec;
    this.voiceActive = true;
    this.orb.classList.add("thinking");
    const btn = $(".agent-mic");
    btn?.classList.add("listening");
    btn?.setAttribute("title", "正在听…再点一下结束");
    $(".agent-input")?.classList.add("listening");
    $("#agentInput")?.setAttribute("placeholder", "我在听，说吧…");
  },

  stopVoice() {
    this.voiceActive = false;
    try { this.voiceRec?.stop(); } catch { /* 已经停了 */ }
    this.voiceRec = null;
    this.orb.classList.remove("thinking");
    const btn = $(".agent-mic");
    btn?.classList.remove("listening");
    btn?.setAttribute("title", "语音输入（点一下开始说话）");
    $(".agent-input")?.classList.remove("listening");
    $("#agentInput")?.setAttribute("placeholder", "描述你想创作的内容…");
  },

  /* 回复朗读（语音对话模式，默认关） */
  speak(text) {
    if (localStorage.getItem("wwdm-agent-voice-reply") !== "1") return;
    if (!window.speechSynthesis || !text) return;
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, "代码块")
      .replace(/[#*`>_-]/g, "")
      .replace(/\n+/g, "。")
      .slice(0, 320);
    try {
      speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = "zh-CN";
      utter.rate = 1.05;
      speechSynthesis.speak(utter);
    } catch { /* 浏览器不支持就静默 */ }
  },

  openSettings() {
    this.close();
    $("#settingsBtn")?.click();
    setTimeout(() => {
      $$("#settingsMenu button").forEach((btn) => {
        if (btn.dataset.section === "agent") btn.click();
      });
    }, 120);
  },

  /* ---------------- 欢迎态 ---------------- */
  pickSkills() {
    const pool = [...this.skills];
    const picked = [];
    while (picked.length < 4 && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picked;
  },

  renderWelcome() {
    if (this.messages.length) return;
    const ready = this.configured();
    this.body.classList.add("is-welcome");
    this.body.innerHTML = `
      <div class="agent-hello">
        <div class="agent-greet">Hi，我是薇薇</div>
        <h2>今天想画点什么？</h2>
        <div class="agent-skill-head">专业技能 <span class="agent-new">NEW</span></div>
        <div class="agent-skills">
          ${this.visibleSkills.map((skill, index) => `
            <button class="agent-skill" data-skill="${index}">
              <span class="agent-skill-art" style="background:${skill.tint}">${skill.art}</span>
              <b>${escapeHtml(skill.title)}</b>
              <em>${escapeHtml(skill.desc)}</em>
            </button>`).join("")}
        </div>
        <div class="agent-skill-more">
          <button data-agent-shuffle>${icon("rotate")}换一批</button>
        </div>
        ${ready ? "" : `<div class="agent-setup-tip">
          还没接入模型。到 <b>设置 → AI Agent</b> 填接口地址和 API Key 就能开始对话。
          <br><button data-agent-setup>去配置</button>
        </div>`}
        <p class="agent-cap">接入后我可以直接操作画布：建提示词节点、建创作节点、连线、挑工作流、
        配 LoRA 与步数 CFG、提交生成。${ready ? "" : ""}</p>
      </div>`;
  },

  useSkill(index) {
    const skill = this.visibleSkills[index];
    if (!skill) return;
    this.input.value = skill.prompt;
    this.autosize();
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  },

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(168, Math.max(42, this.input.scrollHeight))}px`;
  },

  /* ---------------- 图片附件 ---------------- */
  async addImages(files) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    for (const file of images.slice(0, 4)) {
      if (file.size > 6 * 1024 * 1024) {
        toast("图片超过 6MB，先压缩一下", true);
        continue;
      }
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (url) this.pendingImages.push(url);
    }
    this.renderAttachments();
  },

  renderAttachments() {
    const box = $("#agentAttach");
    box.hidden = !this.pendingImages.length;
    box.innerHTML = this.pendingImages.map((url, index) => `
      <span class="thumb">
        <img src="${url}" alt="">
        <button data-drop-image="${index}" title="移除">${icon("close")}</button>
      </span>`).join("");
    $$("[data-drop-image]", box).forEach((btn) => {
      btn.addEventListener("click", () => {
        this.pendingImages.splice(Number(btn.dataset.dropImage), 1);
        this.renderAttachments();
      });
    });
  },

  /* ---------------- 对话 ---------------- */
  async send() {
    const text = this.input.value.trim();
    if (this.busy) return;
    if (!text && !this.pendingImages.length) return;
    if (!this.configured()) {
      return Dialog.warn({
        title: "还没接入模型",
        message: "先到 设置 → AI Agent 填好接口地址、API Key 和模型，再回来对话。",
      });
    }
    const images = [...this.pendingImages];
    const content = images.length
      ? [{ type: "text", text: text || "看看这些图，给我一些创作建议。" },
         ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
      : text;

    this.messages.push({ role: "user", content });
    this.input.value = "";
    this.pendingImages = [];
    this.renderAttachments();
    this.autosize();
    this.renderMessages();

    this.busy = true;
    this.orb.classList.add("thinking");
    $("#agentSend").disabled = true;
    const bubble = this.appendPending();
    try {
      const result = await this.runAgentLoop();
      this.messages.push({ role: "assistant", content: result.reply });
      this.typewrite(bubble, result.reply);
      this.speak(result.reply);
      if (result.model) $("#agentHeadModel").textContent = result.model;
      this.saveHistory();
    } catch (error) {
      bubble.innerHTML = `<p style="color:#e29a9a">${escapeHtml(error.message)}</p>`;
      this.messages.pop();
    } finally {
      this.busy = false;
      this.orb.classList.remove("thinking");
      $("#agentSend").disabled = false;
    }
  },

  /* 是否启用画布工具（设置里可以关掉） */
  toolsEnabled() {
    return !!this.cfg && this.cfg.allow_canvas !== false && typeof AgentTools !== "undefined";
  },

  /* 多轮工具循环：模型要工具 → 本地执行 → 结果回传 → 继续，直到它给出最终回答 */
  async runAgentLoop() {
    const convo = this.messages.slice(-24);
    const tools = this.toolsEnabled() ? AgentTools.declare() : undefined;
    let model = "";
    for (let round = 0; round < 6; round += 1) {
      const res = await API.agentChat(convo, tools);
      model = res.model || model;
      const calls = res.tool_calls || [];
      if (!calls.length) return { reply: res.reply || "（没有内容）", model };
      convo.push({ role: "assistant", content: res.reply || "", tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name || "";
        const args = this.parseArgs(call.function?.arguments);
        const row = this.appendStep(`正在${this.toolLabel(name)}…`, "busy");
        const result = await AgentTools.run(name, args);
        this.finishStep(row, name, result);
        convo.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 3500),
        });
      }
    }
    return { reply: "工具调用轮次到上限了，先停在当前状态。要不要我汇报一下已经做完的部分？", model };
  },

  parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return {}; }
  },

  toolLabel(name) {
    return {
      get_workspace: "查看画布现场",
      get_workflow_params: "读取工作流参数",
      set_workflow_params: "调整工作流参数",
      set_lora: "配置 LoRA",
      create_prompt_node: "创建提示词节点",
      create_gen_node: "创建创作节点",
      connect_nodes: "连接节点",
      update_node: "修改节点",
      submit_generation: "提交生成",
      arrange_canvas: "整理画布",
    }[name] || `执行 ${name}`;
  },

  appendStep(text, state = "") {
    const row = document.createElement("div");
    row.className = `agent-step ${state}`.trim();
    row.innerHTML = `<span class="dot"></span><span class="label">${escapeHtml(text)}</span>`;
    this.body.appendChild(row);
    this.scrollToEnd();
    return row;
  },

  finishStep(row, name, result) {
    const ok = result?.ok !== false;
    row.classList.remove("busy");
    row.classList.add(ok ? "ok" : "error");
    const label = row.querySelector(".label");
    if (!label) return;
    let detail = "";
    if (!ok) detail = `：${result?.error || "失败"}`;
    else if (name === "create_gen_node" || name === "create_prompt_node") detail = `（${result.node_id}）`;
    else if (name === "connect_nodes") detail = "";
    else if (name === "submit_generation") detail = result.status === "running" || result.status === "queued" ? "（已提交）" : "";
    else if (name === "set_lora") detail = result.lora ? `（${result.lora}）` : "";
    label.textContent = `${ok ? "已完成" : "失败"}·${this.toolLabel(name).replace(/^正在/, "")}${detail}`;
  },

  /* 历史只存对话文本（工具过程不入历史，需要时模型自己 get_workspace 查） */
  saveHistory() {
    const history = this.messages.filter((msg) => msg.role === "user" || msg.role === "assistant");
    this.messages = history.slice(-20);
  },

  appendPending() {
    const wrap = document.createElement("div");
    wrap.className = "agent-msg assistant";
    wrap.innerHTML = `<div class="avatar">薇</div><div class="agent-bubble"><span class="agent-typing"></span></div>`;
    this.body.appendChild(wrap);
    this.scrollToEnd();
    return wrap.querySelector(".agent-bubble");
  },

  renderMessages() {
    this.body.classList.remove("is-welcome");
    this.body.innerHTML = this.messages.map((msg, index) => {
      const isUser = msg.role === "user";
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content.find((part) => part.type === "text")?.text || "");
      const images = typeof msg.content === "string"
        ? []
        : msg.content.filter((part) => part.type === "image_url").map((part) => part.image_url.url);
      return `
        <div class="agent-msg ${isUser ? "user" : "assistant"}">
          <div class="avatar">${isUser ? "你" : "薇"}</div>
          <div class="agent-bubble">
            ${isUser ? `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : this.md(text)}
            ${images.map((url) => `<img class="agent-img" src="${url}" alt="">`).join("")}
            ${isUser ? "" : `<button class="agent-copy" data-agent-copy="${index}">${icon("text")}复制</button>`}
          </div>
        </div>`;
    }).join("");
    this.scrollToEnd();
  },

  typewrite(el, text) {
    const total = Math.min(1500, Math.max(320, text.length * 6));
    const start = performance.now();
    const step = () => {
      const ratio = Math.min(1, (performance.now() - start) / total);
      el.textContent = text.slice(0, Math.ceil(text.length * ratio));
      this.scrollToEnd();
      if (ratio < 1) requestAnimationFrame(step);
      else {
        el.innerHTML = this.md(text);
        const index = this.messages.length - 1;
        el.insertAdjacentHTML("beforeend", `<button class="agent-copy" data-agent-copy="${index}">${icon("text")}复制</button>`);
        this.scrollToEnd();
      }
    };
    step();
  },

  scrollToEnd() {
    this.body.scrollTop = this.body.scrollHeight;
  },

  /* 极简 Markdown：标题 / 列表 / 代码块 / 行内代码 / 粗体 / 换行 */
  md(text) {
    const blocks = [];
    let source = escapeHtml(String(text || "")).replace(/\r\n/g, "\n");
    source = source.replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre><code>${code.replace(/^\n/, "")}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const lines = source.split("\n");
    const out = [];
    let list = null;
    const closeList = () => {
      if (list) { out.push(list === "ul" ? "</ul>" : "</ol>"); list = null; }
    };
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) { closeList(); return; }
      if (/^\u0000\d+\u0000$/.test(trimmed)) { closeList(); out.push(blocks[Number(trimmed.replace(/\u0000/g, ""))]); return; }
      const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        out.push(`<p><strong>${heading[2]}</strong></p>`);
        return;
      }
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${this.inline(bullet[1])}</li>`);
        return;
      }
      const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ordered) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${this.inline(ordered[1])}</li>`);
        return;
      }
      closeList();
      out.push(`<p>${this.inline(trimmed)}</p>`);
    });
    closeList();
    return out.join("");
  },

  inline(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  },

  /* ---------------- 设置页：Agent 接入 ---------------- */
  bindSettings() {
    $("#settingsMenu")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-section]");
      if (btn?.dataset.section === "agent") this.loadSettingsForm();
    });
    $("#agentModelFetch")?.addEventListener("click", () => this.fetchModels());
    // 下拉选完同步到手填框，保证只有一个「当前模型」来源
    $("#agentModelSelect")?.addEventListener("change", (event) => {
      if (event.target.value) $("#agentModelInput").value = event.target.value;
    });
    $("#agentTest")?.addEventListener("click", () => this.testConnection());
    $("#agentSaveCfg")?.addEventListener("click", () => this.saveSettingsForm());
    // 一旦手填新 Key，状态立刻变成「待保存」，不用靠点数猜
    $("#agentApiKey")?.addEventListener("input", () => this.markKeyEditing());
    $("#agentKeyChange")?.addEventListener("click", () => {
      const input = $("#agentApiKey");
      input.value = "";
      input.placeholder = "sk-...";
      input.focus();
      $("#agentKeyChange").hidden = true;
      this.setKeyState("pending", "填入新的 Key 后点「保存 Agent 配置」才会覆盖旧密钥");
    });
    $("#agentTemperature")?.addEventListener("input", (event) => {
      const out = event.target.closest(".agent-temp-row")?.querySelector("output");
      if (out) out.textContent = Number(event.target.value).toFixed(1);
    });
  },

  async loadSettingsForm() {
    if (!this.cfg) await this.loadConfig();
    const cfg = this.cfg || {};
    $("#agentBaseUrl").value = cfg.base_url || "";
    this.applyKeyState(cfg);
    $("#agentModelInput").value = cfg.model || "";
    $("#agentTemperature").value = cfg.temperature ?? 0.7;
    const out = $("#agentTemperature")?.closest(".agent-temp-row")?.querySelector("output");
    if (out) out.textContent = Number(cfg.temperature ?? 0.7).toFixed(1);
    $("#agentSystem").value = cfg.system_prompt || "";
    const enabled = $("#agentEnabled");
    if (enabled) enabled.value = cfg.enabled === false ? "0" : "1";
    const allowCanvas = $("#agentAllowCanvas");
    if (allowCanvas) allowCanvas.value = cfg.allow_canvas === false ? "0" : "1";
    const voiceReply = $("#agentVoiceReply");
    if (voiceReply) voiceReply.value = localStorage.getItem("wwdm-agent-voice-reply") === "1" ? "1" : "0";
    const select = $("#agentModelSelect");
    if (select) select.innerHTML = `<option value="">（点「拉取模型」获取列表）</option>`;
  },

  /* API Key 的状态展示：已保存时输入框留空 + 脱敏预览，明确告诉用户存没存上 */
  applyKeyState(cfg = this.cfg) {
    const input = $("#agentApiKey");
    if (!input) return;
    const saved = !!cfg?.api_key_set;
    const hint = cfg?.api_key_hint || "";
    input.value = "";
    input.placeholder = saved ? "sk-...（已保存，留空不修改）" : "sk-...";
    $("#agentKeyChange").hidden = !saved;
    this.setKeyState(saved ? "saved" : "",
      saved ? `✓ 已保存（${hint}）· 要换密钥点右边「更换」` : "未设置：填入 Key 后点下方「保存 Agent 配置」");
  },

  /* 用户开始手填新 Key：状态切到「待保存」，填完点保存才算数 */
  markKeyEditing() {
    const input = $("#agentApiKey");
    if (!input) return;
    const value = input.value.trim();
    if (!value) return this.applyKeyState(this.cfg);
    $("#agentKeyChange").hidden = true;
    this.setKeyState("pending", "待保存：点下方「保存 Agent 配置」后生效");
  },

  setKeyState(kind, text) {
    const state = $("#agentKeyState");
    if (!state) return;
    state.className = `agent-key-state ${kind || ""}`.trim();
    state.textContent = text;
  },

  collectForm() {
    const cfg = this.cfg || {};
    const pick = (id, fallback) => {
      const value = $(id)?.value?.trim();
      return value || fallback || "";
    };
    return {
      base_url: pick("#agentBaseUrl", cfg.base_url),
      api_key: pick("#agentApiKey", cfg.api_key),
      model: pick("#agentModelInput", cfg.model) || $("#agentModelSelect")?.value || "",
      temperature: Number($("#agentTemperature")?.value) || cfg.temperature || 0.7,
      system_prompt: $("#agentSystem") ? $("#agentSystem").value.trim() : (cfg.system_prompt || ""),
      enabled: $("#agentEnabled")?.value !== "0",
      allow_canvas: $("#agentAllowCanvas")?.value !== "0",
    };
  },

  /* 拉模型 / 测连接用：直接带上当前表单值，不必先保存 */
  override() {
    const form = this.collectForm();
    return { base_url: form.base_url, api_key: form.api_key, model: form.model };
  },

  async fetchModels() {
    const btn = $("#agentModelFetch");
    const patch = this.collectForm();
    btn.disabled = true;
    btn.textContent = "拉取中…";
    try {
      const result = await API.agentModels({ base_url: patch.base_url, api_key: patch.api_key, model: patch.model });
      const names = result.models || [];
      const select = $("#agentModelSelect");
      select.innerHTML = names.length
        ? names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
        : `<option value="">没有返回模型</option>`;
      const wanted = patch.model || this.cfg?.model;
      if (wanted && names.includes(wanted)) select.value = wanted;
      toast(names.length ? `拿到 ${names.length} 个模型` : "接口没有返回模型列表");
    } catch (error) {
      Dialog.warn({ title: "拉取模型失败", message: error.message });
    } finally {
      btn.disabled = false;
      btn.textContent = "拉取模型";
    }
  },

  async testConnection() {
    const btn = $("#agentTest");
    btn.disabled = true;
    btn.textContent = "测试中…";
    try {
      const result = await API.agentTest(this.override());
      const lines = [];
      if (result.via === "models") {
        lines.push(`连接正常，可用模型 ${result.count} 个。`);
        if (result.models?.length) lines.push(result.models.slice(0, 8).join("\n"));
      } else {
        lines.push("对话接口可用。");
        if (result.reply) lines.push(`模型回：${String(result.reply).slice(0, 60)}`);
        if (result.note) lines.push(result.note);
      }
      Dialog.info({ title: "测试通过", message: lines.join("\n\n") });
    } catch (error) {
      Dialog.warn({ title: "测试失败", message: error.message });
    } finally {
      btn.disabled = false;
      btn.textContent = "测试连接";
    }
  },

  async saveSettingsForm() {
    localStorage.setItem("wwdm-agent-voice-reply", $("#agentVoiceReply")?.value === "1" ? "1" : "0");
    const btn = $("#agentSaveCfg");
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      this.cfg = await API.saveAgentConfig(this.collectForm());
      this.applyKeyState(this.cfg);
      this.syncChrome();
      toast("Agent 配置已保存");
    } catch (error) {
      Dialog.warn({ title: "保存失败", message: error.message });
    } finally {
      btn.disabled = false;
      btn.textContent = "保存 Agent 配置";
    }
  },
};
