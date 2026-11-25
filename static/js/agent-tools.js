/* ============ AI Agent 的画布工具：声明 + 执行 ============
   工具在浏览器里跑（画布数据在 localStorage、生成走前端 API），
   后端只把声明透传给模型，并回传 tool_calls。
   想加新能力：在这里加一条 declare + 一个同名方法即可。 */
const AgentTools = {
  /* OpenAI tools 格式：给模型看的说明书 */
  declare() {
    const workflowId = { type: "string", description: "工作流 id，例如 qwen-image-2.1-文生图（先 get_workspace 查）" };
    return [
      {
        type: "function",
        function: {
          name: "get_workspace",
          description: "查看现场：当前项目、视图模式、画布上的节点与连线、可用工作流清单。动手前先调它。",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "get_workflow_params",
          description: "查某个工作流的当前参数、可选项（底模 / 采样器 / LoRA 文件列表）与 LoRA 槽位数。",
          parameters: {
            type: "object",
            properties: { workflow_id: workflowId },
            required: ["workflow_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_workflow_params",
          description: "改某个工作流的参数，例如 steps、cfg、seed、sampler_name、scheduler、unet、clip、negative。只传要改的键。",
          parameters: {
            type: "object",
            properties: {
              workflow_id: workflowId,
              params: { type: "object", description: "要改的参数键值，例如 {\"steps\":\"8\",\"cfg\":\"1.5\"}" },
            },
            required: ["workflow_id", "params"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_lora",
          description: "配置工作流的某个 LoRA 槽位。name 传空字符串表示清空该槽；strength 一般 0.6-1.2。",
          parameters: {
            type: "object",
            properties: {
              workflow_id: workflowId,
              slot: { type: "integer", description: "槽位序号，从 1 开始" },
              name: { type: "string", description: "LoRA 文件名（含子目录），必须在 get_workflow_params 返回的 lora 列表里；空字符串=清空" },
              strength: { type: "number", description: "权重，默认 1" },
            },
            required: ["workflow_id", "slot", "name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_prompt_node",
          description: "在画布上创建一个纯提示词节点（可编辑的文本卡），返回节点 id。",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "提示词内容" },
              x: { type: "number", description: "画布坐标 x（可省略，默认视口中心）" },
              y: { type: "number", description: "画布坐标 y（可省略）" },
            },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_gen_node",
          description: "创建一个创作节点（图片/视频/提示词节点），可同时写入提示词、指定工作流、从某个节点连线进来。",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["image", "video", "prompt"], description: "节点类型，默认 image" },
              workflow_id: workflowId,
              prompt: { type: "string", description: "提示词；可留空等上游传入" },
              params: {
                type: "object",
                description: "生成参数：图片用 {\"ratio\":\"3:4\",\"resolution\":\"1k\",\"batch\":4}；视频用 {\"video_ratio\":\"16:9\",\"duration\":5}",
              },
              from_node_id: { type: "string", description: "从这个节点连线过来（可选）" },
              x: { type: "number" },
              y: { type: "number" },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "connect_nodes",
          description: "把 from 节点连到 to 节点（to 必须是创作节点）。上游的文本/素材会传给下游。",
          parameters: {
            type: "object",
            properties: {
              from_node_id: { type: "string" },
              to_node_id: { type: "string" },
            },
            required: ["from_node_id", "to_node_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_node",
          description: "改已有节点：提示词、绑定的工作流、位置。",
          parameters: {
            type: "object",
            properties: {
              node_id: { type: "string" },
              prompt: { type: "string" },
              workflow_id: workflowId,
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["node_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_node_params",
          description: "改已有创作节点的生成参数（比例 / 分辨率 / 张数 / 视频比例 / 时长 / 放大倍数），只传要改的键。",
          parameters: {
            type: "object",
            properties: {
              node_id: { type: "string" },
              params: { type: "object", description: "例如 {\"ratio\":\"3:4\",\"batch\":4}" },
            },
            required: ["node_id", "params"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "submit_generation",
          description: "提交某个创作节点的生成任务。提交前请确认提示词非空、工作流匹配、需要参考图的已连线。",
          parameters: {
            type: "object",
            properties: { node_id: { type: "string" } },
            required: ["node_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "duplicate_node",
          description: "把一个创作节点复制成多个版本（各自可带不同提示词），自动在右边排开，适合做多方案对比。",
          parameters: {
            type: "object",
            properties: {
              node_id: { type: "string", description: "要复制的源节点" },
              prompts: {
                type: "array", items: { type: "string" },
                description: "每个副本的提示词；不传则沿用源节点提示词",
              },
              count: { type: "integer", description: "不传 prompts 时用它指定数量，默认 2，最多 4" },
            },
            required: ["node_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_recent_works",
          description: "看本项目最近生成的作品（提示词、工作流、尺寸、所用 LoRA），用于参考风格或复用参数。",
          parameters: {
            type: "object",
            properties: { limit: { type: "integer", description: "条数，默认 5，最多 10" } },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "arrange_canvas",
          description: "自动整理画布布局，让节点不重叠、从左到右按依赖排列。",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ];
  },

  /* 执行一个工具，返回给模型的可读结果（失败也要给出原因，别抛到模型外面） */
  async run(name, args) {
    try {
      const fn = this[name];
      if (typeof fn !== "function") return { ok: false, error: `没有这个工具：${name}` };
      return await fn.call(this, args || {});
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  },

  /* ---------------- 具体工具 ---------------- */
  async ensureCanvas() {
    // 画布没打开时先切过去，否则节点建在看不见的地方
    if (State.viewMode !== "canvas") {
      Works.setViewMode("canvas");
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
    }
    return window.Canvas;
  },

  briefOf(layout, id, pos) {
    const at = { x: Math.round(pos?.x || 0), y: Math.round(pos?.y || 0) };
    if (layout.gens?.[id]) {
      const gen = layout.gens[id];
      return {
        id, type: "gen", kind: gen.kind, workflow: gen.workflow,
        prompt: (gen.prompt || "").slice(0, 80), status: gen.status,
        params: { ratio: gen.params?.ratio, resolution: gen.params?.resolution, batch: gen.params?.batch },
        tasks: (gen.taskIds || []).length, ...at,
      };
    }
    if (layout.texts?.[id]) {
      return { id, type: "text", prompt: (layout.texts[id].text || "").slice(0, 80), ...at };
    }
    if (layout.assets?.[id]) {
      const asset = layout.assets[id];
      return { id, type: "asset", kind: asset.kind, name: asset.origin || asset.name, ...at };
    }
    return { id, type: "unknown", ...at };
  },

  nodeBrief(node) {
    if (node.type === "gen") {
      const gen = node.gen || {};
      return {
        id: node.id, type: "gen", kind: gen.kind, workflow: gen.workflow,
        prompt: (gen.prompt || "").slice(0, 80), status: gen.status,
        tasks: (gen.taskIds || []).length, x: Math.round(node.x), y: Math.round(node.y),
      };
    }
    if (node.type === "text") {
      return { id: node.id, type: "text", prompt: (node.text || "").slice(0, 80), x: Math.round(node.x), y: Math.round(node.y) };
    }
    if (node.type === "asset") {
      return { id: node.id, type: "asset", kind: node.asset?.kind, name: node.asset?.origin || node.asset?.name, x: Math.round(node.x), y: Math.round(node.y) };
    }
    return { id: node.id, type: node.type, x: Math.round(node.x), y: Math.round(node.y) };
  },

  PARAM_KEYS: ["ratio", "resolution", "batch", "custom", "custom_width", "custom_height",
    "video_ratio", "quality", "duration", "scale"],

  cleanParams(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([key, value]) => {
      if (!this.PARAM_KEYS.includes(key)) return;
      if (key === "batch") out[key] = Math.max(1, Math.min(4, Number(value) || 1));
      else if (["custom_width", "custom_height", "duration"].includes(key)) out[key] = Number(value) || 0;
      else if (["quality", "scale"].includes(key)) out[key] = Number(value) || 1;
      else if (key === "custom") out[key] = !!value;
      else out[key] = String(value);
    });
    return out;
  },

  async get_workspace() {
    const canvas = window.Canvas;
    const layout = canvas?.layout() || { nodes: {}, gens: {}, texts: {}, assets: {}, edges: [] };
    const nodes = Object.entries(layout.nodes || {}).slice(0, 40).map(([id, pos]) =>
      this.briefOf(layout, id, pos));
    const edges = (layout.edges || []).slice(0, 60);
    const workflows = (State.workflows || []).map((wf) => ({
      id: wf.id, name: wf.name, kind: wf.kind,
      // inpaint = 只在作品卡片的局部重绘弹窗里用，需要带遮罩的图
      category: wf.category || "",
      // 当前 ComfyUI 实例跑不起来的（缺节点 / 缺模型）不要选
      available: wf.available !== false,
      unavailable_reason: wf.unavailable_reason || "",
      supports_prompt: wf.supports_prompt !== false,
      needs_image: !!wf.needs_image,
      images_per_task: wf.images_per_task || 1,
      limits: wf.limits || null,
      scale: wf.scale ? { min: wf.scale.min, max: wf.scale.max, default: wf.scale.default } : null,
    }));
    const project = (State.projects || []).find((item) => item.id === State.activeId) || {};
    return {
      ok: true,
      project: { id: State.activeId, name: project.name || "" },
      view: State.viewMode,
      generation_options: {
        ratios: window.Composer?.ratios || ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3"],
        resolutions: ["1k", "1.5k", "2k"],
        batches: window.Composer?.batches || [1, 2, 4],
        video_ratios: window.Composer?.videoRatios || ["16:9", "9:16", "1:1"],
        note: "图片节点用 ratio/resolution/batch，视频节点用 video_ratio/quality/duration",
      },
      workflows,
      canvas: { node_count: nodes.length, nodes, edges },
      hint: nodes.length ? "" : "画布是空的，可以先 create_prompt_node 或 create_gen_node",
    };
  },

  async get_workflow_params({ workflow_id }) {
    if (!workflow_id) return { ok: false, error: "缺少 workflow_id" };
    const info = await API.workflowParams(workflow_id);
    const options = info.options || {};
    return {
      ok: true,
      workflow: { id: workflow_id, name: info.workflow?.name || workflow_id, kind: info.kind },
      params: { ...(info.defaults || {}), ...(info.saved || {}) },
      lora_slots: info.lora_slots || 0,
      lora_files: (options.lora || []).slice(0, 60),
      models: {
        unet: (options.unet || []).slice(0, 30),
        clip: (options.clip || []).slice(0, 30),
        vae: (options.vae || []).slice(0, 20),
      },
      samplers: (options.sampler_name || []).slice(0, 20),
      schedulers: (options.scheduler || []).slice(0, 20),
    };
  },

  async set_workflow_params({ workflow_id, params }) {
    if (!workflow_id) return { ok: false, error: "缺少 workflow_id" };
    if (!params || typeof params !== "object") return { ok: false, error: "params 必须是对象" };
    const result = await API.saveWorkflowParams(workflow_id, params);
    window.WorkflowParams?.load?.(true).catch?.(() => {});
    return { ok: true, workflow_id, changed: params, saved: result.params || {} };
  },

  async set_lora({ workflow_id, slot, name, strength }) {
    if (!workflow_id) return { ok: false, error: "缺少 workflow_id" };
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 1 || index > 5) {
      return { ok: false, error: "slot 必须是 1-5 的整数" };
    }
    const info = await API.workflowParams(workflow_id);
    const loraName = String(name || "").trim();
    if (loraName) {
      const files = (info.options?.lora || []);
      if (files.length && !files.includes(loraName)) {
        return {
          ok: false,
          error: `没有这个 LoRA：${loraName}`,
          similar: files.filter((item) => item.toLowerCase().includes(loraName.toLowerCase().slice(0, 6))).slice(0, 6),
        };
      }
    }
    const params = { [`lora_${index}`]: loraName };
    if (loraName) {
      params[`lora_${index}_strength`] = String(Number.isFinite(Number(strength)) ? Number(strength) : 1);
    }
    await API.saveWorkflowParams(workflow_id, params);
    window.WorkflowParams?.load?.(true).catch?.(() => {});
    return {
      ok: true, workflow_id, slot: index,
      lora: loraName || "（已清空）",
      strength: params[`lora_${index}_strength`] ?? null,
      tip: loraName ? "该 LoRA 若有触发词（如人名），记得把触发词写进节点提示词，否则效果不准" : "",
    };
  },

  async create_prompt_node({ text, x, y }) {
    const canvas = await this.ensureCanvas();
    const options = { text: String(text || "") };
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      options.x = Number(x); options.y = Number(y);
    }
    const id = canvas.createTextNode(options);
    return { ok: true, node_id: id, type: "text", text: options.text.slice(0, 120) };
  },

  async create_gen_node({ kind, workflow_id, prompt, params, from_node_id, x, y }) {
    const canvas = await this.ensureCanvas();
    const nodeKind = ["image", "video", "prompt"].includes(kind) ? kind : "image";
    const data = {};
    if (workflow_id) {
      const found = (State.workflows || []).find((wf) => wf.id === workflow_id);
      if (!found) return { ok: false, error: `没有这个工作流：${workflow_id}` };
      if (found.available === false) {
        return { ok: false, error: `当前 ComfyUI 实例跑不了「${found.name || workflow_id}」：${found.unavailable_reason || "缺少节点或模型"}` };
      }
      data.workflow = workflow_id;
    }
    if (prompt) data.prompt = String(prompt);
    const clean = this.cleanParams(params);
    if (Object.keys(clean).length) data.params = clean;
    const options = { data };
    if (from_node_id) options.fromIds = [from_node_id];
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      options.x = Number(x); options.y = Number(y);
    }
    const id = canvas.createGenNode(nodeKind, options);
    const gen = canvas.layout().gens[id];
    return {
      ok: true, node_id: id, kind: nodeKind,
      workflow: gen?.workflow || "", prompt: (gen?.prompt || "").slice(0, 120),
      params: gen?.params ? { ratio: gen.params.ratio, resolution: gen.params.resolution, batch: gen.params.batch } : null,
      connected_from: from_node_id || null,
    };
  },

  async connect_nodes({ from_node_id, to_node_id }) {
    const canvas = await this.ensureCanvas();
    if (!canvas.byId(from_node_id)) return { ok: false, error: `没有节点 ${from_node_id}` };
    const target = canvas.byId(to_node_id);
    if (!target) return { ok: false, error: `没有节点 ${to_node_id}` };
    if (target.type !== "gen") return { ok: false, error: "只能连到创作节点（图片 / 视频 / 提示词节点）" };
    canvas.addEdge(from_node_id, to_node_id);
    return { ok: true, from: from_node_id, to: to_node_id };
  },

  async update_node({ node_id, prompt, workflow_id, x, y }) {
    const canvas = await this.ensureCanvas();
    const node = canvas.byId(node_id);
    if (!node) return { ok: false, error: `没有节点 ${node_id}` };
    const layout = canvas.layout();
    canvas.record();
    if (node.type === "text" && typeof prompt === "string") {
      layout.texts[node_id].text = prompt;
    }
    if (node.type === "gen") {
      if (typeof prompt === "string") layout.gens[node_id].prompt = prompt;
      if (workflow_id) {
        if (!(State.workflows || []).some((wf) => wf.id === workflow_id)) {
          return { ok: false, error: `没有这个工作流：${workflow_id}` };
        }
        layout.gens[node_id].workflow = workflow_id;
      }
    }
    if (Number.isFinite(Number(x)) || Number.isFinite(Number(y))) {
      const pos = layout.nodes[node_id] || {};
      layout.nodes[node_id] = {
        x: Number.isFinite(Number(x)) ? Number(x) : pos.x,
        y: Number.isFinite(Number(y)) ? Number(y) : pos.y,
      };
    }
    canvas.save();
    canvas.render();
    return { ok: true, node_id, updated: this.nodeBrief(canvas.byId(node_id)) };
  },

  async set_node_params({ node_id, params }) {
    const canvas = await this.ensureCanvas();
    const gen = canvas.layout().gens?.[node_id];
    if (!gen) return { ok: false, error: `没有创作节点 ${node_id}` };
    const clean = this.cleanParams(params);
    if (!Object.keys(clean).length) return { ok: false, error: "没有可用的参数键" };
    canvas.record();
    gen.params = { ...(gen.params || {}), ...clean };
    canvas.save();
    canvas.render();
    return { ok: true, node_id, params: clean };
  },

  async submit_generation({ node_id }) {
    const canvas = await this.ensureCanvas();
    const gen = canvas.layout().gens?.[node_id];
    if (!gen) return { ok: false, error: `没有创作节点 ${node_id}` };
    if (["queued", "submitting", "running"].includes(gen.status)) {
      return { ok: false, error: `节点 ${node_id} 正在生成中（${gen.status}）` };
    }
    const prompt = (gen.prompt || "").trim() || canvas.upstreamPromptText(node_id);
    canvas.select(node_id);
    await window.CanvasComposer.generate(node_id);
    const after = canvas.layout().gens[node_id] || {};
    return {
      ok: after.status !== "error",
      node_id,
      status: after.status,
      prompt_used: prompt.slice(0, 100),
      tasks: (after.taskIds || []).length,
      error: after.error || undefined,
    };
  },

  async duplicate_node({ node_id, prompts, count }) {
    const canvas = await this.ensureCanvas();
    const layout = canvas.layout();
    const source = layout.gens?.[node_id];
    if (!source) return { ok: false, error: `没有创作节点 ${node_id}` };
    const list = Array.isArray(prompts) && prompts.length
      ? prompts.slice(0, 4).map((text) => String(text))
      : Array.from({ length: Math.min(4, Math.max(1, Number(count) || 2)) }, () => source.prompt || "");
    const pos = layout.nodes[node_id] || { x: 0, y: 0 };
    const made = [];
    for (let i = 0; i < list.length; i += 1) {
      // createGenNode 的 x/y 是节点中心，节点宽 304、高 262
      const centerX = pos.x + (i + 1) * 344 + 152;
      const centerY = pos.y + 110;
      const id = canvas.createGenNode(source.kind || "image", {
        x: centerX,
        y: centerY,
        data: {
          prompt: list[i],
          workflow: source.workflow,
          params: { ...(source.params || {}) },
          refs: source.refs ? [...source.refs] : [],
        },
      });
      made.push({ node_id: id, prompt: list[i].slice(0, 60) });
    }
    return { ok: true, source: node_id, copies: made, count: made.length };
  },

  async get_recent_works({ limit }) {
    const size = Math.min(10, Math.max(1, Number(limit) || 5));
    const works = (State.tasks || []).slice(0, size).map((task) => ({
      id: task.id,
      workflow: task.workflow,
      prompt: (task.prompt || "").slice(0, 90),
      size: task.width && task.height ? `${task.width}×${task.height}` : "",
      loras: (task.loras || []).map((lora) => String(lora.name || "").split("\\").pop()),
      status: task.status,
      time: new Date((task.created_at || 0) * 1000).toLocaleString("zh-CN", { hour12: false }),
    }));
    return { ok: true, count: works.length, works };
  },

  async arrange_canvas() {
    const canvas = await this.ensureCanvas();
    canvas.tidy();
    return { ok: true, nodes: (canvas.nodes || []).length };
  },
};
