/* CYUI · 对话式 ComfyUI 创作台 — 原生 JS，无构建依赖 */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    skills: [], skillMap: {}, catalog: {}, defaults: {},
    sessions: [], gallery: [], messages: [],
    mode: 'text2img', agent: true, filter: '推荐',
    images: [], mask: null, draft: '',
    params: {}, loras: [], sessionId: null,
    view: 'home', pending: new Set(), jobPayloads: {},
    online: false,
    comfyBase: '', requiredModels: [], requiredPlugins: [], gguf: {}, llm: {}, llmDefault: {},
    accel: {},
    upscale: {}, upscaleDefaults: {}, upscaleTargets: [],
    cloudOpen: true,
    assistantSkills: [],
    ai: { messages: [], images: [], busy: false, open: false, full: false,
          chats: [], chatId: '', view: 'chat',
          // loras：用户手选的 LoRA；loraPool / accelHint：手选面板的清单与加速 LoRA 关键字
          loras: [], loraPool: [], loraTotal: 0, accelHint: [] },
    canvasZoom: 1, lastGalleryCount: 0,
    canvasSelection: new Set(), canvasDragging: false,
    sessionSelection: new Set(),
  };

  /* ---------------- 基础工具 ---------------- */
  async function api(path, opts) {
    const res = await fetch(path, opts);
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('服务器返回了非 JSON 内容'); }
    if (!data.ok) {
      let extra = '';
      if (data.detail) {
        const d = data.detail;
        if (d.error && d.error.message) extra = ' · ' + d.error.message;
        else if (typeof d === 'string') extra = ' · ' + d.slice(0, 180);
      }
      throw new Error((data.error || '请求失败') + extra);
    }
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  /* 顶部轻提示：固定在 topbar 右上角下方，承接所有「操作反馈」类消息
     （成功确认 / 温和警告 / 错误），不再用底部 toast 遮挡选项。
     type 可选 'info'（默认，青色）/ 'warn'（橙）/ 'error'（红）。 */
  let heroNoticeTimer;
  function heroNotice(msg, type) {
    const el = $('#heroNotice');
    if (!el) { toast(msg); return; }
    el.textContent = msg;
    el.dataset.type = type === 'error' ? 'error' : (type === 'warn' ? 'warn' : 'info');
    el.classList.add('show');
    clearTimeout(heroNoticeTimer);
    heroNoticeTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  /* ---------------- 个人资料（头像 + 名称） ----------------
     存 localStorage（key cyui_profile），纯本机浏览器持久化，换设备不跟随。
     头像存 base64 dataURL，名称纯文本；同步到左下角 side-footer 的头像与昵称。 */
  const PROFILE_KEY = 'cyui_profile';
  const PROFILE_DEFAULT = { name: '薇薇的猫', avatar: '' };
  function profileLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        return {
          name: String(raw.name || '').trim().slice(0, 16) || PROFILE_DEFAULT.name,
          avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
        };
      }
    } catch (e) { /* 忽略 */ }
    return { ...PROFILE_DEFAULT };
  }
  function profileSave(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
  }
  /* 把资料渲染到左下角头像 + 昵称，以及设置页的预览 */
  function profileRender() {
    const p = profileLoad();
    const sideAvatar = $('#sideAvatar');
    const sideName = $('#sideUserName');
    if (sideAvatar) {
      if (p.avatar) {
        sideAvatar.innerHTML = '<img src="' + p.avatar + '" alt="">';
        sideAvatar.classList.add('has-img');
      } else {
        const ch = (p.name || '薇').trim().charAt(0) || '薇';
        sideAvatar.innerHTML = '<span id="sideAvatarText">' + esc(ch) + '</span>';
        sideAvatar.classList.remove('has-img');
      }
    }
    if (sideName) sideName.textContent = p.name;
    const pv = $('#profileAvatarPreview');
    if (pv) {
      if (p.avatar) { pv.innerHTML = '<img src="' + p.avatar + '" alt="">'; pv.classList.add('has-img'); }
      else { pv.textContent = (p.name || '薇').trim().charAt(0) || '薇'; pv.classList.remove('has-img'); }
    }
    const nameInput = $('#p_profile_name');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = p.name;
    const clearBtn = $('#profileAvatarClear');
    if (clearBtn) clearBtn.style.display = p.avatar ? '' : 'none';
  }
  /* 选头像：读文件 → 居中裁剪成正方形 → 缩放压到 ≤ 256px → base64 */
  function profilePickAvatar(file) {
    if (!file || !file.type.startsWith('image/')) return heroNotice('请选择图片文件', 'warn');
    if (file.size > 4 * 1024 * 1024) return heroNotice('头像请控制在 4MB 以内');
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
        const out = Math.min(256, s);
        const cv = document.createElement('canvas');
        cv.width = out; cv.height = out;
        cv.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, out, out);
        try {
          const url = cv.toDataURL('image/png');
          const p = profileLoad(); p.avatar = url; profileSave(p); profileRender();
          heroNotice('头像已更新，点「保存资料」确认');
        } catch (e) { heroNotice('头像处理失败：' + e.message, 'error'); }
      };
      img.onerror = () => heroNotice('图片读取失败，换一张试试', 'error');
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }
  function initProfile() {
    profileRender();
    $('#profileAvatarBtn').addEventListener('click', () => $('#profileAvatarFile').click());
    $('#profileAvatarFile').addEventListener('change', e => { profilePickAvatar(e.target.files[0]); e.target.value = ''; });
    $('#profileAvatarClear').addEventListener('click', () => {
      const p = profileLoad(); p.avatar = ''; profileSave(p); profileRender();
      heroNotice('已恢复默认头像');
    });
    $('#profileSave').addEventListener('click', () => {
      const name = ($('#p_profile_name').value || '').trim().slice(0, 16);
      const p = profileLoad(); p.name = name || PROFILE_DEFAULT.name;
      profileSave(p); profileRender();
      heroNotice('个人资料已保存');
    });
  }
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  /* 自定义确认弹窗：替代 js 原生 confirm（Promise 化，调用点 await） */
  let confirmResolver = null;
  function confirmDialog(msg, okText) {
    $('#confirmText').textContent = msg;
    $('#confirmOk').textContent = okText || '确定';
    $('#confirmModal').classList.remove('hidden');
    return new Promise(res => { confirmResolver = res; });
  }
  function settleConfirm(v) {
    const m = $('#confirmModal');
    if (!m || m.classList.contains('hidden')) return;
    m.classList.add('hidden');
    if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(v); }
  }
  function skill() { return state.skillMap[state.mode] || state.skills[0] || { name: '文生图', max_images: 0 }; }
  function polishSourceName() { return (state.params.polish_provider === 'deepseek') ? 'DeepSeek' : '本地工作流'; }
  function togglePolish() {
    state.params.polish = !state.params.polish;
    persistParams(); updateComposer();
    heroNotice(state.params.polish ? '已开启提示词润色（来源：' + polishSourceName() + '）' : '已关闭提示词润色');
  }
  function cap() { return Math.min(skill().max_images || 0, Number(state.params.max_images || 10)); }
  function shortName(n) { return String(n || '').replace(/^.*[\\/]/, '').replace(/\.(safetensors|gguf|pt|ckpt|bin)$/i, ''); }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    applyTheme(localStorage.getItem('cyui_theme') || 'dark');
    bindShell();
    bindCanvas();
    mountComposer('Home'); mountComposer('Dock'); mountComposer('Canvas');
    try {
      const r = await api('/api/bootstrap');
      state.skills = r.skills || [];
      state.skillMap = Object.fromEntries(state.skills.map(s => [s.id, s]));
      state.catalog = r.catalog || {};
      state.defaults = r.defaults || {};
      state.sessions = r.sessions || [];
      state.gallery = r.gallery || [];
      state.online = !!(r.comfy && r.comfy.online);
      state.comfyBase = r.comfy_base || (r.comfy && r.comfy.base) || '';
      state.comfyDir = r.comfy_dir || '';
      state.requiredModels = r.required_models || [];
      state.requiredPlugins = r.required_plugins || [];
      state.gguf = (state.catalog && state.catalog.gguf) || {};
      state.llm = r.llm || {};
      state.llmDefault = r.llm_default || {};
      state.upscale = r.upscale || {};
      state.upscaleDefaults = r.upscale_defaults || {};
      state.upscaleTargets = r.upscale_targets || [];
      state.assistantSkills = r.assistant_skills || [];
      state.lastGalleryCount = r.gallery_count != null ? r.gallery_count : state.gallery.length;
      // 刷新 / 重开页面后，把未完成任务重新纳入轮询
      (r.pending_jobs || []).forEach(p => state.pending.add(p));
      const saved = JSON.parse(localStorage.getItem('cyui_params') || '{}');
      state.params = Object.assign({
        ratio: '1:1', res_level: '1K', size_mode: 'auto',
        polish: true, polish_provider: 'local', deepseek_model: 'deepseek-chat',
        cloud_enabled: true, cloud_custom: '', canvas_gap_x: 28, canvas_gap_y: 28,
      }, r.defaults, saved);
      if (state.params.deepseek_key) state.params.deepseek_key = unmaskKey(state.params.deepseek_key);
      // 旧版只有 canvas_gap：迁移成横向 / 纵向两个值
      if (saved.canvas_gap != null && saved.canvas_gap_x == null && saved.canvas_gap_y == null) {
        state.params.canvas_gap_x = state.params.canvas_gap_y = Number(saved.canvas_gap) || 28;
      }
      // 真实数据目录随部署位置而变：页面文案统一用后端下发的绝对路径填充
      if (r.results_dir) {
        $('#resultsPath') && ($('#resultsPath').textContent = r.results_dir);
        $('#resultsPathHelp') && ($('#resultsPathHelp').textContent = r.results_dir);
      }
      if (r.data_dir) {
        $('#configPath') && ($('#configPath').textContent = r.data_dir + '\\config.json');
      }
      try { state.cloudOpen = localStorage.getItem('cyui_cloud') !== '0'; } catch (e) { state.cloudOpen = true; }
      // 只保留 ComfyUI 当前清单里还存在的 LoRA：避免 localStorage 里的幽灵 LoRA
      // （AI 编造的名字 / 后来卸载的模型）每次生成都让 ComfyUI 校验失败。
      const loraPool = (state.catalog || {}).loras || [];
      const savedLoras = Array.isArray(saved.__loras) ? saved.__loras : [];
      state.loras = loraPool.length
        ? savedLoras.filter(l => loraPool.includes(l && l.name))
        : savedLoras;
      if (state.loras.length !== savedLoras.length) {
        heroNotice('已清除 ' + (savedLoras.length - state.loras.length) + ' 个失效 LoRA（模型清单里已不存在）', 'warn');
        persistParams();
      }
      $('#heroModel').textContent = state.online ? 'Turbo 权重 · CLIP · VAE 已就绪' : 'ComfyUI 未连接';
    } catch (e) {
      heroNotice('初始化失败：' + e.message, 'error');
      $('#heroModel').textContent = '后端连接失败';
      return;
    }
    initProfile();
    fillParams();
    renderSkillNav(); renderSkillFilters(); renderSkillCards();
    renderSessions(); renderGallery(); renderRefs(); updateComposer();
    renderHelp();
    renderAssistantSkills();
    initAi();
    fillComfyBase();
    // 刷新后回到刷新前那一页：优先 #canvas / ?view，其次 localStorage 里上次停留的页面
    let restored = false;
    if (typeof location !== 'undefined' && location.hash === '#canvas') {
      // 直接落在画布上时也要把上次的会话恢复回来：画布按 session_id 过滤作品，
      // 少了这一步刷新后画布永远是空的（以前只在这里 switchView，没恢复会话）
      let csid = '';
      try { csid = localStorage.getItem('cyui_session') || ''; } catch (e) { /* 忽略 */ }
      if (csid && state.sessions.some(s => s.id === csid)) {
        state.sessionId = csid;
        try {
          const d = await api('/api/sessions/' + csid);
          state.messages = (d.session || {}).messages || [];
        } catch (e) { /* 会话内容拉不到也不影响画布布局 */ }
      }
      switchView('canvas');
      restored = true;
    }
    try {
      const qv = new URLSearchParams(location.search).get('view');
      if (qv && $('#view' + qv[0].toUpperCase() + qv.slice(1))) { switchView(qv); restored = true; }
    } catch (e) { /* 忽略 */ }
    if (!restored) {
      let sv = 'home', sid = '';
      try {
        sv = localStorage.getItem('cyui_view') || 'home';
        sid = localStorage.getItem('cyui_session') || '';
      } catch (e) { /* 忽略 */ }
      const hasSid = !!sid && state.sessions.some(s => s.id === sid);
      if (sv === 'chat' && hasSid) {
        await openSession(sid);          // 连对话内容一起恢复
      } else {
        // 首页 / 画布 / 其他页面刷新后也要恢复当前会话，否则画布按会话过滤会变成空
        if (hasSid) {
          state.sessionId = sid;
          try {
            const d = await api('/api/sessions/' + sid);
            state.messages = (d.session || {}).messages || [];
          } catch (e) { /* 忽略 */ }
        }
        if ($('#view' + sv[0].toUpperCase() + sv.slice(1))) switchView(sv);
      }
    }
    aiOnSessionsChanged();               // 恢复完会话后把 AI 助手对齐到同一条对话
    refreshStatus();                    // 首次拉连接状态与日志
    setInterval(refreshStatus, 15000);  // 兜底同步：结果回收、队列、日志
    setInterval(pollJobs, 1200);        // 生成进度轮询
    /* 浮层状态同步：给 body 打 has-overlay 标记，供不支持 CSS :has() 的浏览器
       （Firefox < 121 / 旧 Safari）隐藏悬浮球，避免它盖住抽屉右下角。 */
    function syncOverlayFlag() {
      const on = !!(document.querySelector('.drawer.open, .size-card:not(.hidden), .pick-card:not(.hidden), .modal:not(.hidden)'));
      document.body.classList.toggle('has-overlay', on);
    }
    if (window.MutationObserver) {
      new MutationObserver(syncOverlayFlag).observe(document.body, {
        subtree: true, attributes: true, attributeFilter: ['class']
      });
    }
    syncOverlayFlag();
  }

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('cyui_theme', t);
    const mark = t === 'dark' ? '☾' : '☀';
    $('#themeBtn').textContent = mark;
    const cv = $('#cvThemeBtn'); if (cv) cv.textContent = mark;
  }

  /* ---------------- 外壳交互 ---------------- */
  function bindShell() {
    $('#mainNav').addEventListener('click', e => {
      const b = e.target.closest('button[data-view]'); if (!b) return;
      switchView(b.dataset.view);
    });
    $('#newChatBtn').addEventListener('click', createNewChat);
    $('#confirmOk').addEventListener('click', () => settleConfirm(true));
    $('#confirmCancel').addEventListener('click', () => settleConfirm(false));
    $('#confirmModal').addEventListener('click', e => { if (e.target.id === 'confirmModal') settleConfirm(false); });
    $('#gotoCanvas').addEventListener('click', () => switchView(state.view === 'canvas' ? 'chat' : 'canvas'));
    $('#collapseBtn').addEventListener('click', () => $('.app-shell').classList.toggle('collapsed'));
    $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    $('#paramsBtn').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerMask').addEventListener('click', closeDrawer);
    $('#paramsDone').addEventListener('click', saveParams);
    $('#gallerySearch').addEventListener('input', () => renderGallery());
    $('#galleryFilter').addEventListener('change', () => renderGallery());
    // 独立的图片尺寸卡片
    $('#sizeDone').addEventListener('click', closeSizeCard);
    $('#sizeClose').addEventListener('click', closeSizeCard);
    $('#sizeMask').addEventListener('click', closeSizeCard);
    // 图片选择弹窗
    $('#pickClose').addEventListener('click', closeImgPicker);
    $('#pickCancel').addEventListener('click', closeImgPicker);
    $('#pickMask').addEventListener('click', closeImgPicker);
    $('#pickDone').addEventListener('click', pickCommit);
    $('#pickUpload').addEventListener('click', () => $('#pickFile').click());
    $('#pickFile').addEventListener('change', e => { pickUploadFiles(e.target.files); e.target.value = ''; });
    $('#pickTabs').addEventListener('click', e => {
      const tab = e.target.closest('[data-src]'); if (!tab) return;
      pickSwitchSource(tab.dataset.src);
    });
    $('#pickGrid').addEventListener('click', e => {
      // 双击看信息时浏览器会先补一次 click：detail>1 的是第二击，忽略掉，
      // 免得「看个信息顺便把选中状态翻回去」
      if (e.detail > 1) return;
      const cell = e.target.closest('[data-pick]'); if (!cell) return;
      pickToggle(cell.dataset.pick);
    });
    $('#pickGrid').addEventListener('dblclick', e => {
      const cell = e.target.closest('[data-pick]'); if (!cell) return;
      e.preventDefault();
      openPicInfo(picker.items.find(x => x.name === cell.dataset.pick));
    });
    $('#pfClose').addEventListener('click', closePicInfo);
    $('#pfMask').addEventListener('click', closePicInfo);
    $('#pickEmpty').addEventListener('click', e => {
      if (!e.target.closest('#pickGotoSettings')) return;
      closeImgPicker();
      switchView('settings');
    });
    // 弹窗内拖放 / 粘贴
    const pickCard = $('#pickCard');
    pickCard.addEventListener('dragover', e => { e.preventDefault(); });
    pickCard.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer.files.length) pickUploadFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste', e => {
      if (!picker.open) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length) { e.preventDefault(); pickUploadFiles(files); }
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('#pfCard').classList.contains('hidden')) return closePicInfo();
      if (picker.open) return closeImgPicker();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSizeCard(); });
    $('#paramsReset').addEventListener('click', () => {
      state.params = Object.assign({
        ratio: '1:1', res_level: '1K', size_mode: 'auto',
        polish: true, polish_provider: 'local', deepseek_model: 'deepseek-chat',
      }, state.defaults); state.loras = [];
      localStorage.removeItem('cyui_params'); fillParams(); updateComposer(); heroNotice('已恢复默认参数');
    });
    $('#p_ratioGrid').addEventListener('click', e => {
      const b = e.target.closest('button[data-ratio]'); if (b) selectPreset(b.dataset.ratio);
    });
    $('#p_resSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-res]'); if (b) selectPreset(null, b.dataset.res);
    });
    $('#p_sizeModeSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-sizemode]'); if (!b) return;
      state.params.size_mode = b.dataset.sizemode;
      // 同步旧参数 custom_size：native / auto 都意味着「不锁固定画布」，
      // 否则后端 normalize 会拿残留的 custom_size=true 把 size_mode 又改回 fixed
      // （这就是「选了原图像素却仍按 1024×440 出图」的根因）
      state.params.custom_size = (b.dataset.sizemode === 'fixed');
      commitParamChange();
    });
    $('#p_batchSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-batch]'); if (!b) return;
      state.params.batch = Number(b.dataset.batch); commitParamChange();
    });
    $('#p_batchApply').addEventListener('click', applyBatchCustom);
    $('#p_batchCustom').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyBatchCustom(); }
    });
    $('#p_customApply').addEventListener('click', applyCustomSize);
    $('#p_sampling').addEventListener('change', () => syncSampling(true));
    // 卡片式方案选择：点卡片 = 改隐藏 select 的值，后面所有逻辑仍走 syncSampling
    $('#p_samplingCards').addEventListener('click', e => {
      const b = e.target.closest('[data-sampling]'); if (!b) return;
      const v = b.dataset.sampling;
      if ($('#p_sampling').value === v) return;
      $('#p_sampling').value = v;
      state.params.sampling = v;
      syncSampling(true);
    });
    $('#p_unet').addEventListener('change', () => renderUnetWarn());
    $('#p_cfg').addEventListener('input', () => syncSampling(false));
    $('#p_steps').addEventListener('input', () => syncSampling(false));
    $('#p_denoise').addEventListener('input', e => { $('#denoiseVal').textContent = Number(e.target.value).toFixed(2); });
    // 「强制使用自定义画布」= 尺寸卡片的「按比例」，勾选状态双向同步
    $('#p_custom_size').addEventListener('change', e => {
      state.params.size_mode = e.target.checked ? 'fixed' : 'auto';
      persistParams(); renderParamPanel(); updateComposer();
    });
    $('#p_loraSearch').addEventListener('input', renderLoraList);
    $('#p_loraList').addEventListener('change', onLoraChange);
    $('#p_loraList').addEventListener('input', onLoraChange);
    $('#modeTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-agent]'); if (!b || b.disabled) return;
      $$('#modeTabs .mode-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); state.agent = b.dataset.agent === 'auto';
      heroNotice(state.agent ? '智能创作：会按描述和图片自动挑技能' : '手动模式：使用当前选中的技能');
    });
    // 「智能创作」tab 默认高亮：state.agent 必须与 UI 同步为开启，否则用户
    // 没点过 tab 时自动路由根本不生效（UI 显示智能、实际走手动选中的技能）
    state.agent = true;
    $('#skillFilters')?.addEventListener('click', e => {
      const b = e.target.closest('button[data-filter]'); if (!b) return;
      state.filter = b.dataset.filter; renderSkillFilters(); renderSkillCards();
    });
    $('#skillGrid')?.addEventListener('click', onSkillCardClick);
    $('#skillGridAll')?.addEventListener('click', onSkillCardClick);
    $('#skillNav')?.addEventListener('click', e => {
      const b = e.target.closest('button[data-skill]'); if (!b) return;
      setMode(b.dataset.skill); switchView('home');
      window.setTimeout(() => $('#viewHome').scrollTo({ top: 0, behavior: 'smooth' }), 30);
    });
    // 会话列表：单击打开；420ms 内再次点同一行 = 双击 → 行内重命名。
    // 不用原生 dblclick：单击会重新渲染列表，DOM 被替换后 dblclick 不会触发。
    let lastSessClick = { sid: '', t: 0 };
    $('#sessionNav').addEventListener('click', async e => {
      if (e.target.closest('.sess-check')) { e.stopPropagation(); return; }
      const del = e.target.closest('em[data-del]');
      if (del) { e.stopPropagation(); await deleteSessions([del.dataset.del], '删除这个对话？将同步移除它在自由画布 / 作品图库中的图片。'); return; }
      if (e.target.closest('.sess-rename')) return;
      const row = e.target.closest('.sess[data-sid]'); if (!row) return;
      const sid = row.dataset.sid;
      const now = Date.now();
      if (lastSessClick.sid === sid && now - lastSessClick.t < 420) {
        lastSessClick = { sid: '', t: 0 };
        startSessionRename(row);
        return;
      }
      lastSessClick = { sid, t: now };
      await openSession(sid);
    });
    $('#sessionNav').addEventListener('change', e => {
      const cb = e.target.closest('[data-check-sid]');
      if (!cb) return;
      if (cb.checked) state.sessionSelection.add(cb.dataset.checkSid);
      else state.sessionSelection.delete(cb.dataset.checkSid);
      const row = cb.closest('.sess'); if (row) row.classList.toggle('selected', cb.checked);
      renderSessBar();
    });
    $('#sessionSelectAll').addEventListener('click', () => {
      const sel = state.sessionSelection = state.sessionSelection || new Set();
      const all = !!state.sessions.length && state.sessions.every(s => sel.has(s.id));
      sel.clear();
      if (!all) state.sessions.forEach(s => sel.add(s.id));
      renderSessions();
    });
    $('#sessionDelSel').addEventListener('click', () => deleteSessions(Array.from(state.sessionSelection || [])));
    $('#clearSessionsBtn').addEventListener('click', async () => {
      if (!state.sessions.length) return heroNotice('没有可清空的对话', 'error');
      await deleteSessions(state.sessions.map(s => s.id),
        '清空全部 ' + state.sessions.length + ' 个对话？将同步移除这些对话在自由画布 / 作品图库中的图片。');
    });
    $('#toGallery')?.addEventListener('click', () => switchView('gallery'));
    $('#galleryRefresh').addEventListener('click', async () => { await refreshGallery(); heroNotice('图库已刷新'); });
    $('#galleryGrid').addEventListener('click', onGalleryClick);
    $('#galleryGrid').addEventListener('change', e => {
      const cb = e.target.closest('[data-check]'); if (!cb) return;
      const sel = state.gallerySelection = state.gallerySelection || new Set();
      if (cb.checked) sel.add(cb.dataset.check); else sel.delete(cb.dataset.check);
      cb.closest('.gallery-item').classList.toggle('selected', cb.checked);
      updateGalleryBar();
    });
    $('#gallerySelectAll').addEventListener('click', () => {
      const sel = state.gallerySelection = state.gallerySelection || new Set();
      if (sel.size === state.gallery.length && state.gallery.length) sel.clear();
      else state.gallery.forEach(g => sel.add(g.id));
      renderGallery();
      heroNotice(sel.size ? '已全选 ' + sel.size + ' 张' : '已取消全选');
    });
    $('#galleryDeleteSel').addEventListener('click', deleteGallerySelection);
    $('#galleryToEdit').addEventListener('click', () => sendGalleryToEdit(Array.from(state.gallerySelection || [])));
    $('#chatInner').addEventListener('click', onChatClick);
    $('#chatScroll').addEventListener('click', e => {
      // 用户上传的参考图 / 遮罩：点开看大图
      const refImg = e.target.closest('.msg-images img');
      if (refImg) {
        openLightbox({ url: refImg.src, name: refImg.alt === '遮罩' ? '重绘遮罩' : '参考图' });
        return;
      }
      const img = e.target.closest('img[data-zoom]');
      if (!img) return;
      const msg = state.messages.find(m => m.job_id === img.dataset.pid);
      const it = (msg && msg.images || [])[Number(img.dataset.idx)] || {};
      openImgMenu(e.clientX, e.clientY, Object.assign({}, it, {
        url: it.url || img.src,
        name: (msg && msg.skill) || '生成结果',
      }));
    });
    $('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
    $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); });
    $('#lbToggle').addEventListener('click', () => setLbCollapsed(true));
    $('#lbExpand').addEventListener('click', () => setLbCollapsed(false));
    $('#imgMenu').addEventListener('click', e => {
      const b = e.target.closest('[data-mi]');
      if (!b || !imgMenuInfo) return;
      const mi = b.dataset.mi, label = b.textContent.trim();
      if (mi === 'view') {
        openLightbox(imgMenuInfo);
        hideImgMenu();
        return;
      }
      if (mi === 'reverse') {
        const url = imgMenuInfo.url;
        hideImgMenu();
        reverseFromUrl(url);
        return;
      }
      if (mi === 'upscale') {
        openImgSub();
        return;
      }
      if (mi === 'toedit') { const info = imgMenuInfo; hideImgMenu(); sendToMode(info, 'edit'); return; }
      if (mi === 'toimg2img') { const info = imgMenuInfo; hideImgMenu(); sendToMode(info, 'img2img'); return; }
      if (mi === 'tot2i') { const info = imgMenuInfo; hideImgMenu(); sendPromptToT2I(info); return; }
      hideImgMenu();
      heroNotice('「' + label + '」功能待接入工作流', 'warn');
    });
    $('#imgSub').addEventListener('click', e => {
      const b = e.target.closest('[data-target]'); if (!b) return;
      const info = imgMenuInfo, target = b.dataset.target;
      hideImgMenu();
      upscaleFromInfo(info, target);
    });
    document.addEventListener('click', e => {
      const menu = $('#imgMenu');
      if (!e.target.closest('#imgMenu') && !e.target.closest('#imgSub') && !menu.dataset.justOpened) hideImgMenu();
    });
    $('#refreshCatalog').addEventListener('click', async () => {
      try {
        const r = await api('/api/catalog?force=1');
        state.catalog = r.catalog || {};
        state.gguf = state.catalog.gguf || {};
        fillParams(); renderHelp();
        heroNotice('模型清单已刷新 · ' + ((state.catalog.unets || []).length + (state.catalog.unets_gguf || []).length) + ' 个主模型');
      } catch (e) { heroNotice('刷新失败：' + e.message, 'error'); }
    });
    $('#comfySave').addEventListener('click', saveComfyBase);
    $('#comfyDirSave').addEventListener('click', saveComfyDir);
    $('#p_comfy_dir').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveComfyDir(); }
    });
    $('#comfyTest').addEventListener('click', testComfyBase);
    $('#logsRefresh').addEventListener('click', refreshStatus);
    $('#polishFetchModels').addEventListener('click', fetchPolishModels);
    $('#polishSave').addEventListener('click', savePolishSettings);
    $('#p_polish_provider').addEventListener('change', togglePolishSource);
    $('#homeCloud').addEventListener('click', e => {
      const chip = e.target.closest('[data-cloud-prompt]');
      if (!chip) return;
      state.draft = chip.dataset.cloudPrompt;
      $$('.composer-input').forEach(x => { x.value = state.draft; });
      updateComposer();
      const ta = $('#composerHome .composer-input'); if (ta) ta.focus();
    });
    $('#p_cloud_enabled').addEventListener('change', e => {
      state.params.cloud_enabled = e.target.checked;
      persistParams(); renderCloud();
      heroNotice(e.target.checked ? '已开启提示词推荐云' : '已关闭提示词推荐云');
    });
    $('#cloudSave').addEventListener('click', () => {
      const ta = $('#p_cloud_custom'); if (!ta) return;
      state.params.cloud_custom = ta.value || '';
      persistParams(); renderCloud();
      const n = String(state.params.cloud_custom).split('\n').filter(x => x.trim()).length;
      heroNotice(n ? '已保存 ' + n + ' 条自定义推荐词' : '已清空自定义推荐词');
    });
    $('#cvGapSave').addEventListener('click', async () => {
      const clamp = v => Math.max(8, Math.min(120, Number(v) || 0));
      const x = clamp($('#p_cv_gap_x')?.value) || 28;
      const y = clamp($('#p_cv_gap_y')?.value) || 28;
      state.params.canvas_gap_x = x;
      state.params.canvas_gap_y = y;
      persistParams();
      if ($('#p_cv_gap_x')) $('#p_cv_gap_x').value = x;
      if ($('#p_cv_gap_y')) $('#p_cv_gap_y').value = y;
      // 同步到画布：正在自由画布就直接按新间距重排，其他页面保存后下次进画布生效
      if (state.view === 'canvas') {
        const z = await doArrangeCanvas();
        heroNotice('已同步到画布 · 横向 ' + x + ' / 纵向 ' + y + 'px' + (z ? ' · 缩放 ' + Math.round(z * 100) + '%' : ''));
      } else {
        heroNotice('已保存：横向 ' + x + ' / 纵向 ' + y + 'px，进入自由画布点「▦ 整理」生效');
      }
    });
    $('#editPromptBtn').addEventListener('click', openPromptModal);
    $('#promptModalClose').addEventListener('click', closePromptModal);
    $('#promptModalCancel').addEventListener('click', closePromptModal);
    $('#promptModal').addEventListener('click', e => { if (e.target.id === 'promptModal') closePromptModal(); });
    $('#promptModalSave').addEventListener('click', savePromptModal);
    $('#m_sys_reset').addEventListener('click', resetPromptModal);
    // 高清放大设置
    $('#upSave').addEventListener('click', saveUpscaleSettings);
    $('#upRefresh').addEventListener('click', async () => {
      try {
        const r = await api('/api/catalog?force=1');
        state.catalog = r.catalog || {};
        state.gguf = state.catalog.gguf || {};
        fillParams(); fillUpscaleSettings(); renderHelp();
        heroNotice('放大模型清单已刷新');
      } catch (e) { heroNotice('刷新失败：' + e.message, 'error'); }
    });
    // 队列小窗
    $('#queuePill').addEventListener('click', openQueueModal);
    $('#chatDeleteBtn').addEventListener('click', deleteCurrentSession);
    $('#queueClose').addEventListener('click', () => $('#queueModal').classList.add('hidden'));
    $('#queueModal').addEventListener('click', e => { if (e.target.id === 'queueModal') $('#queueModal').classList.add('hidden'); });
    $('#queueRefresh').addEventListener('click', loadQueueDetail);
    $('#queueInterrupt').addEventListener('click', async () => {
      await api('/api/interrupt', { method: 'POST' });
      heroNotice('已发送中断请求');
      // 立刻轮询一次让被中断的任务收尾；再稍等一拍刷新队列小窗
      window.setTimeout(pollJobs, 300);
      window.setTimeout(loadQueueDetail, 600);
    });
    $('#queueClear').addEventListener('click', async () => {
      if (!(await confirmDialog('清空所有排队中的任务？（正在执行的那个不受影响）'))) return;
      try {
        const r = await api('/api/queue/clear', { method: 'POST' });
        heroNotice('已清空 ' + (r.cleared || 0) + ' 个排队任务');
        // 被清掉的排队任务不会再进 history，立刻轮询让它们收尾（避免进度条卡住）
        window.setTimeout(pollJobs, 300);
        loadQueueDetail();
      } catch (e) { heroNotice('清空失败：' + e.message, 'error'); }
    });
    bindMaskModal();
    document.addEventListener('click', e => {
      if (!e.target.closest('.popover') && !e.target.closest('[data-cact="skill"]')) hidePopover();
    });
  }

  function switchView(v) {
    state.view = v;
    try { localStorage.setItem('cyui_view', v); } catch (e) { /* 隐私模式忽略 */ }
    $$('.view').forEach(x => x.classList.add('hidden'));
    const el = $('#view' + v[0].toUpperCase() + v.slice(1));
    if (el) el.classList.remove('hidden');
    $$('#mainNav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    const names = { home: '创作', chat: '对话', canvas: '自由画布', skills: '技能库', gallery: '作品图库', help: '帮助', settings: '全局设置' };
    const title = v === 'chat' && state.sessionId ? (state.sessions.find(s => s.id === state.sessionId) || {}).title || '对话' : names[v];
    $('#crumb').innerHTML = esc(names[v]) + ' <em>/</em> ' + esc(title);
    const showDel = !!((v === 'chat' || v === 'canvas') && state.sessionId);
    ['#chatDeleteBtn', '#cvDeleteBtn'].forEach(s => {
      const b = $(s); if (b) b.classList.toggle('hidden', !showDel);
    });
    if (v === 'gallery') refreshGallery();
    if (v === 'home') renderCloud();
    if (v === 'chat') renderChat();   // 从画布 / 其他页切回对话模式时重绘当前会话
    if (v === 'settings') { refreshStatus(); fillPolishSettings(); fillComfyBase(); fillUpscaleSettings(); fillUiSettings(); probeComfyDir(); }
    if (v === 'skills') { renderSkillCards(); renderAssistantSkills(); }
    if (v === 'help') renderHelp();
    if (v === 'canvas') {
      assignMissingSlots(false);   // 同步补坐标
      renderCanvas();              // 立即渲染（切画布即刻可见）
      assignMissingSlots(true);    // 新分配的坐标异步落盘
      cvEnsureView();              // 首次进入：定位到内容或画布原点
    }
    const toggle = $('#gotoCanvas');
    if (toggle) toggle.textContent = v === 'canvas' ? '▤ 对话模式' : '⬚ 自由画布';
    // 画布是一个「新页面」：URL 也跟着变，刷新后仍留在画布
    if (typeof history !== 'undefined' && history.replaceState) {
      if (v === 'canvas') history.replaceState(null, '', '#canvas');
      else if (typeof location !== 'undefined' && location.hash === '#canvas') history.replaceState(null, '', '#home');
    }
  }

  function persistSessionId(sid) {
    try {
      if (sid) localStorage.setItem('cyui_session', sid);
      else localStorage.removeItem('cyui_session');
    } catch (e) { /* 忽略 */ }
  }

  function newChat(keepView) {
    state.sessionId = null; state.messages = []; state.draft = '';
    state.images = []; state.mask = null;
    persistSessionId(null);
    renderChat(); renderRefs(); updateComposer();
    if (!keepView) switchView('home');
    $('#viewHome').scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* 侧栏「＋ 新建对话」：在任意页面都真正创建一个后端会话，
     侧栏「最近对话」与 AI 助手「历史对话」共用这一条会话（完全打通） */
  async function createNewChat() {
    newChat();                       // 清空当前状态、从任何页面回到创作首页
    try {
      const r = await post('/api/sessions', { title: '新对话' });
      const s = r.session || {};
      if (!s.id) return;
      state.sessionId = s.id;
      state.messages = [];
      persistSessionId(s.id);
      await refreshSessions();
      aiOnSessionsChanged();
      heroNotice('已新建对话');
    } catch (e) { heroNotice('新建对话失败：' + e.message, 'error'); }
  }

  /* 对话模式顶栏的「删除对话」：联动删除该对话在自由画布 / 图库中的作品 */
  async function deleteCurrentSession() {
    if (!state.sessionId) return heroNotice('当前没有可删除的对话', 'error');
    const s = state.sessions.find(x => x.id === state.sessionId) || {};
    if (!(await confirmDialog('删除对话「' + (s.title || '当前对话') + '」？将同步移除它在自由画布 / 作品图库中的图片。'))) return;
    try {
      const r = await post('/api/sessions/batch-delete', { ids: [state.sessionId] });
      await applyLinkedDeletion(r);
      heroNotice('对话已删除');
    } catch (e) { heroNotice('删除失败：' + e.message, 'error'); }
  }

  /* ---------------- 输入框 ---------------- */
  function composerHTML(scope) {
    return `<div class="composer-box" data-scope="${scope}">
      <div class="ref-strip"></div>
      <textarea class="composer-input" placeholder="描述你想创作的画面…"></textarea>
      <div class="composer-foot">
        <div class="tools-left">
          <button class="tool" data-cact="skill">▦ 技能 <span data-role="skillLabel"></span></button>
          <button class="tool" data-cact="size">▣ 尺寸 <span data-role="sizeLabel"></span></button>
          <button class="tool mask-tool hidden" data-cact="mask">◎ 绘制遮罩</button>
          <button class="tool" data-cact="params">⚙ 参数</button>
          <button class="tool" data-cact="polish" title="生成前先用 AI 润色提示词（来源在参数设置的「提示词润色」里选）">✨ 润色 <span data-role="polishLabel"></span></button>
          <button class="tool" data-cact="reverse" title="用本地 Qwen3-VL 把第 1 张参考图反推成提示词">🔍 反推</button>
        </div>
        <div class="tools-right"><span class="img-count" data-role="count"></span><button class="send-btn" data-cact="send">↑</button></div>
      </div>
      <input type="file" class="file-input" multiple accept="image/*" hidden>
    </div>`;
  }

  function mountComposer(scope) {
    const root = $('#composer' + scope); root.innerHTML = composerHTML(scope);
    const box = $('.composer-box', root);
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-cact]'); if (!b) return;
      const act = b.dataset.cact;
      if (act === 'send') generate();
      else if (act === 'params') openDrawer();
      else if (act === 'mask') openMask();
      else if (act === 'skill') showSkillPopover(b);
      else if (act === 'size') openSizeCard(b);
      else if (act === 'polish') togglePolish();
      else if (act === 'reverse') reverseFromImage(state.images[0]);
    });
    box.addEventListener('change', e => { if (e.target.classList.contains('file-input')) uploadFiles(e.target.files); e.target.value = ''; });
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
    box.addEventListener('drop', e => { e.preventDefault(); box.classList.remove('drag'); if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
    box.addEventListener('paste', e => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length) { e.preventDefault(); uploadFiles(files); }
    });
    const ta = $('.composer-input', box);
    ta.addEventListener('input', () => {
      state.draft = ta.value;
      $$('.composer-input').forEach(x => { if (x !== ta) x.value = ta.value; });
    });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); }
    });
  }

  function updateComposer() {
    const sk = skill();
    $$('.composer-box').forEach(box => {
      $('[data-role="skillLabel"]', box).textContent = sk.name;
      const sizeEl = $('[data-role="sizeLabel"]', box);
      if (sizeEl) {
        // 尺寸标签统一由 sizeLabelText() 决定：自动且带参考图时是「跟随图1」，
        // 按比例时是「16:9 · 1K」，原图像素时是「原图像素」
        sizeEl.textContent = sizeLabelText();
      }
      const batchEl = $('[data-role="batchLabel"]', box);
      if (batchEl) batchEl.textContent = '×' + (state.params.batch || 1);
      const polishEl = $('[data-role="polishLabel"]', box);
      if (polishEl) polishEl.textContent = state.params.polish ? '开' : '关';
      const polishBtn = $('[data-cact="polish"]', box);
      if (polishBtn) polishBtn.classList.toggle('accent', !!state.params.polish);
      $('[data-role="count"]', box).textContent = state.images.length + '/' + cap();
      $('.composer-input', box).placeholder = sk.placeholder || '描述你想创作的画面…';
      $('.mask-tool', box).classList.toggle('hidden', !sk.needs_mask);
      $('[data-cact="mask"]', box).classList.toggle('accent', !!state.mask);
      $('.composer-input', box).value = state.draft;
    });
    renderRefs();
    renderCloud();
  }

  /* 提示词推荐云：只出现在创作首页，按当前技能渲染 + 用户自定义词条 */
  function renderCloud() {
    const el = $('#homeCloud');
    if (!el) return;
    const enabled = state.params.cloud_enabled !== false && state.view === 'home';
    el.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const sk = skill();
    const modeEl = $('[data-role="cloudMode"]', el);
    if (modeEl) modeEl.textContent = sk.name;
    const custom = String(state.params.cloud_custom || '').split('\n')
      .map(x => x.trim()).filter(Boolean).slice(0, 60);
    const groups = (sk.cloud || []).concat(custom.length ? [{ cat: '自定义', items: custom }] : []);
    const body = $('.pc-body', el);
    if (!body) return;
    // 标签云：打散成一组大小、透明度不一的标签，铺满整行
    const flat = [];
    groups.forEach((g, gi) => (g.items || []).forEach(t => flat.push({ t, cat: g.cat, gi })));
    body.innerHTML = flat.length ? `<div class="pc-flow">${flat.map((it, i) => {
      const len = it.t.length;
      const size = (11.2 + (len % 5) * 0.75 + (i % 3) * 0.3).toFixed(1);
      const dy = ((i * 37) % 5) - 2;
      const rot = (((i * 53) % 5) - 2) * 0.35;
      const op = (0.68 + ((i * 29) % 5) * 0.07).toFixed(2);
      return `<button class="pc-tag c${it.gi % 6}" style="font-size:${size}px;--dy:${dy}px;--rot:${rot}deg;opacity:${op}" data-cloud-prompt="${esc(it.t)}" title="${esc(it.cat)} · ${esc(it.t)}">${esc(it.t)}</button>`;
    }).join('')}</div>` : '<div class="pc-empty">当前模式暂无推荐词</div>';
  }

  function renderRefs() {
    const html = state.images.map((im, i) => `
      <div class="ref-item ${i === 0 && state.mask ? 'mask-ok' : ''}" title="${esc(im.original || im.name)}">
        <img src="${esc(im.url)}" alt="参考图${i + 1}">
        <span class="idx">图${i + 1}</span>
        <button class="del" data-ref="${i}" title="移除">×</button>
      </div>`).join('') + `<button class="ref-add" data-ref="add" title="添加参考图">＋</button>`;
    $$('.ref-strip').forEach(el => { el.innerHTML = html; });
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ref]'); if (!b) return;
    if (b.dataset.ref === 'add') {
      // 不再直接弹文件名选择框：先打开图片选择弹窗（历史输入 / 上传 / 粘贴）
      openImgPicker('composer');
      return;
    }
    const i = Number(b.dataset.ref);
    state.images.splice(i, 1);
    if (i === 0) state.mask = null;
    renderRefs(); updateComposer();
  });

  /* ---------------- 图片选择弹窗 ----------------
     对话 / 自由画布 / AI 窗口三个输入口共用一个弹窗：
       · 网格 6 列展示图片，两个来源切换：历史输入（ComfyUI input）、我的作品（data/results）
       · 单击选中（上限由当前技能决定，cap()===1 即单选，AI 窗口固定 3 张）
       · 双击看图片信息（尺寸 / 大小 / 时间 / 来源）
       · 弹窗里可直接上传多张，也可以 Ctrl+V 粘贴或拖进来 */
  const picker = {
    open: false, target: 'composer', items: [], picked: new Map(),
    added: new Set(), limit: 1, dir: '', loading: false, source: 'input',
  };

  function pickerLimit(target) {
    return target === 'ai' ? 3 : Math.max(0, cap());
  }

  async function openImgPicker(target) {
    const limit = pickerLimit(target);
    if (!limit) return heroNotice('「' + skill().name + '」不需要参考图，请先切换技能', 'error');
    const have = target === 'ai' ? state.ai.images : state.images;
    if (limit > 1 && have.length >= limit) {
      return heroNotice('已达上限 ' + limit + ' 张，先移除一张再加', 'warn');
    }
    picker.target = target;
    picker.limit = limit;
    picker.picked = new Map();
    picker.added = new Set(have.map(i => i.name).filter(Boolean));
    picker.open = true;
    picker.source = 'input';
    syncPickTab();
    $('#pickMode').textContent = target === 'ai'
      ? 'AI 附件 · 最多 3 张'
      : (limit === 1 ? '单选' : '最多 ' + limit + ' 张');
    $('#pickTip').textContent = target === 'ai'
      ? '点一下选中，双击看图片信息；也可以 Ctrl+V 粘贴或把图拖进这个窗口。'
      : '点一下选中，双击看图片信息；也可以 Ctrl+V 粘贴或把图拖进这个窗口。已选 ' + have.length + '/' + limit + ' 张。';
    $('#pickMask').classList.remove('hidden');
    $('#pickCard').classList.remove('hidden');
    renderPickGrid();
    await loadPickItems();
  }

  function closeImgPicker() {
    picker.open = false;
    $('#pickMask').classList.add('hidden');
    $('#pickCard').classList.add('hidden');
  }

  function syncPickTab() {
    document.querySelectorAll('#pickTabs .pick-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.src === picker.source);
    });
  }

  async function pickSwitchSource(src) {
    if (picker.source === src) return;
    picker.source = src;
    picker.items = [];
    syncPickTab();
    await loadPickItems();
  }

  async function loadPickItems() {
    picker.loading = true;
    renderPickGrid();
    const want = picker.source;
    try {
      const r = await api('/api/inputs?limit=180&source=' + encodeURIComponent(want));
      if (want !== picker.source) return;  /* 切得太快，丢掉过期响应 */
      picker.items = r.images || [];
      picker.dir = r.dir || '';
    } catch (e) {
      picker.items = [];
      heroNotice((want === 'result' ? '读取作品失败：' : '读取历史图片失败：') + e.message, 'error');
    }
    picker.loading = false;
    renderPickGrid();
  }

  function renderPickGrid() {
    const grid = $('#pickGrid'), empty = $('#pickEmpty');
    const items = picker.items;
    empty.classList.toggle('hidden', items.length > 0);
    grid.classList.toggle('hidden', items.length === 0);
    if (!items.length) {
      if (picker.loading) {
        empty.innerHTML = '<b>正在读取…</b><span>第一次打开要生成缩略图，稍等一下</span>';
      } else if (picker.source === 'result') {
        empty.innerHTML = '<b>还没有作品</b><span>生成的图会自动收进这里，之后能直接当参考图用。</span>';
      } else if (picker.dir) {
        empty.innerHTML = '<b>还没有历史图片</b><span>点右上角「上传」，或把图片拖进这个窗口 / 直接 Ctrl+V 粘贴</span>';
      } else {
        empty.innerHTML = '<b>读不到 ComfyUI 的 input 目录</b><span>ComfyUI 在另一台机器时只能列出本工具传过的图。'
          + '在本机的话，去设置里填一下 ComfyUI 根目录即可。</span>'
          + '<button class="ghost-btn" id="pickGotoSettings">去设置里填目录</button>';
      }
      updatePickFooter();
      return;
    }
    grid.innerHTML = items.map(it => {
      const added = picker.added.has(it.name);
      const sel = picker.picked.has(it.name);
      const wh = (it.width && it.height) ? `<span class="pick-wh">${it.width}×${it.height}</span>` : '';
      return `<button type="button" class="pick-cell${sel ? ' sel' : ''}${added ? ' added' : ''}"
        data-pick="${esc(it.name)}" data-src="${esc(it.source || '')}" title="${esc(it.name)}">
        <img loading="lazy" src="${esc(it.thumb)}" alt="">${wh}</button>`;
    }).join('');
    updatePickFooter();
  }

  function updatePickFooter() {
    const n = picker.picked.size;
    $('#pickSelInfo').textContent = n
      ? '已选 ' + n + ' 张' + (picker.limit > 1 ? '（上限 ' + picker.limit + '）' : '')
      : '已选 0 张';
    $('#pickDone').textContent = n ? '加入 ' + n + ' 张' : '加入';
  }

  /* 只改 class，不重建 DOM：历史图多的时侯重建整个网格（上百个 <img>）会明显闪 */
  function syncPickSelection() {
    document.querySelectorAll('#pickGrid .pick-cell').forEach(c => {
      c.classList.toggle('sel', picker.picked.has(c.dataset.pick));
    });
    updatePickFooter();
  }

  /* 选中项存 item 对象而不是文件名：两个页签是两批 items，只记文件名的话
     切页签后先前那批的图在 pickCommit 里就找不着了（跨页签选择会丢图） */
  function pickToggle(name) {
    if (picker.added.has(name)) return heroNotice('这张已经在里面了');
    if (picker.picked.has(name)) {
      picker.picked.delete(name);
    } else {
      if (picker.limit === 1) {
        picker.picked.clear();
      } else if (picker.picked.size + picker.added.size >= picker.limit) {
        return heroNotice('最多选 ' + picker.limit + ' 张', 'warn');
      }
      const it = picker.items.find(i => i.name === name);
      if (it) picker.picked.set(name, it);
    }
    syncPickSelection();
  }

  async function pickCommit() {
    let picked = Array.from(picker.picked.values());
    if (!picked.length) return closeImgPicker();
    /* 作品图正常情况下生成时就回灌进 input 了；少数回灌失败 / 被清掉的要在
       这里补一次转换，否则 LoadImage 找不到文件、整个任务会校验失败 */
    const todo = picked.filter(it => it.need_convert);
    if (todo.length) {
      const btn = $('#pickDone');
      btn.disabled = true; btn.textContent = '准备中…';
      for (const it of todo) {
        try {
          const r = await post('/api/assistant/image-to-input', { url: it.url });
          if (r && r.name) {
            it.name = r.name;
            it.url = r.url || it.url;
            it.need_convert = false;
          }
        } catch (e) {
          heroNotice('这张作品暂时用不了：' + e.message, 'warn');
        }
      }
      btn.disabled = false;
      picked = picked.filter(it => !it.need_convert);
      if (!picked.length) { updatePickFooter(); return; }
    }
    if (picker.target === 'ai') {
      let n = 0;
      picked.forEach(it => {
        if (state.ai.images.length >= 3) return;
        if (state.ai.images.some(x => x.name === it.name)) return;
        state.ai.images.push({
          name: it.name, url: it.url,
          width: Number(it.width) || 0, height: Number(it.height) || 0,
        });
        n++;
      });
      aiRenderAttach();
      heroNotice(n ? '已加入 ' + n + ' 张附件' : '没有新增');
    } else {
      const limit = cap();
      if (limit === 1) { state.images = []; state.mask = null; }
      let n = 0;
      picked.forEach(it => {
        if (state.images.length >= limit) return;
        if (state.images.some(x => x.name === it.name)) return;
        state.images.push({
          name: it.name, url: it.url,
          width: Number(it.width) || 0, height: Number(it.height) || 0,
          size: Number(it.size) || 0, original: it.name,
        });
        n++;
      });
      if (!state.images.length) state.mask = null;
      renderRefs(); updateComposer();
      heroNotice(n ? '已加入 ' + n + ' 张参考图' : '没有新增');
    }
    closeImgPicker();
  }

  async function pickUploadFiles(files) {
    const list = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!list.length) return heroNotice('请选择图片文件', 'warn');
    const fd = new FormData();
    list.forEach(f => fd.append('image', f));
    $('#pickUpload').disabled = true;
    try {
      const r = await api('/api/upload', { method: 'POST', body: fd });
      const got = r.images || [];
      // 刚上传的直接勾上，省一次点击
      got.forEach(im => {
        if (picker.limit === 1) picker.picked.clear();
        if (picker.picked.size + picker.added.size < picker.limit) {
          picker.picked.set(im.name, im);
        }
      });
      /* 上传的图落在 ComfyUI input，切回「历史输入」才看得见 */
      if (picker.source !== 'input') { picker.source = 'input'; syncPickTab(); }
      await loadPickItems();
      heroNotice('已上传 ' + got.length + ' 张');
    } catch (e) {
      heroNotice('上传失败：' + e.message, 'error');
    }
    $('#pickUpload').disabled = false;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (!n) return '—';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function openPicInfo(it) {
    if (!it) return;
    $('#pfImg').src = it.url || it.thumb || '';
    const rows = [
      ['文件名', it.label || it.name || '—'],
      ['尺寸', (it.width && it.height) ? it.width + ' × ' + it.height : '—'],
      ['大小', fmtBytes(it.size)],
      ['时间', it.mtime ? new Date(it.mtime * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'],
      ['来源', it.source === 'upload' ? '本工具上传'
        : it.source === 'result' ? '我的作品（data/results）'
        : 'ComfyUI input 目录'],
    ];
    $('#pfMeta').innerHTML = rows
      .map(r => `<span class="pf-k">${r[0]}</span><span class="pf-v">${esc(r[1])}</span>`)
      .join('');
    $('#pfMask').classList.remove('hidden');
    $('#pfCard').classList.remove('hidden');
  }

  function closePicInfo() {
    $('#pfMask').classList.add('hidden');
    $('#pfCard').classList.add('hidden');
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!list.length) return heroNotice('请选择图片文件', 'warn');
    const limit = cap();
    if (limit === 0) return heroNotice('「' + skill().name + '」不需要参考图，请先切换技能', 'error');
    const room = limit - state.images.length;
    if (room <= 0) return heroNotice('参考图已达上限 ' + limit + ' 张', 'warn');
    const fd = new FormData();
    list.slice(0, room).forEach(f => fd.append('image', f));
    try {
      const r = await api('/api/upload', { method: 'POST', body: fd });
      (r.images || []).forEach(im => state.images.push(im));
      renderRefs(); updateComposer();
      heroNotice('已上传 ' + (r.images || []).length + ' 张参考图');
    } catch (e) { heroNotice('上传失败：' + e.message, 'error'); }
  }

  /* ---------------- AI 反推（本地 Qwen3-VL 单图） ---------------- */
  function llmPayload() {
    const l = state.llm || {};
    return {
      model: l.model,
      max_length: Number(l.max_length) || 512,
      thinking: !!l.thinking,
    };
  }
  async function reverseFromImage(img) {
    if (!img) {
      return heroNotice(skill().max_images
        ? '先上传一张参考图，再点「反推」'
        : '先切到「图生图 / 图片编辑 / 局部重绘」并上传参考图，再反推', 'warn');
    }
    await doReverse(img.name);
  }
  /* 长任务画布进度条的动态计时：把「无限转圈」变成可感知的等待 */
  function cvProgressTimer(prefix, ms) {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      setCvProgress(prefix + '（已等待 ' + sec + 's' + (ms ? '，通常 ' + ms : '') + '）', 6);
    }, 2000);
    return () => clearInterval(iv);
  }
  async function doReverse(name) {
    setCvProgress('AI 正在反推画面提示词…（首次加载模型约 1 分钟）', 6);
    const stopRevTimer = cvProgressTimer('AI 正在反推画面提示词…', '本地模型生成约 1~3 分钟');
    try {
      const provider = state.params.polish_provider || 'local';
      const r = await post('/api/reverse', {
        image: name,
        llm: llmPayload(),
        provider,
        api_key: state.params.deepseek_key || '',
        vision_model: state.params.deepseek_vision || DEEPSEEK_VISION_DEFAULT,
      });
      state.draft = r.text || '';
      $$('.composer-input').forEach(x => { x.value = state.draft; });
      updateComposer();
      stopRevTimer();
      clearCvProgress();
      heroNotice('反推完成（' + (r.seconds || 0) + 's · ' + (provider === 'deepseek' ? 'DeepSeek' : '本地 Qwen3-VL') + '），已填入输入框');
      if (state.view !== 'home' && state.view !== 'chat' && state.view !== 'canvas') switchView('home');
      const ta = $('.composer-input'); if (ta) ta.focus();
    } catch (e) { stopRevTimer(); clearCvProgress(); heroNotice('反推失败：' + e.message, 'error'); }
    finally { stopRevTimer(); }
  }
  async function reverseFromUrl(url) {
    try {
      setCvProgress('正在上传图片…', 4);
      const blob = await (await fetch(url)).blob();
      const fd = new FormData();
      fd.append('image', new File([blob], 'cyui_reverse.png', { type: 'image/png' }));
      const up = await api('/api/upload', { method: 'POST', body: fd });
      const im = (up.images || [])[0];
      if (!im) throw new Error('上传失败');
      await doReverse(im.name);
    } catch (e) { clearCvProgress(); heroNotice('反推失败：' + e.message, 'error'); }
  }

  /* ---------------- 技能 ---------------- */
  function setMode(id) {
    if (!state.skillMap[id]) return;
    state.mode = id;
    const sk = skill();
    if (state.images.length > cap()) { state.images = state.images.slice(0, cap()); heroNotice('已按技能上限保留 ' + cap() + ' 张参考图', 'warn'); }
    if (!sk.needs_mask) state.mask = null;
    state.params.denoise = sk.denoise;
    $('#p_denoise').value = sk.denoise; $('#denoiseVal').textContent = Number(sk.denoise).toFixed(2);
    renderSkillNav(); updateComposer();
    heroNotice('已切换到「' + sk.name + '」');
  }

  function renderSkillNav() {
    const el = $('#skillNav'); if (!el) return;
    el.innerHTML = state.skills.map(s =>
      `<button data-skill="${s.id}" class="${s.id === state.mode ? 'active' : ''}"><b>${s.icon}</b>${esc(s.name)}</button>`).join('');
  }
  function renderSkillFilters() {
    const el = $('#skillFilters'); if (!el) return;
    const groups = ['推荐', '基础生成', '图像编辑'];
    el.innerHTML = groups.map(g =>
      `<button class="filter-chip ${g === state.filter ? 'active' : ''}" data-filter="${g}">${g}</button>`).join('');
  }
  function renderSkillCards() {
    const list = state.filter === '推荐' ? state.skills : state.skills.filter(s => s.group === state.filter);
    const html = list.map(s => `
      <button class="skill-card" data-skill="${s.id}">
        <div class="skill-cover" style="background:linear-gradient(135deg,${s.color},${shade(s.color)})">
          <span class="glyph">${s.icon}</span><span class="corner">${esc(s.tag)}</span>
        </div>
        <div class="skill-body"><h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p><span class="tag">${esc(s.group)}</span></div>
      </button>`).join('');
    const home = $('#skillGrid'), all = $('#skillGridAll');
    if (home) home.innerHTML = html;
    if (all) all.innerHTML = html;
  }
  function shade(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, (n >> 16) - 55), g = Math.max(0, ((n >> 8) & 255) - 45), b = Math.max(0, (n & 255) - 20);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function onSkillCardClick(e) {
    const b = e.target.closest('button[data-skill]'); if (!b) return;
    setMode(b.dataset.skill); switchView('home');
    window.setTimeout(() => $('.composer-input').focus(), 80);
    $('#viewHome').scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------- 弹层菜单 ---------------- */
  function showPopover(anchor, html, onPick) {
    const p = $('#popover');
    p.innerHTML = html; p.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    // 先量真实宽高：底部创作区的按钮必须向上翻转，否则弹层超出视口被裁掉、选项点不到
    const ph = (typeof p.offsetHeight === 'number' && isFinite(p.offsetHeight) && p.offsetHeight > 0) ? p.offsetHeight : 260;
    const pw = (typeof p.offsetWidth === 'number' && isFinite(p.offsetWidth) && p.offsetWidth > 0) ? p.offsetWidth : 232;
    let left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.onclick = e => {
      const b = e.target.closest('button[data-val]'); if (!b) return;
      // onPick 返回 false = 校验未通过，保留弹层让用户改
      if (onPick(b.dataset.val) !== false) hidePopover();
    };
  }
  function hidePopover() {
    const p = $('#popover');
    p.classList.add('hidden');
    p.onchange = null; p.oninput = null;   // 清理 LoRA 弹层的委托
  }
  function showSkillPopover(anchor) {
    showPopover(anchor, '<div class="pop-title">选择技能</div>' + state.skills.map(s =>
      `<button data-val="${s.id}" class="${s.id === state.mode ? 'active' : ''}"><b>${s.icon}</b>${esc(s.name)} · ${esc(s.tag)}</button>`).join(''),
      v => setMode(v));
  }
  /* ---------------- 尺寸 / 张数参数 ----------------
     「生成参数」抽屉只保留：图片比例、分辨率、自定义尺寸、生成张数。
     分辨率档位 = 图片最长边像素；另一边按比例自动计算，并对齐到 8 像素
     （ComfyUI 的 EmptyLatentImage 以 //8 生成 latent，避免显示与实际出图不一致）。 */
  const RATIOS = [
    { key: '1:1', w: 1, h: 1 }, { key: '16:9', w: 16, h: 9 },
    { key: '9:16', w: 9, h: 16 }, { key: '3:4', w: 3, h: 4 },
    { key: '4:3', w: 4, h: 3 }, { key: '3:2', w: 3, h: 2 },
    { key: '2:3', w: 2, h: 3 }, { key: '21:9', w: 21, h: 9 },
  ];
  const RES_LONG = { '1K': 1024, '1.5K': 1536, '2K': 2048 };
  function sizeFrom(ratioKey, resKey) {
    const r = RATIOS.find(x => x.key === ratioKey) || RATIOS[0];
    const long = RES_LONG[resKey] || 1024;
    let w, h;
    if (r.w >= r.h) { w = long; h = long * r.h / r.w; }
    else { h = long; w = long * r.w / r.h; }
    return { w: Math.max(64, Math.round(w / 8) * 8), h: Math.max(64, Math.round(h / 8) * 8) };
  }
  function isPresetSize() {
    const p = state.params;
    if (!p.ratio || !RES_LONG[p.res_level] || p.ratio === '自定义') return false;
    const s = sizeFrom(p.ratio, p.res_level);
    return Number(p.width) === s.w && Number(p.height) === s.h;
  }
  /* 尺寸来源三选一，和后端 workflows.resolve_canvas 一一对应：
       auto   有参考图时跟随图1（保持比例、只缩不放），无图回落到下面的比例预设
       fixed  严格按选定的比例 / 手填宽高出图
       native 参考图原始像素，只向上对齐到 32 的倍数
     之前这几个概念只靠一个藏在抽屉里的 custom_size 表达，前端标签写着
     「跟随图1」而实际画布由 resolution 另算，选什么都一样，所以对不上。 */
  const SIZE_MODE_TIPS = {
    auto: '有参考图时跟随图1：保持原图比例与像素，只缩不放。',
    fixed: '严格按下面选的比例和分辨率出图；有参考图时会被拉伸到这个比例。',
    native: '按参考图原始像素出图，只向上对齐到 32 的倍数，绝不缩放。',
  };
  function usesRefCanvas() {
    return (state.mode === 'img2img' || state.mode === 'inpaint') && !!state.images.length;
  }
  /* 与后端 fit_size 完全一致的预览算法，避免「界面说 A、实际出 B」 */
  function autoCanvasPreview() {
    if (!usesRefCanvas()) return null;
    const im = state.images[0] || {};
    const iw = Number(im.width) || 0, ih = Number(im.height) || 0;
    if (!iw || !ih) return null;
    const p = state.params;
    const budget = Math.max(Number(p.width) || 1024, Number(p.height) || 1024);
    const long = Math.max(iw, ih);
    const k = long > budget ? budget / long : 1;
    return { w: Math.max(32, Math.ceil(iw * k / 32) * 32),
             h: Math.max(32, Math.ceil(ih * k / 32) * 32) };
  }
  /* 原图像素模式的预览：只向上对齐到 32，不缩不放 */
  function nativeCanvasPreview() {
    if (!usesRefCanvas()) return null;
    const im = state.images[0] || {};
    const iw = Number(im.width) || 0, ih = Number(im.height) || 0;
    if (!iw || !ih) return null;
    return { w: Math.max(32, Math.ceil(iw / 32) * 32),
             h: Math.max(32, Math.ceil(ih / 32) * 32) };
  }
  function sizeLabelText() {
    const p = state.params;
    const mode = p.size_mode || 'auto';
    if (mode === 'auto') {
      if (autoCanvasPreview()) return '跟随图1';
      if (isPresetSize()) return p.ratio + ' · ' + p.res_level;
      return '自动';
    }
    if (mode === 'native') return '原图像素';
    if (isPresetSize()) return p.ratio + ' · ' + p.res_level;
    return '自定义▪' + (p.width || 1024) + 'x' + (p.height || 1024);
  }
  function renderParamPanel() {
    const p = state.params;
    const mode = p.size_mode || 'auto';
    const preset = isPresetSize();
    const ratio = preset ? p.ratio : '自定义';
    const res = preset ? p.res_level : '';
    const auto = mode === 'auto' ? autoCanvasPreview() : null;
    const nat = mode === 'native' ? nativeCanvasPreview() : null;

    $$('#p_sizeModeSeg button').forEach(b => b.classList.toggle('active', b.dataset.sizemode === mode));
    const tip = $('#sizeModeTip');
    if (tip) {
      if (mode === 'auto' && auto) {
        tip.textContent = '跟随图1：' + auto.w + '×' + auto.h + '（保持原图比例，只缩不放）';
      } else if (mode === 'auto' && usesRefCanvas()) {
        tip.textContent = '读不到参考图尺寸，先按下面的比例与分辨率出图。';
      } else if (mode === 'native' && nat) {
        tip.textContent = '原图像素：' + nat.w + '×' + nat.h + '（只向上对齐到 32 的倍数）';
      } else {
        tip.textContent = SIZE_MODE_TIPS[mode] || SIZE_MODE_TIPS.auto;
      }
      tip.classList.toggle('live', (mode === 'auto' && !!auto) || (mode === 'native' && !!nat));
    }
    // 自动 / 原图像素时，比例与手填尺寸不参与计算，置灰避免误以为已经生效
    const lock = mode !== 'fixed';
    $('#p_ratioGrid').classList.toggle('dim', lock);
    $('#p_resSeg').classList.toggle('dim', lock);
    const cw = $('#p_customW');
    if (cw && cw.closest('.custom-row')) cw.closest('.custom-row').classList.toggle('dim', lock);

    $('#p_ratioGrid').innerHTML = RATIOS.map(r => {
      const sc = 15 / Math.max(r.w, r.h);
      const bw = Math.max(5, Math.round(r.w * sc)), bh = Math.max(5, Math.round(r.h * sc));
      return `<button data-ratio="${r.key}" class="ratio-btn ${r.key === ratio ? 'active' : ''}" title="${r.key}">
        <span class="ratio-box" style="width:${bw}px;height:${bh}px"></span><span>${r.key}</span></button>`;
    }).join('');
    $$('#p_resSeg button').forEach(b => b.classList.toggle('active', b.dataset.res === res));
    const batch = Math.max(1, Math.min(8, Number(p.batch || 1)));
    const presetBatch = batch === 1 || batch === 2 || batch === 4;
    $$('#p_batchSeg button').forEach(b => b.classList.toggle('active', Number(b.dataset.batch) === batch));
    const bc = $('#p_batchCustom');
    if (bc && document.activeElement !== bc) bc.value = presetBatch ? '' : batch;
    $('#p_customW').value = p.width || 1024;
    $('#p_customH').value = p.height || 1024;

    const pv = auto || nat;
    const px = pv ? pv.w + 'x' + pv.h : ((p.width || 1024) + 'x' + (p.height || 1024));
    const prefix = mode === 'auto' ? (auto ? '跟随图1 · ' : '自动 · ')
      : mode === 'native' ? '原图像素 · '
        : (preset ? p.ratio + ' · ' + p.res_level + ' · ' : '自定义 · ');
    $('#p_summary').textContent = prefix + px + ' · ' + batch + '张';
  }
  function commitParamChange() { persistParams(); updateComposer(); renderParamPanel(); }
  function selectPreset(ratioKey, resKey) {
    const ratio = ratioKey || (isPresetSize() ? state.params.ratio : '1:1');
    const res = resKey || state.params.res_level || '1K';
    const s = sizeFrom(ratio, res);
    state.params.ratio = ratio; state.params.res_level = res;
    state.params.width = s.w; state.params.height = s.h;
    // 主动点了比例就说明要指定画布，自动从「自动」切到「按比例」，
    // 否则在自动模式下点这些按钮不会有任何效果，看起来像没反应
    if ((state.params.size_mode || 'auto') !== 'fixed') {
      state.params.size_mode = 'fixed';
      heroNotice('已切到按比例出图：' + s.w + '×' + s.h);
    }
    commitParamChange();
  }
  function applyCustomSize() {
    const w = Math.round(Number($('#p_customW').value));
    const h = Math.round(Number($('#p_customH').value));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64 || w > 4096 || h > 4096) {
      return heroNotice('请输入 64–4096 之间的正整数');
    }
    state.params.width = w; state.params.height = h;
    state.params.ratio = '自定义'; state.params.res_level = '';
    state.params.size_mode = 'fixed';
    commitParamChange(); heroNotice('自定义尺寸：' + w + 'x' + h);
  }
  /* 自定义生成张数：1~8，写进 batch 后与预设按钮一样即时生效 */
  function applyBatchCustom() {
    const n = Math.round(Number($('#p_batchCustom').value));
    if (!Number.isFinite(n) || n < 1 || n > 8) return heroNotice('请填 1–8 之间的整数张数', 'warn');
    state.params.batch = n;
    commitParamChange();
    heroNotice('每次生成 ' + n + ' 张');
  }

  /* ---------------- 参数抽屉 ---------------- */
  function openDrawer() { $('#drawer').classList.add('open'); $('#drawerMask').classList.add('open'); }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerMask').classList.remove('open'); }

  /* 独立的图片尺寸卡片：居中小卡片，和生成参数抽屉分开 */
  function openSizeCard() {
    renderParamPanel();
    $('#sizeCard').classList.remove('hidden');
    $('#sizeMask').classList.remove('hidden');
  }
  function closeSizeCard() {
    $('#sizeCard').classList.add('hidden');
    $('#sizeMask').classList.add('hidden');
  }
  function fillSelect(id, list, cur) {
    const el = $(id); if (!el) return;
    const items = list && list.length ? list : [cur];
    el.innerHTML = items.map(x => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
  }

  /* ---- 润色 / 反推设置（全局设置页）---- */
  const DEEPSEEK_VISION_DEFAULT = 'deepseek-v4-flash-vision-exp';
  function fillPolishSettings() {
    const p = state.params, l = state.llm || {};
    $('#p_polish_provider').value = p.polish_provider || 'local';
    $('#p_deepseek_key').value = p.deepseek_key || '';
    const sel = $('#p_deepseek_model');
    const cur = p.deepseek_model || 'deepseek-chat';
    if (!Array.from(sel.options).some(o => o.value === cur)) {
      const opt = document.createElement('option');
      opt.value = cur; opt.textContent = cur;
      sel.appendChild(opt);
    }
    sel.value = cur;
    $('#p_deepseek_vision').value = p.deepseek_vision || DEEPSEEK_VISION_DEFAULT;

    // 本地工作流：三类 LLM 模型（qwen3vl 多图 / gemma4 / qwen3.5 单图），节点与模板自动适配
    const def = state.llmDefault || {};
    const lcur = l.model || def.model || '';
    let clips = ((state.catalog || {}).clips || []).filter(m => /qwen3vl|gemma4|qwen3[._]5/i.test(m));
    if (!clips.length) clips = ((state.catalog || {}).clips || []).slice();
    if (lcur && !clips.includes(lcur)) clips.unshift(lcur);
    $('#p_llm_model').innerHTML = clips.length
      ? clips.map(m => `<option value="${esc(m)}" ${m === lcur ? 'selected' : ''}>${esc(m)}</option>`).join('')
      : '<option value="">（未检测到 CLIP 模型）</option>';
    $('#p_llm_maxlen').value = l.max_length || 512;
    $('#p_llm_think').checked = !!l.thinking;
    togglePolishSource();
    renderLlmStatus();
  }
  /* 系统提示词弹窗：本地 / DeepSeek 共用同一份 */
  function openPromptModal() {
    const l = state.llm || {}, d = state.llmDefault || {};
    const s = l.systems || {}, ds = d.systems || {};
    $('#m_sys_polish').value = s.polish || ds.polish || '';
    $('#m_sys_reverse').value = s.reverse || ds.reverse || '';
    $('#promptModal').classList.remove('hidden');
  }
  function closePromptModal() { $('#promptModal').classList.add('hidden'); }
  async function savePromptModal() {
    const btn = $('#promptModalSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await post('/api/settings', {
        llm: { systems: { polish: $('#m_sys_polish').value, reverse: $('#m_sys_reverse').value } },
      });
      if (r.llm) state.llm = r.llm;
      closePromptModal();
      heroNotice('系统提示词已保存（本地与 DeepSeek 共用）');
    } catch (e) { heroNotice('保存失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '保存';
  }
  function resetPromptModal() {
    const ds = (state.llmDefault || {}).systems || {};
    if (ds.polish) $('#m_sys_polish').value = ds.polish;
    if (ds.reverse) $('#m_sys_reverse').value = ds.reverse;
    heroNotice('已填入默认提示词，点「保存」生效');
  }
  function togglePolishSource() {
    const deep = $('#p_polish_provider').value === 'deepseek';
    $('#deepseekBox').classList.toggle('hidden', !deep);
    $('#llmLocalBox').classList.toggle('hidden', deep);
  }
  function renderLlmStatus() {
    const el = $('#llmStatus'); if (!el) return;
    if (!state.online) { el.textContent = 'ComfyUI 离线'; el.className = 'help-flag bad'; return; }
    const flags = ((state.catalog || {}).llm) || {};
    const ok = flags.textgen && flags.preview;
    el.textContent = ok ? '本地工作流就绪' : '缺少 TextGenerateV2 / PreviewAny';
    el.className = 'help-flag ' + (ok ? 'ok' : 'bad');
    const hint = $('#llmModelHint');
    if (hint) hint.textContent = ok
      ? '内置预设 app/presets/qwen3vl_text_gen.json · 首次加载 4B 权重约 1 分钟，之后单次 10~30 秒。'
      : '当前 ComfyUI 缺少 TextGenerateV2 或 PreviewAny（需 ComfyUI 0.44+），本地润色/反推不可用。';
  }
  async function savePolishSettings() {
    state.params.polish_provider = $('#p_polish_provider').value;
    state.params.deepseek_key = ($('#p_deepseek_key').value || '').trim();
    state.params.deepseek_model = $('#p_deepseek_model').value || 'deepseek-chat';
    state.params.deepseek_vision = ($('#p_deepseek_vision').value || '').trim() || DEEPSEEK_VISION_DEFAULT;
    persistParams(); updateComposer();
    const btn = $('#polishSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await post('/api/settings', {
        llm: {
          model: $('#p_llm_model').value,
          max_length: Number($('#p_llm_maxlen').value) || 512,
          thinking: $('#p_llm_think').checked,
        },
      });
      if (r.llm) state.llm = r.llm;
      renderLlmStatus();
      heroNotice('设置已保存（来源：' + (state.params.polish_provider === 'deepseek'
        ? 'DeepSeek · ' + state.params.deepseek_model : '本地 Qwen3-VL') + '）');
    } catch (e) { heroNotice('保存失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '保存设置';
  }
  function fillUiSettings() {
    const el = $('#p_cloud_enabled');
    if (el) el.checked = state.params.cloud_enabled !== false;
    const ta = $('#p_cloud_custom');
    if (ta) ta.value = String(state.params.cloud_custom || '');
    const gapX = $('#p_cv_gap_x');
    if (gapX) gapX.value = Math.max(8, Math.min(120, Number(state.params.canvas_gap_x) || Number(state.params.canvas_gap) || 28));
    const gapY = $('#p_cv_gap_y');
    if (gapY) gapY.value = Math.max(8, Math.min(120, Number(state.params.canvas_gap_y) || Number(state.params.canvas_gap) || 28));
  }

  /* ---- 高清放大设置 ---- */
  function renderUpStatus() {
    const el = $('#upStatus'); if (!el) return;
    if (!state.online) { el.textContent = 'ComfyUI 离线'; el.className = 'help-flag bad'; return; }
    const s = ((state.catalog || {}).seedvr2) || {};
    el.textContent = s.ready ? 'SeedVR2 就绪' : '缺少 SeedVR2 / TTP 节点';
    el.className = 'help-flag ' + (s.ready ? 'ok' : 'bad');
  }
  function fillUpscaleSettings() {
    const u = state.upscale || {}, d = state.upscaleDefaults || {};
    const s = ((state.catalog || {}).seedvr2) || {};
    $('#p_up_scale').value = u.scale || 2;
    $('#p_up_tile').value = String(u.tile_factor || 3);
    $('#p_up_res').value = String(u.resolution || 1024);

    const fill = (id, list, cur) => {
      list = (list || []).slice();
      if (cur && !list.includes(cur)) list.unshift(cur);
      $(id).innerHTML = list.length
        ? list.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
        : '<option value="">（未检测到模型）</option>';
    };
    fill('#p_up_dit', s.dit, u.dit || d.dit);
    fill('#p_up_vae', s.vae, u.vae || d.vae);
    fill('#p_up_attn', s.attention, u.attention_mode || d.attention_mode);
    renderUpStatus();
  }
  async function saveUpscaleSettings() {
    if (!$('#p_up_dit').value) return heroNotice('没有可用的 SeedVR2 放大模型，请先放到 models/SEEDVR2 并刷新', 'error');
    const btn = $('#upSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await post('/api/settings', {
        upscale: {
          scale: Number($('#p_up_scale').value) || 2,
          tile_factor: Number($('#p_up_tile').value) || 3,
          resolution: Number($('#p_up_res').value) || 1024,
          dit: $('#p_up_dit').value,
          vae: $('#p_up_vae').value,
          attention_mode: $('#p_up_attn').value,
        },
      });
      if (r.upscale) state.upscale = r.upscale;
      heroNotice('放大设置已保存（默认 ×' + (state.upscale.scale || 2) + '）');
    } catch (e) { heroNotice('保存失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '保存放大设置';
  }

  async function fetchPolishModels() {
    const key = ($('#p_deepseek_key').value || '').trim();
    if (!key) return heroNotice('请先填写 DeepSeek API Key', 'error');
    const btn = $('#polishFetchModels');
    btn.disabled = true; btn.textContent = '获取中…';
    try {
      const r = await post('/api/polish/models', { api_key: key });
      const ids = r.models || [];
      const sel = $('#p_deepseek_model');
      const cur = state.params.deepseek_model || 'deepseek-chat';
      sel.innerHTML = ids.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      if (!Array.from(sel.options).some(o => o.value === cur)) {
        const opt = document.createElement('option');
        opt.value = cur; opt.textContent = cur;
        sel.appendChild(opt);
      }
      sel.value = ids.includes(cur) ? cur : (ids[0] || cur);
      heroNotice('已获取 ' + ids.length + ' 个模型，选择后请点「保存设置」');
    } catch (e) { heroNotice('获取模型失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '获取 DeepSeek 模型';
  }
  /* 主模型 / CLIP 下拉：safetensors 与 GGUF 分组显示，GGUF 需插件支持 */
  function fillModelSelect(id, safeList, ggufList, cur) {
    const el = $(id); if (!el) return;
    safeList = safeList || []; ggufList = ggufList || [];
    const seen = new Set(safeList.concat(ggufList));
    let html = '';
    if (safeList.length) {
      html += '<optgroup label="safetensors">' + safeList.map(x =>
        `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('') + '</optgroup>';
    }
    if (ggufList.length) {
      html += '<optgroup label="GGUF · 量化底模">' + ggufList.map(x =>
        `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('') + '</optgroup>';
    }
    // 历史保存的模型已被删除：仍然保留一项，避免下拉显示成第一个造成误生成
    if (cur && !seen.has(cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)}（缺失）</option>`;
    if (!html) html = '<option value="">（没有可用模型）</option>';
    el.innerHTML = html;
  }
  function fillParams() {
    const c = state.catalog, p = state.params;
    fillModelSelect('#p_unet', c.unets, c.unets_gguf, p.unet);
    fillModelSelect('#p_clip', c.clips, c.clips_gguf, p.clip);
    fillSelect('#p_vae', c.vaes, p.vae); fillSelect('#p_sampler', c.samplers, p.sampler);
    fillSelect('#p_scheduler', c.schedulers, p.scheduler);
    $('#p_sampling').value = p.sampling || 'turbo';
    $('#p_resPreset').value = String(p.resolution);
    $('#p_max_images').value = p.max_images;
    // 抽屉里的「强制使用自定义画布」现在只是尺寸卡片「按比例」的镜像开关，
    // 二者永远同步，避免一个说自动、另一个把画布锁死
    $('#p_custom_size').checked = (p.size_mode || 'auto') === 'fixed';
    $('#p_steps').value = p.steps; $('#p_cfg').value = p.cfg;
    $('#p_denoise').value = p.denoise; $('#denoiseVal').textContent = Number(p.denoise).toFixed(2);
    $('#p_seed').value = p.seed;
    $('#p_cache_device').value = p.cache_device; $('#p_cache_dtype').value = p.cache_dtype;
    $('#p_negative').value = p.negative || '';
    const g = c.gguf || {};
    const hint = $('#ggufHint');
    if (hint) {
      hint.textContent = (g.unet || g.clip)
        ? '已检测到 GGUF 加载节点：.gguf 底模会走 UnetLoaderGGUF / CLIPLoaderGGUF。'
        : '未检测到 ComfyUI-GGUF 插件，.gguf 底模暂不可用（安装后点「刷新模型清单」）。';
    }
    renderLoraList(); syncSampling(); renderParamPanel();
  }
  /* 采样方案展示名（画布 / 队列 / 灯箱共用，避免各处各写一套三元判断） */
  function samplingLabel(v) {
    if (v === 'turbo') return 'Turbo 8 步';
    if (v === 'viggle') return 'Viggle 5 步加速';
    if (v === 'standard') return 'Standard';
    return '';
  }
  /* Viggle 5 步加速：官方要求 5 步 / CFG 1.0 / 无负向提示词，且必须叠在标准底模上。
     这里在 UI 层同步参数并自动换底模，用户不必记这些约束。 */
  function applyViggleParams() {
    const p = state.params;
    $('#p_steps').value = 5;
    $('#p_cfg').value = 1;
    $('#p_negative').value = '';
    p.steps = 5; p.cfg = 1; p.negative = '';
    // 底模本身是 turbo 蒸馏权重时换成同目录标准版，避免两个 student 叠加
    const cur = $('#p_unet').value || p.unet || '';
    if (/turbo/i.test(cur)) {
      const pool = (state.catalog.unets || []).concat(state.catalog.unets_gguf || []);
      const std = pickStandardUnet(cur, pool);
      if (std) {
        state._turboUnetLeft = cur;   // 记着，切回 Turbo 时还回去
        $('#p_unet').value = std; p.unet = std;
        heroNotice('Viggle 加速需要标准底模，已自动切换为 ' + shortName(std), 'warn');
      }
    }
    persistParams();
  }
  /* 从 Viggle 切回 Turbo 时把底模还原：不还原就成了「Turbo 方案 + 标准底模」
     的混搭，8 步固定 sigma 跑在标准权重上会糊 */
  function restoreTurboUnet() {
    const back = state._turboUnetLeft;
    if (!back) return;                       // 没被自动换过就不动
    const pool = (state.catalog.unets || []).concat(state.catalog.unets_gguf || []);
    if (pool.length && !pool.includes(back)) return;   // 原底模已被删掉
    const cur = $('#p_unet').value || state.params.unet || '';
    if (cur === back) { state._turboUnetLeft = ''; return; }
    $('#p_unet').value = back;
    state.params.unet = back;
    state._turboUnetLeft = '';
    persistParams();
    heroNotice('已切回 turbo 底模 ' + shortName(back));
  }
  /* 与后端 workflows.standard_unet_candidates 对齐：去掉 turbo 标记后找同名文件 */
  function pickStandardUnet(name, pool) {
    const pats = ['_turbo', '-turbo', 'turbo_', 'turbo-', 'turbo.', '.turbo', ' turbo', 'turbo '];
    const low = String(name || '').toLowerCase();
    const cands = [];
    for (const pat of pats) {
      const i = low.indexOf(pat);
      if (i >= 0) { cands.push(String(name).slice(0, i) + String(name).slice(i + pat.length)); break; }
    }
    const clean = s => s.replace(/([-_.])\1+/g, '$1');
    const hit = (pool || []).find(a => cands.some(c => clean(c) === clean(a)));
    if (hit) return hit;
    return (pool || []).find(a => !/turbo/i.test(a) && a.toLowerCase().endsWith('.safetensors') === low.endsWith('.safetensors')) || '';
  }
  /* 加速方案状态直接读 ComfyUI 的 LoRA 清单，不做任何本地文件处理 */
  function accelBadge() {
    const el = $('#accelHint');
    if (!el) return;
    if ($('#p_sampling').value !== 'viggle') { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const g = ((state.catalog || {}).accel || {}).viggle || {};
    const url = safeHref(g.download);
    if (g.ready) {
      el.textContent = '加速 LoRA 已就绪：' + shortName(g.lora || '') + '（强度固定 1.0）';
      el.className = 'accel-ok';
    } else {
      el.innerHTML = '未检测到加速 LoRA。把 <code>' + esc(g.filename || 'Viggle turbo LoRA')
        + '</code> 放进 ComfyUI 的 <code>models/loras/</code>，然后点「刷新模型清单」'
        + (url ? ` · <a href="${esc(url)}" target="_blank" rel="noreferrer noopener">镜像下载 →</a>` : '');
      el.className = 'accel-bad';
    }
  }
  /* 三种采样方案的元数据：优先用后端 catalog 返回的定义（workflows.SAMPLINGS），
     这样步数 / CFG / 底模要求这些「关系」只在后端写一份，前端只负责展示。 */
  const SAMPLING_FALLBACK = [
    { key: 'turbo', name: 'Turbo', badge: '8 步', steps: 8, steps_fixed: false, cfg: 1, cfg_locked: true,
      negative: false, unet: 'turbo', node: 'SamplerCustomAdvanced',
      desc: '官方 8 步蒸馏权重 + 官方 sigma 曲线，默认方案，最稳最快。',
      detail: '底模必须带 turbo。改步数会在 8 步曲线上重采样，偏离 8 步越多画质越难保证。' },
    { key: 'viggle', name: 'Viggle', badge: '5 步', steps: 5, steps_fixed: true, cfg: 1, cfg_locked: true,
      negative: false, unet: 'standard', node: 'SamplerCustomAdvanced',
      desc: '5 步蒸馏 LoRA 叠在标准底模上，比 Turbo 再快一档。',
      detail: '底模必须换回标准（非 turbo）权重；LoRA 强度固定 1.0，步数 / CFG / 负向全部锁死。' },
    { key: 'standard', name: 'Standard', badge: '25~40 步', steps: 25, steps_fixed: false, cfg: 1, cfg_locked: false,
      negative: true, unet: 'any', node: 'KSampler',
      desc: '普通 KSampler + 调度器，步数与 CFG 全开放。',
      detail: '给非蒸馏底模用。25~40 步、euler + simple 起步；CFG 调到 1 以上，负向提示词才真正参与计算。' },
  ];
  function samplingList() {
    const fromApi = (state.catalog || {}).samplings;
    return (Array.isArray(fromApi) && fromApi.length) ? fromApi : SAMPLING_FALLBACK;
  }
  function samplingMeta(key) {
    const list = samplingList();
    return list.find(s => s.key === key) || list[0];
  }
  function renderSamplingCards() {
    const box = $('#p_samplingCards'); if (!box) return;
    const cur = $('#p_sampling').value || 'turbo';
    box.innerHTML = samplingList().map(s => {
      const badge = s.badge || (s.steps + ' 步');
      const unetTag = s.unet === 'turbo' ? 'turbo 底模'
        : (s.unet === 'standard' ? '标准底模 + 加速 LoRA' : '任意底模');
      return `<button type="button" class="samp-card${s.key === cur ? ' active' : ''}"
        data-sampling="${esc(s.key)}" title="${esc(s.detail || s.desc || '')}">
        <b>${esc(s.name)}</b><em>${esc(badge)}</em>
        <span>${esc(unetTag)}</span>
      </button>`;
    }).join('');
  }
  function renderSamplingTable() {
    const el = $('#sampTable'); if (!el) return;
    const list = samplingList();
    const row = (label, fn) => '<tr><th>' + label + '</th>'
      + list.map(s => '<td>' + fn(s) + '</td>').join('') + '</tr>';
    const unetTxt = s => s.unet === 'turbo' ? 'turbo 蒸馏'
      : (s.unet === 'standard' ? '标准 + 加速 LoRA' : '任意');
    el.innerHTML = '<table class="samp-table"><thead><tr><th></th>'
      + list.map(s => '<th>' + esc(s.name) + '</th>').join('') + '</tr></thead><tbody>'
      + row('步数', s => s.steps_fixed ? '<b>' + s.steps + '</b> 固定' : s.steps + ' 起（可改）')
      + row('底模', s => esc(unetTxt(s)))
      + row('CFG', s => s.cfg_locked ? '锁 1.0' : '可调')
      + row('负向提示词', s => s.negative ? 'CFG&gt;1 才生效' : '不生效')
      + row('采样节点', s => '<code>' + esc(s.node || '') + '</code>')
      + '</tbody></table>';
  }
  /* 底模和方案对不上时给警告：这是「混搭出糊图」最常见的原因 */
  function renderUnetWarn() {
    const el = $('#unetWarn'); if (!el) return;
    const v = $('#p_sampling').value || 'turbo';
    const unet = $('#p_unet').value || state.params.unet || '';
    const turbo = /turbo/i.test(unet);
    let msg = '';
    if (v === 'turbo' && !turbo) {
      msg = '底模不是 turbo 蒸馏权重：8 步固定 sigma 跑在标准权重上会发糊。换回 turbo 底模，或把方案切到 Standard。';
    } else if (v === 'standard' && turbo) {
      msg = '底模是 turbo 蒸馏权重（只按 8 步训练）：走标准 KSampler 25~40 步意义不大。切回 Turbo，或换成标准底模。';
    } else if (v === 'viggle' && turbo) {
      msg = 'Viggle 必须叠在标准底模上，当前还是 turbo 权重，请换成同目录的标准版。';
    }
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
    el.className = msg ? 'unet-warn' : 'hidden';
  }
  function setSteps(n, quiet) {
    $('#p_steps').value = n;
    state.params.steps = n;
    persistParams();
    if (!quiet) heroNotice('步数已设为 ' + n);
  }

  function syncSampling(fromUser) {
    const v = $('#p_sampling').value || 'turbo';
    const meta = samplingMeta(v);
    const prev = state._prevSampling || '';
    const std = v === 'standard';
    const el2 = $('#standardOnly2');
    if (el2) el2.style.display = std ? 'grid' : 'none';

    // 卡片 / 对比表只在方案真的变了（或还没渲染过）时重建：
    // 步数、CFG 每敲一个字符都会调到这里，重建 DOM 没必要还可能打断输入
    const cardBox = $('#p_samplingCards');
    if (fromUser || !cardBox || !cardBox.children.length) {
      renderSamplingCards();
      renderSamplingTable();
    }
    const badge = $('#samplingBadge');
    if (badge) badge.textContent = meta.name + ' · ' + (meta.badge || (meta.steps + ' 步'));
    if (v === 'viggle') {
      if (fromUser) applyViggleParams();
      $('#p_steps').disabled = true; $('#p_cfg').disabled = true; $('#p_negative').disabled = true;
      $('#samplingHint').textContent = 'Viggle 5 步蒸馏：固定 5 步 + 官方 sigma，CFG 锁 1.0，负向提示词不参与。';
      if ($('#stepsHint')) $('#stepsHint').textContent = 'Viggle 固定 5';
      if ($('#cfgHint')) $('#cfgHint').textContent = 'Viggle 锁 1.0';
    } else {
      $('#p_steps').disabled = false; $('#p_cfg').disabled = false; $('#p_negative').disabled = false;
      // 从 Viggle 切回 Turbo：把当初被自动换掉的那个 turbo 底模还原回来，
      // 否则会出现「方案是 Turbo、底模却是标准版」的混搭（会糊图）
      if (fromUser && v === 'turbo') restoreTurboUnet();
      const steps = Number($('#p_steps').value) || meta.steps;
      // 换方案时把明显不搭的步数拉回该方案的常规区间，避免「Turbo 40 步 / Standard 8 步」这种混搭
      if (fromUser && prev && prev !== v) {
        if (prev === 'viggle' && steps === 5) setSteps(meta.steps, true);
        else if (v === 'standard' && steps <= 10) { setSteps(25, true); heroNotice('Standard 建议 25~40 步，已设为 25'); }
        else if (v === 'turbo' && steps > 20) { setSteps(8, true); heroNotice('Turbo 是 8 步蒸馏，已回到 8 步'); }
      }
      const now = Number($('#p_steps').value) || meta.steps;
      if ($('#stepsHint')) $('#stepsHint').textContent = std ? 'Standard 建议 25~40' : 'Turbo 建议 8';
      if ($('#cfgHint')) $('#cfgHint').textContent = std ? 'Standard 可调，>1 负向才生效' : 'Turbo 用 1.0';
      $('#samplingHint').textContent = std
        ? (Number($('#p_cfg').value) > 1
          ? '普通 KSampler：25~40 步 / euler + simple；当前 CFG ' + $('#p_cfg').value + '，负向提示词参与计算。'
          : '普通 KSampler：25~40 步 / euler + simple。CFG=1 时负向提示词不参与计算，想要负向生效请调到 1 以上。')
        : (now === 8
          ? 'Turbo 官方 8 步固定 sigma，最稳；改步数会自动在官方曲线上重采样。'
          : 'Turbo ' + now + ' 步：已在官方 8 步曲线重采样 sigma，偏离 8 步越多画质越难保证。');
    }
    state._prevSampling = v;
    accelBadge();
    renderUnetWarn();
    // 采样方案决定加速 LoRA 能不能用，方案一变就把助手面板的提示同步一下
    if (typeof aiLoraSyncBtn === 'function') aiLoraSyncBtn();
    const neg = $('#p_negative');
    if (neg && v !== 'viggle') {
      neg.placeholder = meta.negative
        ? 'CFG 调到 1 以上，这里的内容才会真正参与计算'
        : 'CFG=1 时负向提示词不参与计算（Turbo 蒸馏方案的标准用法）';
    }
  }
  function renderLoraList() {
    const q = ($('#p_loraSearch').value || '').toLowerCase();
    const list = (state.catalog.loras || []).filter(n => n.toLowerCase().includes(q));
    $('#p_loraList').innerHTML = list.length ? list.map(n => {
      const sel = state.loras.find(l => l.name === n);
      return `<div class="lora-row" title="${esc(n)}">
        <input type="checkbox" data-lora="${esc(n)}" ${sel ? 'checked' : ''}>
        <span>${esc(shortName(n))}</span>
        <input type="number" data-strength="${esc(n)}" step="0.1" min="-2" max="2" value="${sel ? sel.strength : 1.0}">
      </div>`;
    }).join('') : '<div class="lora-row"><span>没有匹配的 LoRA</span></div>';
  }
  function onLoraChange(e) {
    const cb = e.target.closest('[data-lora]');
    if (cb) {
      const name = cb.dataset.lora;
      state.loras = state.loras.filter(l => l.name !== name);
      if (cb.checked && state.loras.length < 5) state.loras.push({ name, strength: 1.0 });
      else if (cb.checked) { cb.checked = false; return heroNotice('最多选择 5 个 LoRA', 'warn'); }
    }
    const st = e.target.closest('[data-strength]');
    if (st) {
      const l = state.loras.find(x => x.name === st.dataset.strength);
      if (l) l.strength = Number(st.value) || 1;
    }
    persistParams();
  }
  function saveParams() {
    const p = state.params;
    p.sampling = $('#p_sampling').value; p.unet = $('#p_unet').value; p.clip = $('#p_clip').value;
    p.vae = $('#p_vae').value; p.resolution = Number($('#p_resPreset').value);
    p.max_images = Number($('#p_max_images').value);
    p.custom_size = (p.size_mode || 'auto') === 'fixed';
    p.steps = Number($('#p_steps').value); p.cfg = Number($('#p_cfg').value);
    p.sampler = $('#p_sampler').value; p.scheduler = $('#p_scheduler').value;
    p.denoise = Number($('#p_denoise').value); p.seed = Number($('#p_seed').value);
    // width / height / batch / ratio / res_level 由主面板分段按钮即时写入，这里不覆盖
    p.cache_device = $('#p_cache_device').value;
    p.cache_dtype = $('#p_cache_dtype').value; p.negative = $('#p_negative').value;
    persistParams(); updateComposer(); closeDrawer(); heroNotice('参数已保存');
  }
  /* DeepSeek Key 混淆存储：localStorage 里不再出现明文（防直接窥视，非加密） */
  function maskKey(sv) {
    try {
      if (!sv) return '';
      const k = 'cyui';
      let x = '';
      for (let i = 0; i < sv.length; i++) x += String.fromCharCode(sv.charCodeAt(i) ^ k.charCodeAt(i % k.length));
      return 'enc1:' + btoa(unescape(encodeURIComponent(x)));
    } catch (e) { return sv || ''; }
  }
  function unmaskKey(sv) {
    try {
      if (!sv) return '';
      if (!sv.startsWith('enc1:')) return sv;      // 兼容旧明文
      const bin = decodeURIComponent(escape(atob(sv.slice(5))));
      const k = 'cyui';
      let out = '';
      for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ k.charCodeAt(i % k.length));
      return out;
    } catch (e) { return sv || ''; }
  }
  function persistParams() {
    const obj = Object.assign({}, state.params, { __loras: state.loras });
    obj.deepseek_key = maskKey(obj.deepseek_key || '');
    localStorage.setItem('cyui_params', JSON.stringify(obj));
  }

  /* ---------------- 生成 ---------------- */
  function autoRoute(text, n, hasMask) {
    const t = (text || '').toLowerCase();
    if (hasMask) return 'inpaint';
    if (/局部重绘|只改|涂抹|遮罩|去掉水印|擦除/.test(t)) return 'inpaint';
    // 注意：LoRA 是输入框「⭐ LoRA」自选的通用增强，img2img / edit 同样可用
    // （LoraLoaderModelOnly 对所有模式生效），不再强制路由回文生图——
    // 否则带参考图 + LoRA 会被错误路由成 text2img，触发「不支持参考图」提示
    if (n >= 2) return 'edit';
    if (n === 1) {
      // 风格化 / 整图重绘类描述 → 图生图（保构图低重绘幅）；其余单图指令 → 编辑
      if (/风格|改成|变成|转为|重绘|色调|调色|滤镜|油画|水彩|素描|卡通|动漫|黏土|水墨|插画|胶片|老照片|赛博朋克|像素风|写实|质感/.test(t)) return 'img2img';
      return 'edit';
    }
    return 'text2img';
  }
  function buildPayload() {
    return {
      mode: state.mode, prompt: state.draft.trim(),
      images: state.images.map(i => i.name), mask: state.mask,
      loras: state.loras.map(l => ({ name: l.name, strength: Number(l.strength) })),
      params: Object.assign({}, state.params), seed: state.params.seed,
      session_id: state.sessionId, title: state.draft.trim().slice(0, 24),
    };
  }
  let generating = false;
  async function generate(override) {
    if (generating) return heroNotice('上一个任务正在提交，请稍候');
    let payload = override ? JSON.parse(JSON.stringify(override)) : buildPayload();
    if (!override && state.agent) {
      payload.mode = autoRoute(payload.prompt, payload.images.length, !!payload.mask);
      payload.params = Object.assign({}, payload.params, { denoise: (state.skillMap[payload.mode] || {}).denoise || 1 });
    }
    // 兜底：文生图不接受参考图（避免后端「最多支持 0 张」报错），带图时自动升级
    if (!override && payload.mode === 'text2img' && payload.images.length) {
      setMode(payload.images.length === 1 ? 'img2img' : 'edit');
      payload.mode = state.mode;
      payload.params = Object.assign({}, payload.params, { denoise: skill().denoise });
      heroNotice('文生图不支持参考图，已自动切换到「' + skill().name + '」');
    }
    if (!payload.prompt) {
      payload.prompt = (state.skillMap[payload.mode] || {}).examples?.[0] || '一张细节丰富、光影自然的图片';
    }
    generating = true;
    $$('.send-btn').forEach(b => b.disabled = true);
    try {
      // 提示词润色：开启时先润色再提交；重新生成（override）沿用已有文本不再叠加
      // 图生图 / 图片编辑 / 局部重绘会把参考图一起传给模型（多模态润色，结果与参考图对齐）
      if (state.params.polish && payload.prompt && !override) {
        setCvProgress('提示词润色中…', 5);
        const stopPlTimer = cvProgressTimer('提示词润色中…', '本地模型生成约 1~3 分钟');
        try {
          const pr = await post('/api/polish', {
            prompt: payload.prompt,
            images: payload.images,
            mode: payload.mode,
            provider: state.params.polish_provider || 'local',
            api_key: state.params.deepseek_key || '',
            model: state.params.deepseek_model || 'deepseek-chat',
          });
          stopPlTimer();
          payload.prompt = pr.polished;
          heroNotice('提示词已润色（' + polishSourceName() + (pr.multimodal ? ' · 已参考图片' : '') + '）');
        } catch (e) {
          stopPlTimer();
          heroNotice('润色失败，使用原文：' + e.message, 'error');
        }
        finally { stopPlTimer(); }
      }
      setCvProgress('正在提交任务…', 3);
      const r = await api('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.sessionId = r.session_id;
      persistSessionId(r.session_id);
      state.jobPayloads[r.prompt_id] = payload;
      state.messages.push(r.user_message, r.assistant_message);
      state.pending.add(r.prompt_id);
      // 提示词与参考图提交后保留：方便同一组素材微调后再次生成，清空由用户自己操作
      updateComposer(); await refreshSessions();
      // 画布内提交留在画布；对话/首页提交留在对话模式看进度（结果与画布按会话联通）
      if (state.view === 'canvas') renderCanvas();
      else { switchView('chat'); renderChat(true); }
      setCvProgress('已提交，等待出图…');
      pollJob(r.prompt_id);
    } catch (e) { clearCvProgress(); heroNotice('提交失败：' + e.message, 'error'); }
    finally { generating = false; $$('.send-btn').forEach(b => b.disabled = false); }
  }

  async function pollJobs() {
    if (!state.pending.size) {
      // 只在「正在等任务结果」时才收进度条。反推 / 上传 / 放大准备这类瞬时进度
      // 不属于 ComfyUI 任务（不进 state.pending），不能被这里误清。
      const gp = $('#gpText');
      const t = gp ? gp.textContent : '';
      if (/等待出图|模型加载中|生成中|放大中|放大模型加载中/.test(t)) clearCvProgress();
      return;
    }
    Array.from(state.pending).forEach(pid => pollJob(pid));
  }
  /* 收尾时统一清理：pending 空了就把右上角进度条收起来，
     否则中断 / 清空队列后会残留一个「模型加载中…」的幽灵弹窗。 */
  function settleProgressIfIdle() {
    if (!state.pending.size) clearCvProgress();
  }
  async function pollJob(pid) {
    try {
      const r = await api('/api/job/' + pid);
      const j = r.job;
      const msg = state.messages.find(m => m.job_id === pid);
      if (msg) Object.assign(msg, r.message || {});
      if (j.status === 'done' || j.status === 'error' || j.finalized) {
        state.pending.delete(pid); renderChat(); refreshGallery(); refreshSessions();
        if (j.status === 'done' && (j.results || []).length) onGenerated(j.results);
        else clearCvProgress();
        settleProgressIfIdle();
      } else {
        updateJobCard(pid, j);
        const up = msg && msg.mode === 'upscale';
        setCvProgress(j.total
          ? (up ? '放大中 ' : '生成中 ') + (j.step || 0) + '/' + j.total + ' 步 · ' + Math.round(j.progress || 0) + '%'
          : (up ? '放大模型加载中…' : '模型加载中…'),
          Math.round(j.progress || 0));
      }
    } catch (e) {
      state.pending.delete(pid);
      const msg = state.messages.find(m => m.job_id === pid);
      if (msg) { msg.status = 'error'; msg.content = '任务状态丢失：' + e.message; }
      renderChat();
      settleProgressIfIdle();
    }
  }
  function updateJobCard(pid, j) {
    const card = document.querySelector('[data-job="' + pid + '"]'); if (!card) return;
    const st = $('.status', card); if (st) { st.textContent = j.status === 'running' ? '生成中' : j.status === 'queued' ? '排队中' : j.status === 'finishing' ? '收尾中' : j.status; st.className = 'status ' + j.status; }
    // 百分比统一显示在右上角全局进度条，卡片内只保留状态与骨架
    const note = $('.pending-note', card);
    if (note) note.innerHTML = j.total
      ? `采样进行中 <span class="blink">···</span>`
      : '模型加载中 <span class="blink">···</span> <small>（首次加载 6.8G 权重可能需要 1~2 分钟）</small>';
  }

  /* ---------------- 对话渲染 ---------------- */
  /* 对话页要显示的消息：助手提交的生成任务在出图前不占位。
     它本身没有正文与图片，显示出来就是一张空的「生成中」卡片；
     进度与结果在助手面板和右上角进度条里都有，出图后这张卡片自然带上图片再出现。 */
  function chatVisibleMessages() {
    return (state.messages || []).filter(m => {
      if (m.role !== 'assistant') return true;
      const busy = m.status === 'pending' || m.status === 'running';
      const empty = !(m.content || '').trim() && !(m.images || []).length;
      if (busy && empty && m.source === 'ai') return false;
      // 纯文本 AI 回复被写成无 status 时也不该留下空骨架（历史数据兜底）
      if (busy && empty && !m.job_id) return false;
      return true;
    });
  }

  function renderChat(forceBottom) {
    const sc = $('#chatScroll');
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    const list = chatVisibleMessages();
    let ctxPrompt = '';
    const html = list.length ? list.map(m => {
      if (m.role === 'user') ctxPrompt = (m.prompt || m.content || '').trim();
      return msgHTML(m, ctxPrompt);
    }).join('') : '<div class="empty-chat">还没有消息，在下方输入第一句创作指令吧 ✦</div>';
    $('#chatInner').innerHTML = html;
    if (forceBottom || nearBottom) window.setTimeout(() => { sc.scrollTop = sc.scrollHeight; }, 20);
  }
  /* 找到某条结果对应的完整提示词：优先消息自带，其次往前找最近的用户输入 */
  function promptForJob(pid) {
    const i = state.messages.findIndex(m => m.job_id === pid);
    if (i >= 0) {
      const m = state.messages[i];
      if (m.prompt || m.final_prompt) return m.prompt || m.final_prompt;
      for (let k = i - 1; k >= 0; k--) {
        if (state.messages[k].role === 'user') {
          return state.messages[k].prompt || state.messages[k].content || '';
        }
      }
    }
    return '';
  }
  function msgHTML(m, ctxPrompt) {
    if (m.role === 'user') {
      const imgs = (m.images || []).map(i => `<img src="${esc(i.url)}" alt="参考图">`).join('');
      const extra = m.mask ? `<img src="${esc(m.mask)}" alt="遮罩" style="outline:2px solid #4fd1a5">` : '';
      return `<div class="msg user">
        <div class="msg-avatar">薇</div>
        <div class="msg-body"><div class="bubble">${esc(m.content)}</div>
        ${imgs || extra ? `<div class="msg-images">${imgs}${extra}</div>` : ''}
        <div class="msg-label">${esc(m.skill || '')} · ${fmtTime(m.ts)}</div></div>
      </div>`;
    }
    // 没有 job_id 的是纯文字回复（AI 总结 / 提示词结果）：它不可能是待执行任务，
    // 以前会落到 pending 分支，渲染成一张永远「模型加载中」的空卡片
    const st = m.status || (m.job_id ? 'pending' : 'done');
    let body = '';
    if (st === 'pending' || st === 'running') {
      // 百分比统一显示在右上角全局进度条，卡片内只保留骨架与状态
      body = `<div class="skeleton"></div>
              <div class="pending-note" style="margin-top:10px">模型加载中 <span class="blink">···</span></div>`;
    } else if (st === 'error') {
      body = `<div class="err-box">${esc(m.content || '生成失败')}</div>`;
    } else {
      // 三模式通路：AI 助手的文字回复（有 content 无图片）也要在对话页可见
      const text = (m.content || '').trim();
      const imgs = (m.images || []).map((i, idx) => `<img src="${esc(i.url)}" data-zoom="1" data-pid="${esc(m.job_id || '')}" data-idx="${idx}" data-caption="${esc(m.skill || '')} · ${i.width}×${i.height}" alt="生成结果">`).join('');
      const p = m.meta || {};
      const fullPrompt = (m.prompt || m.final_prompt || ctxPrompt || '').trim();
      body = `${text ? `<div class="msg-content">${esc(text)}</div>` : ''}
        ${imgs ? `<div class="result-grid">${imgs}</div>` : ''}
        ${imgs ? `<div class="param-tags">
          <span class="param-tag">${esc(m.skill || '')}</span>
          <span class="param-tag">${esc(p.sampler || 'Turbo 8 步')}</span>
          <span class="param-tag">${esc(p.latent || '')}</span>
          <span class="param-tag">参考图 ${p.reference_images || 0} 张</span>
          ${(p.loras || []).length ? `<span class="param-tag">LoRA ${p.loras.length}</span>` : ''}
          ${m.elapsed ? `<span class="param-tag">${m.elapsed}s</span>` : ''}
        </div>` : ''}
        ${imgs && fullPrompt ? `<div class="result-prompt">
          <div class="rp-head"><span>完整提示词</span>
            <button class="mini-link" data-mact="copy" data-job="${esc(m.job_id || '')}">复制</button>
          </div>
          <p>${esc(fullPrompt)}</p>
        </div>` : ''}`;
    }
    // 文字回复没有可操作的作业，不挂「重新生成 / 中断」这类按钮
    const actions = !m.job_id ? '' : (st === 'done'
      ? `<button class="act-btn" data-mact="regen" data-job="${esc(m.job_id)}">↻ 重新生成</button>
         <button class="act-btn" data-mact="editagain" data-job="${esc(m.job_id)}">✎ 以此继续编辑</button>
         <button class="act-btn" data-mact="canvas" data-job="${esc(m.job_id)}">⬚ 在画布查看</button>
         <button class="act-btn" data-mact="download" data-job="${esc(m.job_id)}">↓ 下载</button>`
      : (st === 'error' ? `<button class="act-btn" data-mact="regen" data-job="${esc(m.job_id)}">↻ 重试</button>` : `<button class="act-btn" data-mact="interrupt">■ 中断当前任务</button>`));
    return `<div class="msg assistant" data-job="${esc(m.job_id || '')}">
      <div class="msg-avatar">✦</div>
      <div class="msg-body" style="width:100%">
        <div class="assistant-card" data-job="${esc(m.job_id || '')}">
          <div class="assistant-head"><b>CYUI</b><span>${esc(m.skill || (m.job_id ? '创作' : 'AI 助手'))}</span>${m.job_id ? `<span class="status ${st}">${st === 'done' ? '已完成' : st === 'error' ? '失败' : '生成中'}</span>` : ''}</div>
          ${body}
          ${actions ? `<div class="msg-actions">${actions}</div>` : ''}
        </div>
      </div>
    </div>`;
  }

  async function onChatClick(e) {
    const b = e.target.closest('[data-mact]'); if (!b) return;
    const pid = b.dataset.job, act = b.dataset.mact;
    if (act === 'interrupt') {
      await api('/api/interrupt', { method: 'POST' });
      heroNotice('已发送中断请求');
      window.setTimeout(pollJobs, 300);   // 让被中断的任务尽快收尾，别留下幽灵进度条
      return;
    }
    if (act === 'copy') {
      const p = promptForJob(pid);
      if (!p) return heroNotice('没有可复制的提示词', 'error');
      navigator.clipboard.writeText(p).then(() => heroNotice('提示词已复制')).catch(() => heroNotice('复制失败', 'error'));
      return;
    }
    const msg = state.messages.find(m => m.job_id === pid);
    if (act === 'regen') {
      const base = state.jobPayloads[pid] || (msg && msg.payload) || buildPayload();
      const p = JSON.parse(JSON.stringify(base));
      p.seed = -1; p.params = Object.assign({}, p.params, { seed: -1 }); p.session_id = state.sessionId;
      return generate(p);
    }
    if (act === 'editagain') {
      const item = (msg && msg.images || [])[0]; if (!item) return heroNotice('没有可用的结果图', 'error');
      try {
        const blob = await (await fetch(item.url)).blob();
        const fd = new FormData(); fd.append('image', new File([blob], 'cyui_result.png', { type: 'image/png' }));
        const r = await api('/api/upload', { method: 'POST', body: fd });
        if (r.images[0]) { setMode('edit'); state.images = [r.images[0]]; state.mask = null; renderRefs(); updateComposer(); heroNotice('已把结果图放进参考图，继续描述修改内容'); $('.composer-input').focus(); }
      } catch (err) { heroNotice('复用失败：' + err.message, 'error'); }
      return;
    }
    if (act === 'canvas') { switchView('canvas'); return heroNotice('已进入自由画布'); }
    if (act === 'download') {
      (msg && msg.images || []).forEach((im, i) => {
        const a = document.createElement('a'); a.href = im.url; a.download = 'cyui_' + pid.slice(0, 8) + '_' + i + '.png'; a.click();
      });
    }
  }

  /* ---------------- 会话 / 图库 ---------------- */
  async function refreshSessions() { const r = await api('/api/sessions'); state.sessions = r.sessions; renderSessions(); }
  function renderSessions() {
    const sel = state.sessionSelection = state.sessionSelection || new Set();
    $('#sessionNav').innerHTML = state.sessions.length ? state.sessions.map(s =>
      `<div class="sess ${s.id === state.sessionId ? 'active' : ''} ${sel.has(s.id) ? 'selected' : ''}" data-sid="${s.id}" title="${esc(s.title)} · 双击重命名">
        <input type="checkbox" class="sess-check" data-check-sid="${esc(s.id)}" ${sel.has(s.id) ? 'checked' : ''} title="选择">
        <span>${esc(s.title)}</span><em data-del="${esc(s.id)}" title="删除">×</em></div>`).join('')
      : '<div class="sess" style="opacity:.5">暂无对话</div>';
    renderSessBar();
  }
  function renderSessBar() {
    const sel = state.sessionSelection || new Set();
    const bar = $('#sessBar'); if (!bar) return;
    bar.classList.toggle('hidden', !sel.size);
    $('#sessSelInfo').textContent = '已选 ' + sel.size + ' 个';
  }

  /* 删除会话 / 作品后，统一刷新对话列表、图库与画布；二者通过 session_id 相通 */
  async function applyLinkedDeletion(r) {
    const gids = new Set(r.gallery_removed || []);
    const sids = new Set(r.sessions_removed || []);
    state.sessionSelection = state.sessionSelection || new Set();
    sids.forEach(id => state.sessionSelection.delete(id));
    gids.forEach(id => {
      if (state.gallerySelection) state.gallerySelection.delete(id);
      state.canvasSelection.delete(id);
    });
    await refreshSessions();
    await refreshGallery();
    // 删掉的图已从后端消息里摘除，对话卡片要跟着重拉（消息与会话本身保留）
    await refreshSessionMessages();
    if (state.view === 'canvas') renderCanvas();
    const gone = state.sessionId && (sids.has(state.sessionId) || !state.sessions.some(s => s.id === state.sessionId));
    // 在画布上删作品时不要把用户从画布踢走
    if (gone) newChat(state.view === 'canvas');
    else if (state.view === 'chat') renderChat(true);
    renderSessions();
    aiOnSessionsChanged();             // 人工侧删除 → AI 历史对话同步删除
  }

  async function deleteSessions(ids, label) {
    ids = Array.from(new Set(ids || []));
    if (!ids.length) return heroNotice('请先勾选要删除的对话', 'error');
    const msg = label || ('删除选中的 ' + ids.length + ' 个对话？将同步移除这些对话在自由画布 / 作品图库中的图片。');
    if (!(await confirmDialog(msg))) return;
    try {
      const r = await post('/api/sessions/batch-delete', { ids });
      await applyLinkedDeletion(r);
      heroNotice('已删除 ' + (r.deleted || ids.length) + ' 个对话（相关图片文件已移入回收站）');
      notifyDeleteFailed(r);
    } catch (e) { heroNotice('删除失败：' + e.message, 'error'); }
  }

  /* 双击会话名 → 行内输入框重命名（回车保存 / Esc 取消 / 失焦保存） */
  function startSessionRename(row) {
    const sid = row.dataset.sid;
    const s = state.sessions.find(x => x.id === sid); if (!s) return;
    if ($('.sess-rename', row)) return;
    const label = $('span', row); if (!label) return;
    const input = document.createElement('input');
    input.className = 'sess-rename';
    input.value = s.title || '新对话';
    input.dataset.sid = sid;
    label.replaceWith(input);
    input.focus(); input.select();
    const commit = async () => {
      if (input.dataset.done) return;
      input.dataset.done = '1';
      const title = (input.value || '').trim().slice(0, 40);
      if (!title) { renderSessions(); return; }
      try {
        await post('/api/sessions/' + encodeURIComponent(sid) + '/rename', { title });
        s.title = title;
      } catch (e) { heroNotice('重命名失败：' + e.message, 'error'); }
      renderSessions();
      aiOnSessionsChanged();           // 人工侧重命名 → AI 历史对话标题同步
      if (s.id === state.sessionId) {
        renderCanvas();
        if (state.view === 'chat') switchView('chat');
      }
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { input.dataset.done = '1'; renderSessions(); }
    });
    input.addEventListener('blur', commit);
  }
  /* 只切换高亮，不整表重绘：否则双击重命名时第一次单击的异步刷新会把输入框冲掉 */
  function markActiveSession(sid) {
    $$('#sessionNav .sess[data-sid]').forEach(el =>
      el.classList.toggle('active', el.dataset.sid === sid));
  }
  async function openSession(sid) {
    const r = await api('/api/sessions/' + sid);
    if (!r.session) return heroNotice('会话不存在', 'error');
    state.sessionId = sid; state.messages = r.session.messages || [];
    persistSessionId(sid);
    state.messages.forEach(m => { if (m.role === 'assistant' && m.status === 'pending') state.pending.add(m.job_id); });
    markActiveSession(sid); renderChat(true); switchView('chat');
    aiOnSessionsChanged();             // 人工侧切换会话 → AI 助手切到同一条
  }
  /* 三种模式结果统一同步：对话消息 / 图库与画布卡片 / 助手面板，
     单图、批量、主流程生成、后端兜底回收都走这里，任意视图都不用刷新页面 */
  async function syncGeneratedViews(opts) {
    const o = opts || {};
    await refreshSessions();
    // 单图与批量结果都会由后端写进 session.messages，必须重新拉，否则对话页要刷新才出现
    if (state.sessionId) {
      try {
        const d = await api('/api/sessions/' + state.sessionId);
        state.messages = (d.session || {}).messages || [];
        state.messages.forEach(m => {
          if (m.role === 'assistant' && m.status === 'pending' && m.job_id) state.pending.add(m.job_id);
        });
      } catch (e) { /* 静默 */ }
    }
    await refreshGallery();      // 内部会分配坐标并在画布视图重绘卡片
    renderChat();
    if (state.view === 'canvas') renderCanvas();
    aiOnSessionsChanged();
    if (!o.silent) heroNotice('结果已同步到对话、自由画布与助手');
  }

  async function refreshGallery() {
    try {
      const r = await api('/api/gallery?limit=2000'); state.gallery = r.gallery; renderGallery();
      // 无论当前在哪个视图，新图一进入图库就分配空位并落盘：生成完成即刻可见
      if (!state.canvasDragging) await assignMissingSlots(true);
      if (state.view === 'canvas' && !state.canvasDragging) renderCanvas();
    } catch (e) { /* 静默 */ }
  }
  function galleryFiltered() {
    const q = (($('#gallerySearch') || {}).value || '').trim().toLowerCase();
    const f = (($('#galleryFilter') || {}).value || '');
    if (!q && !f) return state.gallery;
    return (state.gallery || []).filter(g => {
      if (f) {
        if (f === '\u5bfc\u5165') { if (g.skill !== '\u5bfc\u5165') return false; }
        else if ((g.mode || '') !== f) return false;
      }
      if (q) {
        const hay = ((g.prompt || '') + '\n' + (g.name || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function renderGallery() {
    const sel = state.gallerySelection = state.gallerySelection || new Set();
    const items = galleryFiltered();
    $('#galleryGrid').innerHTML = items.length ? items.map(g => {
      const name = g.name || (g.prompt || '').split('\n')[0] || '未命名作品';
      return `<div class="gallery-item ${sel.has(g.id) ? 'selected' : ''}" data-gid="${esc(g.id)}">
        <input type="checkbox" class="g-check" data-check="${esc(g.id)}" ${sel.has(g.id) ? 'checked' : ''} title="选择">
        <img src="${esc(g.url)}" data-gid="${esc(g.id)}" alt="作品">
        <button class="g-use" data-use="${esc(g.id)}">发送到图片编辑</button>
        <div class="g-meta"><span class="g-name" data-name="${esc(g.id)}" title="点击改名">${esc(name)}</span>${esc(g.skill || '')} · ${g.width}×${g.height}</div>
      </div>`;
    }).join('') : '<div class="gallery-empty">还没有作品，去创作第一张吧 ✦</div>';
    updateGalleryBar();
  }
  function updateGalleryBar() {
    const sel = state.gallerySelection || new Set();
    $('#gallerySelInfo').textContent = sel.size ? '已选 ' + sel.size + ' 张' : '未选择';
  }
  async function sendGalleryToEdit(ids) {
    if (!ids || !ids.length) return heroNotice('请先勾选图片', 'error');
    const pick = ids.slice(0, 16);
    try {
      const uploaded = [];
      for (const id of pick) {
        const g = state.gallery.find(x => x.id === id); if (!g) continue;
        const blob = await (await fetch(g.url)).blob();
        const fd = new FormData();
        fd.append('image', new File([blob], 'cyui_gallery.png', { type: 'image/png' }));
        const r = await api('/api/upload', { method: 'POST', body: fd });
        if (r.images[0]) uploaded.push(r.images[0]);
        if (uploaded.length >= 16) break;
      }
      if (!uploaded.length) return heroNotice('没有可用的图片', 'error');
      if (state.skillMap.edit) setMode('edit');
      state.images = uploaded.slice(0, Math.max(1, cap() || 16));
      state.mask = null;
      renderRefs(); updateComposer();
      switchView(sendTargetView());
      heroNotice('已把 ' + uploaded.length + ' 张放进参考图，继续描述修改内容');
    } catch (err) { heroNotice('发送失败：' + err.message, 'error'); }
  }
  /* 删除后的统一提示：文件被占用未删成功时弹窗告知（其余已进 Windows 回收站） */
  function notifyDeleteFailed(r) {
    const f = (r && r.failed_files) || [];
    if (!f.length) return;
    const names = f.slice(0, 5).map(x => '· ' + (x.name || x)).join('\n') + (f.length > 5 ? '\n· …' : '');
    confirmDialog('有 ' + f.length + ' 个文件正被其他程序占用，本次未能删除：\n' + names +
      '\n\n它们仍留在原目录，关闭占用程序（如看图软件 / 资源管理器预览）后重试即可。',
      '部分文件未删除');
  }
  async function deleteGallerySelection() {
    const ids = Array.from(state.gallerySelection || []);
    if (!ids.length) return heroNotice('请先勾选要删除的图片', 'error');
    if (!(await confirmDialog('删除所选的 ' + ids.length + ' 张图片？\n图片文件将移入 Windows 回收站（可随时恢复），不影响对话记录。'))) return;
    try {
      const r = await post('/api/gallery/batch-delete', { ids });
      state.gallerySelection.clear();
      state.lastGalleryCount = Math.max(0, (state.lastGalleryCount || ids.length) - ids.length);
      await applyLinkedDeletion(r);
      heroNotice('已删除 ' + (r.deleted || ids.length) + ' 张（文件已移入回收站，对话记录保留）');
      notifyDeleteFailed(r);
    } catch (e) { heroNotice('删除失败：' + e.message, 'error'); }
  }
  function startGalleryRename(nameEl) {
    const gid = nameEl.dataset.name;
    const g = state.gallery.find(x => x.id === gid); if (!g) return;
    const input = document.createElement('input');
    input.className = 'g-rename';
    input.value = g.name || (g.prompt || '').split('\n')[0] || '未命名作品';
    input.dataset.gid = gid;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitGalleryRename(input); }
      else if (ev.key === 'Escape') { input.dataset.done = '1'; renderGallery(); }
    });
    input.addEventListener('blur', () => commitGalleryRename(input));
  }
  async function commitGalleryRename(input) {
    if (input.dataset.done) return;
    input.dataset.done = '1';
    const name = (input.value || '').trim().slice(0, 80) || '未命名作品';
    const g = state.gallery.find(x => x.id === input.dataset.gid);
    if (g) {
      g.name = name;
      await post('/api/gallery/' + encodeURIComponent(g.id), { name }).catch(() => {});
    }
    renderGallery();
    if (state.view === 'canvas') renderCanvas();
  }
  async function onGalleryClick(e) {
    if (e.target.closest('[data-check]')) return;   // 勾选走 change 事件
    const use = e.target.closest('[data-use]');
    if (use) { await sendGalleryToEdit([use.dataset.use]); return; }
    const nameEl = e.target.closest('[data-name]');
    if (nameEl) { startGalleryRename(nameEl); return; }
    const img = e.target.closest('img[data-gid]');
    if (img) openImgMenu(e.clientX, e.clientY, galleryMenuInfo(img.dataset.gid));
  }
  /* 大图弹窗：左边完整图片，右边作品信息（正/负面提示词、参数），右侧可收起 */
  function openLightbox(info) {
    info = info || {};
    // 来源（如对话消息）可能只有 url/name：按 url 从图库补全完整生成信息
    if (!info.prompt && info.url) {
      const g = state.gallery.find(x => x.url === info.url);
      if (g) info = Object.assign({}, g, info, { name: info.name || g.name });
    }
    $('#lightboxImg').src = info.url || '';
    const p = info.params || {};
    const name = info.name || (info.prompt || '').split('\n')[0] || '作品';
    const tags = [];
    if (info.skill) tags.push(info.skill);
    if (info.width) tags.push(info.width + '×' + info.height);
    if (p.sampling) tags.push(samplingLabel(p.sampling));
    if (p.sampler) tags.push(p.sampler + ' / ' + (p.scheduler || ''));
    if (p.seed !== undefined && Number(p.seed) >= 0) tags.push('seed ' + p.seed);
    if (p.batch) tags.push('×' + p.batch);
    // 底模 / CLIP / VAE 三件套：出图时的真实权重，方便复现同一张图
    if (p.unet) tags.push('底模 ' + shortName(p.unet));
    if (p.clip) tags.push('CLIP ' + shortName(p.clip));
    if (p.vae) tags.push('VAE ' + shortName(p.vae));
    if (info.ts) tags.push(fmtTime(info.ts));
    $('#lbBody').innerHTML = `
      <h4>名称</h4><div class="lb-prompt">${esc(name)}</div>
      <h4>参数</h4><div class="lb-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('') || '<span>—</span>'}</div>
      <h4>正面提示词</h4><div class="lb-prompt">${esc(info.prompt || '（无记录）')}</div>
      <h4>负面提示词</h4><div class="lb-prompt">${esc(p.negative || '（未设置）')}</div>`;
    $('#lightbox').classList.remove('hidden');
    setLbCollapsed(false);
  }
  function setLbCollapsed(c) {
    $('#lbShell').classList.toggle('collapsed', c);
    $('#lbExpand').classList.toggle('hidden', !c);
    $('#lbToggle').textContent = c ? '‹ 展开' : '收起 ›';
  }

  /* ---- 生成图片快捷菜单：点击图片浮出；除查看大图外均为占位，待接入工作流 ---- */
  let imgMenuInfo = null;
  function openImgMenu(x, y, info) {
    imgMenuInfo = info;
    const menu = $('#imgMenu');
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 170, mh = menu.offsetHeight || 300;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, x + 6));
    let top = y + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, y - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    // 打开它的这一次点击还在冒泡，标记一拍后再允许「点外部关闭」生效
    menu.dataset.justOpened = '1';
    window.setTimeout(() => { menu.dataset.justOpened = ''; }, 0);
  }
  function hideImgMenu() {
    $('#imgMenu').classList.add('hidden');
    const sub = $('#imgSub');
    if (sub) sub.classList.add('hidden');
    imgMenuInfo = null;
  }

  /* 高清放大二级菜单：默认 / 1.5K / 2K / 4K */
  function openImgSub() {
    const menu = $('#imgMenu'), sub = $('#imgSub');
    const info = imgMenuInfo || {};
    const w = Number(info.width) || 0, h = Number(info.height) || 0;
    const defScale = Number((state.upscale || {}).scale) || 2;
    const long = Math.max(w, h);
    const px = (target) => {
      if (!w || !h) return '';
      const s = target / long;
      return Math.round(w * s) + '×' + Math.round(h * s);
    };
    $('#upDefLabel').textContent = '×' + defScale + (w && h ? ' · ' + Math.round(w * defScale) + '×' + Math.round(h * defScale) : '');
    $('#up15Label').textContent = px(1536);
    $('#up2Label').textContent = px(2048);
    $('#up4Label').textContent = px(4096);
    sub.classList.remove('hidden');
    const mr = menu.getBoundingClientRect();
    const sw = sub.offsetWidth || 200, sh = sub.offsetHeight || 190;
    let left = mr.right + 8, top = mr.top;
    if (left + sw > window.innerWidth - 8) left = Math.max(8, mr.left - sw - 8);
    if (top + sh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - sh - 8);
    sub.style.left = left + 'px';
    sub.style.top = top + 'px';
  }

  /* 高清放大：把图片传进 ComfyUI input，再提交 SeedVR2 工作流 */
  async function upscaleFromInfo(info, target) {
    if (!info || !info.url) return heroNotice('没有可放大的图片', 'error');
    if (!state.online) return heroNotice('ComfyUI 未连接，无法放大', 'error');
    if (!(state.catalog.seedvr2 || {}).ready) {
      return heroNotice('当前 ComfyUI 缺少 SeedVR2 / TTP 节点，请先安装（见帮助页）', 'error');
    }
    setCvProgress('正在准备放大…', 4);
    try {
      const blob = await (await fetch(info.url)).blob();
      const fd = new FormData();
      fd.append('image', new File([blob], 'cyui_up.png', { type: 'image/png' }));
      const up = await api('/api/upload', { method: 'POST', body: fd });
      const im = (up.images || [])[0];
      if (!im) throw new Error('图片上传失败');
      setCvProgress('已提交高清放大，等待处理…', 6);
      const r = await post('/api/upscale', {
        image: im.name,
        target: target || 'default',
        prompt: info.prompt || '',
        name: info.name || '',
        session_id: state.sessionId || info.session_id || null,
      });
      state.sessionId = r.session_id;
      persistSessionId(r.session_id);
      state.pending.add(r.prompt_id);
      const ses = await api('/api/sessions/' + r.session_id);
      state.messages = (ses.session || {}).messages || state.messages;
      await refreshSessions();
      if (state.view === 'canvas') { renderCanvas(); }
      else { switchView('chat'); renderChat(true); }
      heroNotice('高清放大已提交（' + (r.label || '') + '）');
      pollJob(r.prompt_id);
    } catch (e) {
      clearCvProgress();
      heroNotice('放大失败：' + e.message, 'error');
    }
  }

  /* 图片发送目标：窗口开的是对话模式就回对话模式，是自由画布就留在自由画布 */
  function sendTargetView() {
    if (state.view === 'canvas') return 'canvas';
    if (state.view === 'chat') return 'chat';
    return 'home';
  }

  /* 把图片送入指定技能的输入台（编辑 / 图生图） */
  async function sendToMode(info, mode) {
    if (!info || !info.url) return heroNotice('没有可发送的图片', 'error');
    const label = mode === 'edit' ? '图片编辑' : '图生图';
    setCvProgress('正在把图片送入' + label + '…', 4);
    try {
      const blob = await (await fetch(info.url)).blob();
      const fd = new FormData();
      fd.append('image', new File([blob], 'cyui_send.png', { type: 'image/png' }));
      const up = await api('/api/upload', { method: 'POST', body: fd });
      const im = (up.images || [])[0];
      if (!im) throw new Error('上传失败');
      setMode(mode);
      state.images = [im].slice(0, Math.max(1, cap()));
      state.mask = null;
      if (info.prompt && !(state.draft || '').trim()) state.draft = info.prompt;
      updateComposer();
      switchView(sendTargetView());
      clearCvProgress();
      heroNotice('已发送到' + label + '，可修改描述后生成');
    } catch (e) {
      clearCvProgress();
      heroNotice('发送失败：' + e.message, 'error');
    }
  }

  /* 把图片的提示词填进文生图 */
  function sendPromptToT2I(info) {
    const p = ((info && (info.prompt || info.name)) || '').trim();
    if (!p) return heroNotice('这张图没有记录提示词', 'error');
    setMode('text2img');
    state.images = []; state.mask = null; state.draft = p;
    updateComposer();
    switchView(sendTargetView());
    heroNotice('提示词已填入文生图');
  }
  function galleryMenuInfo(gid) {
    const g = state.gallery.find(x => x.id === gid);
    if (!g) return { url: '', name: '作品' };
    return Object.assign({}, g, { name: g.name || (g.prompt || '').split('\n')[0] || '作品' });
  }

  /* ---------------- ComfyUI 地址（设置页） ---------------- */
  function fillComfyBase() {
    const el = $('#p_comfy_base');
    if (el && !el.matches(':focus')) el.value = state.comfyBase || 'http://127.0.0.1:8188';
    const dir = $('#p_comfy_dir');
    if (dir && !dir.matches(':focus')) dir.value = state.comfyDir || '';
  }
  function applyCatalog(cat) {
    if (!cat) return;
    state.catalog = cat;
    state.gguf = cat.gguf || {};
    fillParams();
    renderHelp();
    if ($('#p_up_dit')) fillUpscaleSettings();
  }
  async function saveComfyBase() {
    const val = ($('#p_comfy_base').value || '').trim();
    if (!val) return heroNotice('请填写 ComfyUI 地址', 'warn');
    const btn = $('#comfySave');
    btn.disabled = true; btn.textContent = '连接中…';
    try {
      const r = await post('/api/settings', {
        comfy_base: val,
        comfy_dir: ($('#p_comfy_dir').value || '').trim(),
      });
      state.comfyBase = r.comfy_base;
      state.comfyDir = r.comfy_dir || '';
      state.online = !!r.online;
      applyCatalog(r.catalog);
      $('#p_comfy_base').value = r.comfy_base;
      $('#comfyBaseMsg').textContent = r.online
        ? '已连接 ' + r.comfy_base + ' · 模型清单已同步'
        : '已保存 ' + r.comfy_base + ' · 当前连不上，请确认 ComfyUI 已启动并允许该地址访问';
      refreshStatus();
      heroNotice(r.online ? 'ComfyUI 已连接' : '地址已保存，但连接失败');
    } catch (e) { heroNotice('保存失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '保存';
  }
  async function saveComfyDir() {
    const dir = ($('#p_comfy_dir').value || '').trim();
    const btn = $('#comfyDirSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await post('/api/settings', { comfy_dir: dir });
      state.comfyDir = r.comfy_dir || '';
      $('#p_comfy_dir').value = state.comfyDir;
      heroNotice(dir ? '已保存本地目录' : '已清空，改为自动探测');
      await probeComfyDir();
    } catch (e) {
      heroNotice('保存失败：' + e.message, 'error');
    }
    btn.disabled = false; btn.textContent = '保存';
  }

  /* 把探测结果直接显示在设置页，否则用户填完没有任何反馈，不知道对没对 */
  async function probeComfyDir() {
    const msg = $('#comfyDirMsg');
    if (!msg || !msg.isConnected) return;
    msg.textContent = '正在检查…';
    try {
      const r = await api('/api/inputs?limit=1');
      const n = (r.images || []).length;
      if (r.cfg_dir && r.cfg_ok === false) {
        // 填错了不能默默用自动探测的结果蒙过去，否则用户以为保存没生效
        msg.textContent = '你填的目录无效：' + r.cfg_dir
          + (r.dir ? '。当前仍在用自动探测到的 ' + r.dir : '。请确认填的是 ComfyUI 根目录');
      } else if (r.dir) {
        msg.textContent = '当前使用：' + r.dir
          + '（' + (n ? '可以列出历史图片' : '目录存在但还没有图片') + '）';
      } else if (!r.local) {
        msg.textContent = 'ComfyUI 在另一台机器上，读不到它的 input 目录，历史列表只能显示本工具传过的图。';
      } else {
        msg.textContent = '没有找到 input 目录。请填 ComfyUI 根目录（例如 G:\\wwdm-cyui\\ComfyUI），或直接填它的 input 文件夹。';
      }
    } catch (e) {
      msg.textContent = '检查失败：' + e.message;
    }
  }

  async function testComfyBase() {
    const btn = $('#comfyTest');
    btn.disabled = true; btn.textContent = '测试中…';
    try {
      const r = await api('/api/status');
      state.online = r.online;
      $('#comfyBaseMsg').textContent = r.online
        ? '连接正常 · ' + (r.base || state.comfyBase)
        : '连接失败 · 请检查 ' + (r.base || state.comfyBase) + ' 是否可访问，以及 ComfyUI 是否带 --listen 启动';
      refreshStatus();
      heroNotice(r.online ? '连接正常' : '连接失败');
    } catch (e) { heroNotice('测试失败：' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '测试连接';
  }

  /* ---------------- 帮助页：模型就绪检测 ---------------- */
  function hasModel(kind, name) {
    const c = state.catalog || {};
    if (kind === 'lora') {
      // 加速 LoRA 是否就绪由后端按 ComfyUI 的 LoRA 清单判断
      return !!(((c.accel || {}).viggle || {}).ready);
    }
    const pool = kind === 'unet' ? (c.unets || []).concat(c.unets_gguf || [])
      : kind === 'clip' ? (c.clips || []).concat(c.clips_gguf || [])
        : (c.vaes || []);
    return pool.some(x => String(x).replace(/\\/g, '/').split('/').pop() === name);
  }
  /* 只接受 http(s) 链接，避免 javascript: / data: 之类的伪协议进入 href */
  const safeHref = (u) => {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  };
  function renderHelp() {
    if (!$('#helpModelRows')) return;
    renderUpdateCard();
    const rows = state.requiredModels || [];
    $('#helpOnline').textContent = state.online ? 'ComfyUI 在线 · 已读取模型清单' : 'ComfyUI 离线 · 无法检测';
    $('#helpOnline').className = 'help-flag ' + (state.online ? 'ok' : 'bad');
    $('#helpModelRows').innerHTML = rows.map(m => {
      const ok = state.online && hasModel(m.kind, m.name);
      const stateText = !state.online ? '未检测' : (ok ? '✓ 已就绪' : (m.required ? '✗ 缺失' : '可选 · 未放置'));
      const cls = !state.online ? 'opt' : (ok ? 'ok' : (m.required ? 'bad' : 'opt'));
      return `<tr>
        <td><span class="help-state ${cls}">${stateText}</span></td>
        <td><code>${esc(m.name)}</code></td>
        <td><code>${esc(m.folder)}</code></td>
        <td class="help-muted">${esc(m.size || '—')}</td>
        <td>${esc(m.desc)}${m.required ? '' : ' <span class="help-muted">（可选）</span>'}</td>
        <td>${safeHref(m.url) ? `<a class="help-dl" href="${esc(safeHref(m.url))}" target="_blank" rel="noreferrer noopener">镜像下载 →</a>` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="help-muted">未获取到模型清单</td></tr>';
    const g = state.gguf || {};
    const el = $('#helpGgufState');
    if (el) {
      const installed = g.unet || g.clip;
      el.textContent = !state.online ? 'ComfyUI 离线，无法检测 GGUF 节点'
        : installed ? '✓ 已检测到 GGUF 加载节点' + (g.unet ? '（主模型）' : '') + (g.clip ? '（CLIP）' : '')
          : '✗ 未检测到 UnetLoaderGGUF / CLIPLoaderGGUF，需要安装 ComfyUI-GGUF';
      el.className = 'help-flag ' + (installed ? 'ok' : (state.online ? 'bad' : ''));
    }
    renderHelpPlugins();
    // 高清放大链路检测
    const up = $('#helpUpState');
    if (up) {
      const sp = ((state.catalog || {}).seedvr2) || {};
      const hasModel = (sp.dit || []).length && (sp.vae || []).length;
      if (!state.online) { up.textContent = 'ComfyUI 离线，无法检测'; up.className = 'help-flag'; }
      else if (sp.ready && hasModel) { up.textContent = '✓ 放大链路就绪'; up.className = 'help-flag ok'; }
      else {
        up.textContent = !sp.ready ? '✗ 缺少 SeedVR2 / TTP 节点' : '✗ 缺少放大模型';
        up.className = 'help-flag bad';
      }
    }
  }

  /* 帮助页：版本与更新卡片。长期网盘链接由发布方维护（app/version.py 的 DOWNLOAD_URL），
     网盘里始终放最新版 zip，买家下载后手动覆盖安装，应用内不做自动更新。 */
  function renderUpdateCard() {
    const cur = $('#updateCurVer'), flag = $('#updateFlag'), link = $('#updateDownload');
    if (!cur) return;
    api('/api/version').then(v => {
      cur.textContent = 'v' + (v.version || '?');
      const href = safeHref(v.download_url);
      if (href) {
        link.href = href; link.classList.remove('off');
        flag.textContent = '当前 v' + (v.version || '?'); flag.className = 'help-flag ok';
      } else {
        link.removeAttribute('href'); link.classList.add('off');
        flag.textContent = '当前 v' + (v.version || '?') + ' · 下载链接待配置'; flag.className = 'help-flag';
      }
    }).catch(() => {
      cur.textContent = '读取失败';
      flag.textContent = '读取失败'; flag.className = 'help-flag bad';
    });
  }

  /* 帮助页：插件（自定义节点）检测表。检测结果在 state.catalog.plugins（后端逐类名对照 object_info） */
  function renderHelpPlugins() {
    const tbody = $('#helpPluginRows'); if (!tbody) return;
    const flag = $('#helpPluginFlag');
    const plugins = state.requiredPlugins || [];
    if (!plugins.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="help-muted">未获取到插件清单</td></tr>';
      if (flag) { flag.textContent = '清单为空'; flag.className = 'help-flag'; }
      return;
    }
    const detected = state.catalog && state.catalog.plugins || [];
    const rows = plugins.map(p => {
      const d = detected.find(x => x.key === p.key) || {};
      const online = state.online;
      const ok = online && d.ok;
      const stateText = !online ? '未检测' : (ok ? '✓ 已就绪' : (p.required ? '✗ 缺失' : '可选 · 未安装'));
      const cls = !online ? 'opt' : (ok ? 'ok' : (p.required ? 'bad' : 'opt'));
      const nodes = (p.nodes || []).map(n => {
        const miss = (d.missing || []).includes(n);
        const nc = !online ? '' : (miss ? 'bad' : 'ok');
        return `<code class="node-chip ${nc}">${esc(n)}${online ? (miss ? ' ✗' : ' ✓') : ''}</code>`;
      }).join(' ');
      const repo = safeHref(p.repo) ? ` <a class="help-dl" href="${esc(safeHref(p.repo))}" target="_blank" rel="noreferrer noopener">仓库 →</a>` : '';
      return `<tr>
        <td><span class="help-state ${cls}">${stateText}</span></td>
        <td><b>${esc(p.name)}</b>${p.required ? '' : ' <span class="help-muted">（可选）</span>'}<br>${nodes}</td>
        <td>${esc(p.desc)}</td>
        <td>${esc(p.install)}${repo}</td>
      </tr>`;
    }).join('');
    tbody.innerHTML = rows;
    if (flag) {
      const missingReq = plugins.filter(p => p.required && !(detected.find(x => x.key === p.key) || {}).ok);
      const missingOpt = plugins.filter(p => !p.required && !(detected.find(x => x.key === p.key) || {}).ok);
      if (!state.online) { flag.textContent = 'ComfyUI 离线 · 无法检测'; flag.className = 'help-flag bad'; }
      else if (missingReq.length) { flag.textContent = '✗ 缺少必备插件 ' + missingReq.map(p => p.name).join('、'); flag.className = 'help-flag bad'; }
      else if (missingOpt.length) { flag.textContent = '核心就绪 · 可选插件缺 ' + missingOpt.length + ' 个'; flag.className = 'help-flag opt'; }
      else { flag.textContent = '✓ 全部 ' + plugins.length + ' 个插件就绪'; flag.className = 'help-flag ok'; }
    }
  }

  /* ---------------- 队列详情小窗 ---------------- */
  function queueRowHTML(r) {
    const pct = Math.round(r.progress || 0);
    const tags = [
      r.skill || '外部任务',
      r.seed != null ? 'seed ' + r.seed : '',
      r.batch ? '×' + r.batch : '',
      samplingLabel(r.sampling),
      r.steps ? r.steps + ' 步' : '',
      r.total ? r.step + '/' + r.total : '',
      r.elapsed != null ? r.elapsed + 's' : '',
    ].filter(Boolean);
    const st = r.status === 'running' ? 'running' : 'pending';
    return `<div class="queue-item ${st}">
      <div class="queue-top">
        <span class="queue-idx">${r.number}</span>
        <b>${esc(r.short_id)}</b>
        <span class="queue-badge ${st}">${st === 'running' ? '执行中' : '排队中'}</span>
        <span class="help-muted" style="margin-left:auto">${r.tracked ? '' : '非本应用提交'}</span>
      </div>
      <div class="queue-prompt">${esc(r.prompt || '（无提示词记录）')}</div>
      <div class="queue-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
      ${st === 'running' ? `<div class="queue-bar"><i style="width:${pct}%"></i></div>` : ''}
    </div>`;
  }
  function openQueueModal() {
    $('#queueModal').classList.remove('hidden');
    $('#queueBody').innerHTML = '<div class="help-muted">读取队列中…</div>';
    loadQueueDetail();
  }
  let queueLoading = false;
  async function loadQueueDetail() {
    if (queueLoading) return;
    queueLoading = true;
    const body = $('#queueBody');
    try {
      const r = await api('/api/queue/detail');
      $('#queueAddr').textContent = r.comfy_base || state.comfyBase || '';
      if (!r.online) {
        body.innerHTML = '<div class="queue-empty">ComfyUI 未连接：' + esc(r.error || '请先在设置页检查服务地址') + '</div>';
        $('#queueSummary').textContent = '未连接';
        return;
      }
      const running = r.running || [], pending = r.pending || [];
      body.innerHTML =
        `<div class="queue-sec"><div class="queue-sec-head">运行中 <b>${running.length}</b></div>
          ${running.length ? running.map(queueRowHTML).join('') : '<div class="queue-empty">当前没有执行中的任务</div>'}</div>
         <div class="queue-sec"><div class="queue-sec-head">等待中 <b>${pending.length}</b></div>
          ${pending.length ? pending.map(queueRowHTML).join('') : '<div class="queue-empty">队列为空</div>'}</div>`;
      $('#queueSummary').textContent = '共 ' + (running.length + pending.length) + ' 个任务 · 运行 ' + running.length + ' / 排队 ' + pending.length;
    } catch (e) {
      body.innerHTML = '<div class="queue-empty">读取失败：' + esc(e.message) + '</div>';
      $('#queueSummary').textContent = '读取失败';
    } finally {
      queueLoading = false;
    }
  }

  /* ---------------- 状态 / 日志 ---------------- */
  async function refreshStatus() {
    try {
      const r = await api('/api/status');
      state.online = r.online;
      if (r.base) state.comfyBase = r.base;
      $('#connDot').className = 'dot ' + (r.online ? 'on' : 'off');
      $('#connText').textContent = r.online ? 'ComfyUI 已连接' : 'ComfyUI 未连接';
      const q = r.queue || {};
      const qText = '队列 ' + ((q.queue_running || []).length + (q.queue_pending || []).length);
      $('#queuePill').textContent = qText;
      const cvQ = $('#cvQueuePill'); if (cvQ) cvQ.textContent = qText;
      const dev = ((r.stats || {}).devices || [])[0] || {};
      $('#statusInfo').innerHTML = `服务地址：<b>${esc(r.base || state.comfyBase)}</b><br>状态：<b style="color:${r.online ? 'var(--ok)' : 'var(--danger)'}">${r.online ? '在线' : '离线'}</b><br>显卡：<b>${esc(dev.name || '未知')}</b><br>显存：<b>${Math.round((dev.vram_total || 0) / 1073741824)} GB</b><br>可用模型：<b>${(state.catalog.unets || []).length}</b> 个 UNET / <b>${(state.catalog.unets_gguf || []).length}</b> 个 GGUF / <b>${(state.catalog.loras || []).length}</b> 个 LoRA`;
      fillComfyBase();
      if (state.view === 'help') renderHelp();
      // 队列小窗开着时跟着状态轮询一起刷新
      const qm = $('#queueModal');
      if (qm && !qm.classList.contains('hidden')) loadQueueDetail();
      $('#logBox').textContent = (r.logs || []).join('\n') || '暂无日志';
      $('#logBox').scrollTop = $('#logBox').scrollHeight;
      // 后端兜底回收的结果：即使页面刷新过、轮询集合丢失，也能同步回来
      if (Array.isArray(r.pending_jobs)) r.pending_jobs.forEach(p => state.pending.add(p));
      if (r.gallery_count != null) {
        if (r.gallery_count > (state.lastGalleryCount || 0)) {
          // 后端兜底回收出的结果也走同一条同步链路（对话 / 画布 / 助手）
          clearCvProgress();
          syncGeneratedViews({ silent: true });
        }
        state.lastGalleryCount = Math.max(state.lastGalleryCount || 0, r.gallery_count);
      }
    } catch (e) { /* 静默 */ }
  }

  /* ---------------- 无限画布 ----------------
     第一次出图完成后进入这个全屏页面；之后所有生成都留在这里。
     图片卡片可自由拖拽、下载、删除、改名，位置与名称持久化到后端 history.json。
     画布上下左右无限拉伸：sizer 覆盖「内容包围盒 + 四周余量」，滚到边缘自动再扩。 */
  const CV = { cardW: 236, startX: 60, startY: 84, margin: 1600, cols: 4 };
  const CV_COLS = CV.cols;
  /* 世界坐标边界（可含负值）：cvWorld 在 sizer 里按 -minX/-minY 偏移定位 */
  let cvB = { minX: -1600, minY: -1200, maxX: 3600, maxY: 2800 };
  /* 滚到边缘主动扩出来的额外空间（四向），重算边界时补回去。
     单独记一份，避免「内容包围盒」和「手动扩展」互相污染导致无限膨胀 */
  let cvPad = { l: 0, t: 0, r: 0, b: 0 };
  /* 整理间距来自「全局设置 → 自由画布」，横向 / 纵向分开，8~120px。
     旧版单一 canvas_gap 自动作为两方向的默认值。 */
  const clampGap = v => Math.max(8, Math.min(120, Number(v) || 0));
  function cvGapX() { return clampGap(state.params.canvas_gap_x) || clampGap(state.params.canvas_gap) || 28; }
  function cvGapY() { return clampGap(state.params.canvas_gap_y) || clampGap(state.params.canvas_gap) || 28; }
  /* 列步进 = 卡片宽 + 横向间距。
     以前的写法是「先用固定总宽 2400 除以 4 列得到列宽，再额外加间距」，
     235 宽的卡片被塞进 549 宽的列里，实际左右空隙变成 341px——设置页写的
     「卡片左右之间 28px」根本没生效。现在直接由卡片宽度决定列宽。 */
  function colStep() { return CV.cardW + cvGapX(); }
  /* 瀑布流整体宽度（世界坐标）：两侧留白 + 4 列卡片 + 3 个横向间距 */
  function wfWidth() { return CV.startX * 2 + CV_COLS * CV.cardW + (CV_COLS - 1) * cvGapX(); }

  function bindCanvas() {
    $('#cvHome').addEventListener('click', () => switchView('home'));
    $('#cvToChat').addEventListener('click', () => switchView(state.sessionId ? 'chat' : 'home'));
    // 右上角与对话模式顶栏一一对应，行为完全一致
    $('#cvQueuePill').addEventListener('click', openQueueModal);
    $('#cvThemeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    $('#cvDeleteBtn').addEventListener('click', deleteCurrentSession);
    $('#cvParams').addEventListener('click', openDrawer);
    $('#cvTitle').addEventListener('dblclick', startCanvasTitleRename);
    $('#cvFold').addEventListener('click', () => $('#cvCompose').classList.toggle('collapsed'));
    // 左上角工具条：点击箭头收缩成一个图标，再点展开为长条
    $('#cvBarFold').addEventListener('click', () => {
      const bar = $('#cvTopleft');
      const collapsed = bar.classList.toggle('collapsed');
      $('#cvBarFold').textContent = collapsed ? '▶' : '◀';
      $('#cvBarFold').title = collapsed ? '展开工具条' : '收起工具条';
      try { localStorage.setItem('cyui_cvbar', collapsed ? '1' : '0'); } catch (e) {}
    });
    try { if (localStorage.getItem('cyui_cvbar') === '1') { $('#cvTopleft').classList.add('collapsed'); $('#cvBarFold').textContent = '▶'; } } catch (e) {}
    $('#cvZoomIn').addEventListener('click', () => cvZoomTo(state.canvasZoom + 0.1));
    $('#cvZoomOut').addEventListener('click', () => cvZoomTo(state.canvasZoom - 0.1));
    $('#cvFit').addEventListener('click', () => cvZoomTo(1));
    $('#cvArrange').addEventListener('click', arrangeCanvas);
    $('#cvViewport').addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;   // 普通滚轮仍用于滚动画布
      e.preventDefault();
      const old = state.canvasZoom;
      const nz = Math.max(0.4, Math.min(1.8, Math.round((old + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10));
      if (nz === old) return;
      // 以鼠标为中心：记住指针下的世界坐标，缩放后让它回到指针位置
      const wr = $('#cvWorld').getBoundingClientRect();
      const wx = (e.clientX - wr.left) / old;
      const wy = (e.clientY - wr.top) / old;
      setCanvasZoom(nz);
      const vp = $('#cvViewport');
      const vr = vp.getBoundingClientRect();
      vp.scrollLeft = wx * nz - (e.clientX - vr.left);
      vp.scrollTop = wy * nz - (e.clientY - vr.top);
    }, { passive: false });
    // 空白处：Ctrl+左键拖动 = 框选编组；普通拖动 = 平移画布；点一下空白 = 取消选择
    $('#cvViewport').addEventListener('contextmenu', e => {
      if (marquee.active) e.preventDefault();
    });
    $('#cvViewport').addEventListener('pointerdown', e => {
      const vp = $('#cvViewport');
      if ((e.ctrlKey || e.metaKey) && e.button === 0) {
        e.preventDefault();
        marquee.active = true;
        marquee.x0 = marquee.x1 = e.clientX;
        marquee.y0 = marquee.y1 = e.clientY;
        vp.setPointerCapture(e.pointerId);
        showMarquee();
        return;
      }
      if (e.target.closest('.cv-card') || e.target.closest('.cv-bar') || e.target.closest('.cv-compose')) return;
      const sx = e.clientX, sy = e.clientY, sl = vp.scrollLeft, st = vp.scrollTop;
      let panned = false;
      vp.setPointerCapture(e.pointerId);
      const move = ev => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) panned = true;
        vp.scrollLeft = sl - (ev.clientX - sx);
        vp.scrollTop = st - (ev.clientY - sy);
      };
      const up = () => {
        vp.removeEventListener('pointermove', move);
        vp.removeEventListener('pointerup', up);
        if (!panned && state.canvasSelection.size) clearSelection(false);
      };
      vp.addEventListener('pointermove', move);
      vp.addEventListener('pointerup', up);
    });
    $('#cvViewport').addEventListener('pointermove', e => {
      if (!marquee.active) return;
      marquee.x1 = e.clientX; marquee.y1 = e.clientY; drawMarquee();
    });
    $('#cvViewport').addEventListener('pointerup', e => { if (marquee.active) finishMarquee(); });
    $('#cvViewport').addEventListener('scroll', () => {
      if (state.canvasSelection.size) { updateGroupFrame(); positionSelDock(); }
      cvViewScheduleSave();   // 记住浏览位置，下次进画布直接回到这里
      // 节流：平滑滚动 / 惯性滚动结束后再判定扩展，避免滚动途中连续膨胀边界
      clearTimeout(cvExpandTimer);
      cvExpandTimer = setTimeout(cvExpandBounds, 180);
    });
    $('#cvGroup').addEventListener('click', groupSelection);
    $('#cvUngroup').addEventListener('click', ungroupSelection);
    $('#cvDownloadSel').addEventListener('click', downloadSelection);
    $('#cvDeleteSel').addEventListener('click', deleteSelection);
    $('#cvClearSel').addEventListener('click', () => clearSelection(false));
    document.addEventListener('keydown', e => {
      if (state.view !== 'canvas') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.canvasSelection.size) {
        e.preventDefault(); deleteSelection();
      } else if (e.key === 'Escape') {
        clearSelection(false);
      }
    });
    const world = $('#cvWorld');
    world.addEventListener('pointerdown', onCanvasCardDown);
    world.addEventListener('click', onCanvasCardClick);
    world.addEventListener('dblclick', onCanvasCardDblClick);
    world.addEventListener('keydown', onCanvasRenameKey);
    world.addEventListener('focusout', onCanvasRenameBlur);
  }

  function setCanvasZoom(z) {
    state.canvasZoom = Math.max(0.2, Math.min(1.8, Math.round(z * 100) / 100));
    const k = state.canvasZoom;
    $('#cvWorld').style.transform = 'scale(' + k + ')';
    updateCanvasBounds();
    applyCanvasSize();
    $('#cvZoomLabel').textContent = Math.round(state.canvasZoom * 100) + '%';
    if (state.canvasSelection.size) { updateGroupFrame(); positionSelDock(); }
    cvViewScheduleSave();
  }

  /* 按钮缩放：以视口中心为锚点。
     setCanvasZoom 本身不动滚动位置，直接调会让画面往左上「跑掉」——
     缩放前把视口中心的世界坐标记住，缩放后再把它放回中心。 */
  function cvZoomTo(z) {
    const vp = $('#cvViewport'); if (!vp) return;
    const old = state.canvasZoom || 1;
    const nz = Math.max(0.2, Math.min(1.8, Math.round(z * 100) / 100));
    if (nz === old) return;
    const wx = (vp.scrollLeft + vp.clientWidth / 2) / old + cvB.minX;
    const wy = (vp.scrollTop + vp.clientHeight / 2) / old + cvB.minY;
    setCanvasZoom(nz);
    vp.scrollLeft = Math.max(0, (wx - cvB.minX) * nz - vp.clientWidth / 2);
    vp.scrollTop = Math.max(0, (wy - cvB.minY) * nz - vp.clientHeight / 2);
    cvViewScheduleSave();
  }

  /* 世界坐标边界：内容包围盒向四周各扩 margin，且至少完整覆盖视口（含负坐标区） */
  function updateCanvasBounds() {
    const vp = $('#cvViewport'); if (!vp) return;
    const k = state.canvasZoom;
    /* 每次都从「内容包围盒」重算，绝不拿上一次的 cvB 当起点。
       旧写法 `let minX = cvB.minX` 再 `- CV.margin`，等于每调一次缩放、
       每重绘一次就往外胀 1600px，sizer 越滚越大、滚动位置持续漂移，
       「同一个会话每次进来视角都不一样」有一半是这个造成的。
       滚到边缘主动扩出来的空间记在 cvPad 里，重算时补回去。 */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    canvasItems().forEach(g => {
      const x = numOr(g.x, 0), y = numOr(g.y, 0);
      const s = Math.max(0.5, Math.min(2, numOr(g.scale, 1)));
      minX = Math.min(minX, x - 80); minY = Math.min(minY, y - 80);
      maxX = Math.max(maxX, x + CV.cardW * s + 80);
      maxY = Math.max(maxY, y + cardHeightFor(g) + 80);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = CV.cardW; maxY = 480; }
    // 内容四周留出余量（手感）+ 用户滚到边缘扩出来的额外空间
    minX -= CV.margin + cvPad.l; minY -= CV.margin + cvPad.t;
    maxX += CV.margin + cvPad.r; maxY += CV.margin + cvPad.b;
    const vw = vp.clientWidth / k, vh = vp.clientHeight / k;
    maxX = Math.max(maxX, minX + vw + 40);
    maxY = Math.max(maxY, minY + vh + 40);
    cvB = { minX, minY, maxX, maxY };
  }

  /* sizer 覆盖 [minX..maxX]×[minY..maxY]，世界原点按 -minX/-minY 偏移进 sizer */
  function applyCanvasSize() {
    const k = state.canvasZoom;
    const sizer = $('#cvSizer'), world = $('#cvWorld');
    sizer.style.width = Math.round((cvB.maxX - cvB.minX) * k) + 'px';
    sizer.style.height = Math.round((cvB.maxY - cvB.minY) * k) + 'px';
    world.style.left = Math.round(-cvB.minX * k) + 'px';
    world.style.top = Math.round(-cvB.minY * k) + 'px';
  }

  /* 滚到边缘自动扩展（每步 2000 世界单位），实现四向无限拉伸 */
  let cvExpanding = false;
  let cvExpandTimer = null;
  function cvExpandBounds() {
    if (cvExpanding) return;
    const vp = $('#cvViewport'); if (!vp) return;
    const k = state.canvasZoom, STEP = 2000;
    let hit = false;
    if (vp.scrollLeft < 300) { cvPad.l += STEP; hit = true; }
    if (vp.scrollTop < 300) { cvPad.t += STEP; hit = true; }
    if (vp.scrollWidth - vp.scrollLeft - vp.clientWidth < 300) { cvPad.r += STEP; hit = true; }
    if (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 300) { cvPad.b += STEP; hit = true; }
    if (!hit) return;
    cvExpanding = true;
    const oldMinX = cvB.minX, oldMinY = cvB.minY;
    updateCanvasBounds();
    applyCanvasSize();
    // 世界原点偏移变化后补偿滚动量，画面保持不动，只是可滚区域变大了
    const dl = (oldMinX - cvB.minX) * k, dt = (oldMinY - cvB.minY) * k;
    if (dl) vp.scrollLeft += dl;
    if (dt) vp.scrollTop += dt;
    setTimeout(() => { cvExpanding = false; }, 60);
  }

  /* 整理后按内容包围盒自适应缩放，让当前画布的每张作品都落在视口里 */
  function fitCanvasToContent() {
    const items = canvasItems(), vp = $('#cvViewport');
    if (!vp || !items.length) return 0;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    items.forEach(g => {
      const x = numOr(g.x, CV.startX), y = numOr(g.y, CV.startY);
      const s = Math.max(0.5, Math.min(2, numOr(g.scale, 1)));
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + CV.cardW * s);
      maxY = Math.max(maxY, y + cardHeightFor(g));
    });
    const pad = 40;
    const cw = maxX - minX + pad * 2, ch = maxY - minY + pad * 2;
    const z = Math.max(0.2, Math.min(1.2,
      Math.min(vp.clientWidth / Math.max(1, cw), vp.clientHeight / Math.max(1, ch))));
    setCanvasZoom(z);
    vp.scrollTo({ left: Math.max(0, (minX - pad - cvB.minX) * z), top: Math.max(0, (minY - pad - cvB.minY) * z), behavior: 'smooth' });
    return z;
  }

  /* 列式累积布局：图片按原始比例显示后高度不一，固定网格会重叠。
     每列记录底部 y，新作品追加到最矮列，任何比例都不重叠。
     一个对话一个画布：只显示当前会话（含升级前的无会话旧图，归入新对话前的空会话）。 */
  let colY = [];
  function canvasItems() {
    return state.gallery.filter(g =>
      g.session_id ? g.session_id === state.sessionId : !state.sessionId);
  }
  function cardHeightFor(g) {
    const s = Math.max(0.5, Math.min(2, numOr(g.scale, 1)));
    const w = CV.cardW * s;
    const gw = Math.max(64, numOr(g.width, 1024)), gh = Math.max(64, numOr(g.height, 1024));
    // 标题栏 + 信息条 ≈ 58px，再加卡片上下 1px 边框（.cv-card 是 border-box 之外的
    // 1px 实线）—— 漏掉这 2px 会让实际纵向间距比设置值少 2px
    return 60 + w * gh / gw;
  }
  function resetCols() {
    colY = Array(CV_COLS).fill(CV.startY);
    // 已手动摆放过的项撑起所在列的高度，追加的新项不会压到它们
    canvasItems().forEach(g => {
      if (g.x == null || g.y == null) return;
      const c = Math.max(0, Math.min(CV_COLS - 1, Math.round((g.x - CV.startX) / colStep())));
      colY[c] = Math.max(colY[c], numOr(g.y, 0) + cardHeightFor(g) + cvGapY());
    });
  }
  function shortestCol() {
    let best = 0;
    for (let c = 1; c < CV_COLS; c++) if (colY[c] < colY[best]) best = c;
    return best;
  }
  function defaultPos(i) {   // 兜底用：正常情况下 assignMissingSlots 已补全坐标
    return { x: CV.startX + (i % CV_COLS) * colStep(), y: CV.startY };
  }
  const numOr = (v, d) => (v === null || v === undefined || !isFinite(Number(v))) ? d : Number(v);

  async function assignMissingSlots(persist) {
    // 新生成的图没有坐标：追加到最矮列并推进列高，生成完成即刻可见且不压旧图
    resetCols();
    const jobs = [];
    for (const g of canvasItems()) {
      if (g.x != null && g.y != null) continue;
      const c = shortestCol();
      g.x = CV.startX + c * colStep();
      g.y = colY[c];
      colY[c] = g.y + cardHeightFor(g) + cvGapY();
      if (persist) {
        jobs.push(post('/api/gallery/' + encodeURIComponent(g.id),
          { x: Math.round(g.x), y: Math.round(g.y) }).catch(() => {}));
      }
    }
    if (jobs.length) await Promise.all(jobs);
  }
  const ensureCanvasPositions = () => assignMissingSlots(true);

  /* 视图基准：以「首张出图」那一刻的视角为默认值 —— 100% 缩放、内容左上角。
     以前每次进画布都 fitCanvasToContent()，图越多缩得越小、落点也跟着变，
     同一个会话进出两次看到的画面完全不同。现在：
       · 首次进入某会话 → 固定基准视角（就是只有一张图时看到的样子）
       · 之后进入 → 恢复上次的缩放与滚动位置
       · 「▦ 整理」是用户主动操作，仍然 fit 一次并把这个视角记下来 */
  const cvVisited = new Set();
  function cvViewKey() { return 'cyui_cvview_' + (state.sessionId || 'none'); }
  /* 存「视口左上角对应的世界坐标」而不是 scrollLeft/scrollTop：
     滚动像素依赖当时的画布边界，边界一变（滚到边缘会扩、缩放会重算）
     存下来的像素值就全错位了。世界坐标和边界无关，永远对得上。 */
  function cvViewStore() {
    const vp = $('#cvViewport'); if (!vp) return;
    const k = state.canvasZoom || 1;
    try {
      localStorage.setItem(cvViewKey(), JSON.stringify({
        z: k,
        x: Math.round(vp.scrollLeft / k + cvB.minX),
        y: Math.round(vp.scrollTop / k + cvB.minY),
      }));
    } catch (e) { /* 隐私模式忽略 */ }
  }
  let cvViewSaveTimer = 0;
  function cvViewScheduleSave() {
    clearTimeout(cvViewSaveTimer);
    cvViewSaveTimer = setTimeout(cvViewStore, 400);
  }
  function cvEnsureView() {
    const vp = $('#cvViewport'); if (!vp) return;
    const key = state.sessionId || 'none';
    if (cvVisited.has(key)) return;
    cvVisited.add(key);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(cvViewKey()) || 'null'); } catch (e) { /* 忽略 */ }
    const z = (saved && saved.z) ? Math.max(0.2, Math.min(1.8, Number(saved.z))) : 1;
    setCanvasZoom(z);
    const wx = (saved && isFinite(Number(saved.x))) ? Number(saved.x) : (CV.startX - 40);
    const wy = (saved && isFinite(Number(saved.y))) ? Number(saved.y) : (CV.startY - 56);
    vp.scrollLeft = Math.max(0, (wx - cvB.minX) * z);
    vp.scrollTop = Math.max(0, (wy - cvB.minY) * z);
  }

  function renderCanvas() {
    assignMissingSlots(false);   // 同步部分立即补全坐标，任何入口渲染都不会重叠
    const items = canvasItems();
    const sess = state.sessionId ? (state.sessions.find(s => s.id === state.sessionId) || {}).title : null;
    const titleEl = $('#cvTitle');
    if (titleEl && titleEl.dataset.editing !== '1') {
      titleEl.textContent = sess ? '画布 · ' + sess : '自由画布';
      titleEl.title = sess ? sess + ' · 双击重命名' : '双击重命名画布';
    }
    $('#cvCount').textContent = items.length + ' 张作品';
    $('#cvEmpty').classList.toggle('hidden', items.length > 0);
    $('#cvWorld').innerHTML = items.map((g, i) => {
      const p = defaultPos(i);
      const x = numOr(g.x, p.x), y = numOr(g.y, p.y);
      const s = Math.max(0.5, Math.min(2, numOr(g.scale, 1)));
      const name = g.name || (g.prompt || '').split('\n')[0] || '未命名作品';
      const sel = state.canvasSelection.has(String(g.id)) ? ' selected' : '';
      const badge = g.group ? '<span class="cv-group" title="已打组 · 拖动任一张可整组移动">⌗</span>' : '';
      return `<div class="cv-card${sel}" data-gid="${esc(g.id)}" style="left:${x}px;top:${y}px;width:${Math.round(CV.cardW * s)}px">
        <div class="cv-card-bar">
          ${badge}<span class="cv-name" title="${esc(name)}">${esc(name)}</span>
          <div class="cv-card-acts">
            <button data-cact="download" title="下载">↓</button>
            <button data-cact="rename" title="更改名称">✎</button>
            <button data-cact="delete" title="删除">×</button>
          </div>
        </div>
        <img src="${esc(g.url)}" alt="${esc(name)}" draggable="false" style="aspect-ratio:${Math.max(1, g.width || 1)}/${Math.max(1, g.height || 1)}">
        <div class="cv-prompt" title="${esc(g.prompt || name)}">${esc(g.prompt || name)}</div>
        <div class="cv-card-foot">${g.width || '?'}×${g.height || '?'} · ${esc(g.skill || '文生图')}</div>
      </div>`;
    }).join('');
    setCanvasZoom(state.canvasZoom);
    syncSelectionUI();
  }

  /* 双击画布标题 → 重命名当前画布（画布名与会话名同源，改名全局同步） */
  function startCanvasTitleRename() {
    if (!state.sessionId) return heroNotice('先打开一个对话的画布再改名', 'warn');
    const s = state.sessions.find(x => x.id === state.sessionId);
    const el = $('#cvTitle');
    if (!s || !el || el.dataset.editing === '1') return;
    el.dataset.editing = '1';
    el.textContent = '';
    const input = document.createElement('input');
    input.className = 'cv-title-edit';
    input.value = s.title || '新对话';
    el.appendChild(input);
    input.focus(); input.select();
    const commit = async () => {
      if (input.dataset.done) return;
      input.dataset.done = '1';
      const title = (input.value || '').trim().slice(0, 40);
      el.dataset.editing = '';
      if (title && title !== s.title) {
        try {
          await post('/api/sessions/' + encodeURIComponent(s.id) + '/rename', { title });
          s.title = title;
        } catch (e) { heroNotice('重命名失败：' + e.message, 'error'); }
      }
      renderSessions(); renderCanvas();
      if (state.view === 'chat') switchView('chat');
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { input.dataset.done = '1'; el.dataset.editing = ''; renderCanvas(); }
    });
    input.addEventListener('blur', commit);
  }

  function onCanvasCardDown(e) {
    const card = e.target.closest('.cv-card'); if (!card) return;
    if (e.target.closest('button') || e.target.closest('.cv-rename')) return;
    const g = state.gallery.find(x => x.id === card.dataset.gid); if (!g) return;
    // setPointerCapture 会把后续 click 的 target 重定向到卡片，所以必须在
    // capture 之前记下「这一下是否点在图片上」，否则永远打不开大图。
    card.dataset.hitImg = e.target.tagName === 'IMG' ? '1' : '0';
    card.dataset.moved = '0';
    // 一起移动的范围：Ctrl 多选集 > 同一组 > 单张
    let moving = [g];
    if (state.canvasSelection.has(g.id) && state.canvasSelection.size > 1) {
      moving = state.gallery.filter(x => state.canvasSelection.has(x.id));
    } else if (g.group) {
      moving = state.gallery.filter(x => x.group && x.group === g.group);
    }
    const sx = e.clientX, sy = e.clientY, z = state.canvasZoom;
    const origins = moving.map(m => ({
      g: m, x: numOr(m.x, 0), y: numOr(m.y, 0),
      el: $('.cv-card[data-gid="' + m.id + '"]', $('#cvWorld')),
    }));
    let moved = false;
    origins.forEach(o => { if (o.el) o.el.classList.add('dragging'); });
    state.canvasDragging = true;
    card.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; card.dataset.moved = '1'; }
      origins.forEach(o => {
        // 无限画布：坐标不再受固定边界限制，可以摆到任何位置
        o.g.x = o.x + dx;
        o.g.y = o.y + dy;
        if (o.el) { o.el.style.left = o.g.x + 'px'; o.el.style.top = o.g.y + 'px'; }
      });
    };
    const up = () => {
      origins.forEach(o => { if (o.el) o.el.classList.remove('dragging'); });
      state.canvasDragging = false;
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      if (moved) {
        Promise.all(origins.map(o => post('/api/gallery/' + encodeURIComponent(o.g.id),
          { x: Math.round(o.g.x), y: Math.round(o.g.y) }).catch(() => {})));
        setCanvasZoom(state.canvasZoom);   // 拖出旧边界后扩展可滚区域
      }
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  }

  async function onCanvasCardClick(e) {
    const card = e.target.closest('.cv-card'); if (!card) return;
    const g = state.gallery.find(x => x.id === card.dataset.gid); if (!g) return;
    // Ctrl / ⌘ + 左键 = 多选，不触发大图
    if (e.ctrlKey || e.metaKey) {
      toggleSelection(g.id); card.dataset.moved = '0'; return;
    }
    if (state.canvasSelection.size) clearSelection(false);
    // 按钮优先，避免上一次 hitImg 残留导致误弹大图
    const btn = e.target.closest('button[data-cact]');
    if (btn) {
      const act = btn.dataset.cact;
      if (act === 'download') {
        const a = document.createElement('a');
        a.href = g.url;
        a.download = (String(g.name || 'cyui_作品').replace(/[\\/:*?"<>|]/g, '_') || 'cyui') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        heroNotice('已开始下载');
      } else if (act === 'delete') {
        if (!(await confirmDialog('删除「' + (g.name || '作品') + '」？\n图片文件将移入 Windows 回收站（可随时恢复），不影响对话记录。'))) return;
        const r = await api('/api/gallery/' + encodeURIComponent(g.id), { method: 'DELETE' });
        state.lastGalleryCount = Math.max(0, (state.lastGalleryCount || 1) - 1);
        await applyLinkedDeletion(r);
        heroNotice('已删除（文件已移入回收站）');
        notifyDeleteFailed(r);
      } else if (act === 'rename') {
        startRename(card, g);
      }
      return;
    }
    // 点缩略图弹快捷菜单（查看大图 / 高清放大 / 抠图…）；刚拖完的那一下不弹
    if (card.dataset.hitImg === '1' || e.target.tagName === 'IMG') {
      if (card.dataset.moved !== '1') {
        openImgMenu(e.clientX, e.clientY, galleryMenuInfo(g.id));
      }
      card.dataset.moved = '0'; card.dataset.hitImg = '0';
    }
  }

  /* ---- 多选 / 框选 / 打组 / 批量操作 ---- */
  const marquee = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };
  function showMarquee() { $('#cvMarquee').classList.remove('hidden'); drawMarquee(); }
  function drawMarquee() {
    const m = $('#cvMarquee');
    m.style.left = Math.min(marquee.x0, marquee.x1) + 'px';
    m.style.top = Math.min(marquee.y0, marquee.y1) + 'px';
    m.style.width = Math.abs(marquee.x1 - marquee.x0) + 'px';
    m.style.height = Math.abs(marquee.y1 - marquee.y0) + 'px';
  }
  function finishMarquee() {
    marquee.active = false;
    $('#cvMarquee').classList.add('hidden');
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    if (x1 - x0 < 6 && y1 - y0 < 6) {   // 只是点了一下空白：取消选择
      if (state.canvasSelection.size) clearSelection(false);
      return;
    }
    const ids = [];
    $$('.cv-card', $('#cvWorld')).forEach(card => {
      const cr = card.getBoundingClientRect();
      if (cr.left < x1 && cr.right > x0 && cr.top < y1 && cr.bottom > y0) ids.push(card.dataset.gid);
    });
    state.canvasSelection = new Set(ids);
    syncSelectionUI();
    if (ids.length) heroNotice('已框选 ' + ids.length + ' 张 · 可创建编组 / 整组移动 / 删除');
  }

  function syncSelectionUI() {
    $$('.cv-card', $('#cvWorld')).forEach(el =>
      el.classList.toggle('selected', state.canvasSelection.has(el.dataset.gid)));
    const n = state.canvasSelection.size;
    $('#cvSelDock').classList.toggle('hidden', n === 0);
    $('#cvSelInfo').textContent = '已选 ' + n + ' 张';
    updateGroupFrame();
    if (n) positionSelDock();
  }
  function updateGroupFrame() {
    const world = $('#cvWorld');
    let el = $('#cvGroupFrame');
    if (!state.canvasSelection.size) { if (el) el.remove(); return; }
    const wr = world.getBoundingClientRect();
    const z = state.canvasZoom || 1;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    state.canvasSelection.forEach(id => {
      const card = $('.cv-card[data-gid="' + id + '"]', world);
      if (!card) return;
      const cr = card.getBoundingClientRect();
      l = Math.min(l, (cr.left - wr.left) / z);
      t = Math.min(t, (cr.top - wr.top) / z);
      r = Math.max(r, (cr.right - wr.left) / z);
      b = Math.max(b, (cr.bottom - wr.top) / z);
    });
    if (l === Infinity) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'cvGroupFrame';
      el.className = 'cv-group-frame';
      world.appendChild(el);
    }
    el.style.left = (l - 6) + 'px';
    el.style.top = (t - 6) + 'px';
    el.style.width = (r - l + 12) + 'px';
    el.style.height = (b - t + 12) + 'px';
  }
  function positionSelDock() {
    const dock = $('#cvSelDock');
    if (dock.classList.contains('hidden')) return;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    state.canvasSelection.forEach(id => {
      const card = $('.cv-card[data-gid="' + id + '"]', $('#cvWorld'));
      if (!card) return;
      const cr = card.getBoundingClientRect();
      l = Math.min(l, cr.left); t = Math.min(t, cr.top);
      r = Math.max(r, cr.right); b = Math.max(b, cr.bottom);
    });
    if (l === Infinity) return;
    const dw = dock.offsetWidth || 380, dh = dock.offsetHeight || 44;
    dock.style.left = Math.max(8, Math.min(window.innerWidth - dw - 8, (l + r) / 2 - dw / 2)) + 'px';
    dock.style.top = Math.max(8, Math.min(window.innerHeight - dh - 8, b + 14)) + 'px';
  }
  function toggleSelection(id) {
    if (state.canvasSelection.has(id)) state.canvasSelection.delete(id);
    else state.canvasSelection.add(id);
    syncSelectionUI();
  }
  function clearSelection(rerender) {
    state.canvasSelection.clear();
    if (rerender) renderCanvas();
    else syncSelectionUI();
  }
  async function downloadSelection() {
    const ids = Array.from(state.canvasSelection);
    if (!ids.length) return;
    let i = 0;
    ids.forEach(id => {
      const g = state.gallery.find(x => x.id === id); if (!g) return;
      const a = document.createElement('a');
      a.href = g.url;
      a.download = (String(g.name || 'cyui_作品').replace(/[\\/:*?"<>|]/g, '_') || 'cyui') + '_' + (++i) + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
    heroNotice('已开始下载 ' + i + ' 张');
  }
  async function groupSelection() {
    const ids = Array.from(state.canvasSelection);
    if (ids.length < 2) return heroNotice('按住 Ctrl 至少选择 2 张图片再打组');
    const key = 'grp' + Date.now().toString(36);
    await Promise.all(ids.map(id => {
      const g = state.gallery.find(x => x.id === id); if (g) g.group = key;
      return post('/api/gallery/' + encodeURIComponent(id), { group: key }).catch(() => {});
    }));
    renderCanvas();   // 保留选中态：绿色组合框与操作条仍在（参考图效果）
    heroNotice('已把 ' + ids.length + ' 张打成一个组 · 拖动任一张可整组移动');
  }
  async function ungroupSelection() {
    const ids = state.canvasSelection.size ? Array.from(state.canvasSelection)
      : state.gallery.filter(g => g.group).map(g => g.id);
    if (!ids.length) return heroNotice('没有已打组的图片', 'error');
    await Promise.all(ids.map(id => {
      const g = state.gallery.find(x => x.id === id); if (g) g.group = '';
      return post('/api/gallery/' + encodeURIComponent(id), { group: '' }).catch(() => {});
    }));
    clearSelection(false); renderCanvas(); heroNotice('已解组 ' + ids.length + ' 张');
  }
  async function deleteSelection() {
    const ids = Array.from(state.canvasSelection);
    if (!ids.length) return;
    if (!(await confirmDialog('移除画布上选中的 ' + ids.length + ' 张图片？\n图片文件将移入 Windows 回收站（可随时恢复），不影响对话记录。'))) return;
    try {
      const r = await post('/api/gallery/batch-delete', { ids });
      state.lastGalleryCount = Math.max(0, (state.lastGalleryCount || ids.length) - ids.length);
      state.canvasSelection.clear();
      await applyLinkedDeletion(r);
      heroNotice('已移除 ' + (r.deleted || ids.length) + ' 张（文件已移入回收站，对话记录保留）');
      notifyDeleteFailed(r);
    } catch (e) { heroNotice('删除失败：' + e.message, 'error'); }
  }

  function onCanvasCardDblClick(e) {
    const label = e.target.closest('.cv-name'); if (!label) return;
    const card = label.closest('.cv-card'); if (!card) return;
    const g = state.gallery.find(x => x.id === card.dataset.gid); if (g) startRename(card, g);
  }
  function startRename(card, g) {
    const label = $('.cv-name', card); if (!label) return;
    const input = document.createElement('input');
    input.className = 'cv-rename';
    input.value = g.name || (g.prompt || '').split('\n')[0] || '未命名作品';
    input.dataset.gid = g.id;
    label.replaceWith(input);
    input.focus(); input.select();
  }
  function onCanvasRenameKey(e) {
    if (!e.target.classList || !e.target.classList.contains('cv-rename')) return;
    if (e.key === 'Enter') { e.preventDefault(); commitRename(e.target); }
    else if (e.key === 'Escape') { e.target.dataset.done = '1'; renderCanvas(); }
  }
  function onCanvasRenameBlur(e) {
    if (e.target.classList && e.target.classList.contains('cv-rename')) commitRename(e.target);
  }
  async function commitRename(input) {
    if (input.dataset.done) return;
    input.dataset.done = '1';
    const name = (input.value || '').trim().slice(0, 80) || '未命名作品';
    const g = state.gallery.find(x => x.id === input.dataset.gid);
    if (g) {
      g.name = name;
      await post('/api/gallery/' + encodeURIComponent(g.id), { name }).catch(() => {});
    }
    renderCanvas();
  }

  /* 按当前横向 / 纵向间距重排并持久化；「▦ 整理」（带确认）与设置页「保存并同步」共用 */
  async function doArrangeCanvas() {
    // 瀑布流整理：所有作品从头整平重排（不保留旧列高），列间距 = 全局横向间距，
    // 列内上下间距 = 全局纵向间距
    colY = Array(CV_COLS).fill(CV.startY);
    for (const g of canvasItems()) {
      const c = shortestCol();
      g.x = CV.startX + c * colStep();
      g.y = colY[c];
      colY[c] = g.y + cardHeightFor(g) + cvGapY();
      g.scale = 1;
    }
    await Promise.all(canvasItems().map(g =>
      post('/api/gallery/' + encodeURIComponent(g.id),
        { x: Math.round(g.x), y: Math.round(g.y), scale: 1 }).catch(() => {})));
    renderCanvas();
    return fitCanvasToContent();
  }

  async function arrangeCanvas() {
    // 一键瀑布流：按全局设置的横向 / 纵向间距重排当前画布的全部作品，不做还原
    const z = await doArrangeCanvas();
    heroNotice(z ? '已按全局间距整理为瀑布流 · 横向 ' + cvGapX() + ' / 纵向 ' + cvGapY() + 'px · 缩放 ' + Math.round(z * 100) + '%'
            : '画布已整理');
  }

  /* 全局统一进度条：对话模式与自由画布共用（百分比） */
  function setCvProgress(text, pct) {
    const box = $('#globalProgress');
    if (!box) return;
    box.classList.remove('hidden');
    $('#gpText').textContent = text;
    $('#gpBar').style.width = Math.max(3, Math.min(100, pct || 0)) + '%';
  }
  function clearCvProgress() { const b = $('#globalProgress'); if (b) b.classList.add('hidden'); }

  async function onGenerated() {
    clearCvProgress();
    await syncGeneratedViews({ silent: true });
    heroNotice('生成完成，结果已就绪 · 可从右上角进入画布查看');
  }

  /* ---------------- 遮罩画布 ---------------- */
  const maskState = { canvas: null, mask: null, base: null, drawing: false, erase: false, last: null, img: null, name: null };
  function bindMaskModal() {
    $('#maskClose').addEventListener('click', () => $('#maskModal').classList.add('hidden'));
    $('#brushPaint').addEventListener('click', () => setBrush(false));
    $('#brushErase').addEventListener('click', () => setBrush(true));
    $('#brushClear').addEventListener('click', clearMask);
    $('#maskSave').addEventListener('click', saveMask);
    window.addEventListener('resize', () => {
      if (!$('#maskModal').classList.contains('hidden')) fitMaskCanvas();
    });
    const cv = $('#maskCanvas');
    cv.addEventListener('pointerdown', e => {
      maskState.drawing = true; cv.setPointerCapture(e.pointerId);
      maskState.last = pt(e); stroke(maskState.last, maskState.last);
    });
    cv.addEventListener('pointermove', e => { if (!maskState.drawing) return; const p = pt(e); stroke(maskState.last, p); maskState.last = p; });
    cv.addEventListener('pointerup', () => { maskState.drawing = false; maskState.last = null; });
    cv.addEventListener('pointercancel', () => { maskState.drawing = false; });
  }
  function setBrush(erase) {
    maskState.erase = erase;
    $('#brushPaint').classList.toggle('active', !erase);
    $('#brushErase').classList.toggle('active', erase);
  }
  function clearMask() {
    const m = maskState.mask.getContext('2d');
    m.clearRect(0, 0, maskState.mask.width, maskState.mask.height);
    composite();
  }
  function pt(e) {
    const r = maskState.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * maskState.canvas.width / r.width, y: (e.clientY - r.top) * maskState.canvas.height / r.height };
  }
  function stroke(a, b) {
    const ctx = maskState.mask.getContext('2d');
    const size = Number($('#brushSize').value) || 48;
    // 笔刷按「屏幕像素 → 画布像素」换算：大图画布按 CSS 缩小显示，笔画视觉粗细仍然一致
    const el = maskState.canvas;
    const rect = el.getBoundingClientRect();
    const k = rect.width ? el.width / rect.width : 1;
    const r = Math.max(1, size * k);
    ctx.save();
    ctx.globalCompositeOperation = maskState.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
    ctx.lineWidth = r * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); composite();
  }
  function composite() {
    const c = maskState.canvas.getContext('2d');
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.drawImage(maskState.base, 0, 0, c.canvas.width, c.canvas.height);
    c.save(); c.globalAlpha = .55; c.drawImage(maskState.mask, 0, 0); c.restore();
  }
  /* 画布显示尺寸：按可用空间等比缩放（不依赖 CSS 百分比，竖图/横图都不会被裁切） */
  function fitMaskCanvas() {
    const cv = maskState.canvas;
    if (!cv || !cv.width || !cv.height) return;
    const wrap = $('#maskModal .canvas-wrap');
    const availW = Math.max(240, (wrap ? wrap.clientWidth : window.innerWidth) - 32);
    const availH = Math.max(240, window.innerHeight * 0.6);
    const fit = Math.min(availW / cv.width, availH / cv.height, 1);
    cv.style.width = Math.round(cv.width * fit) + 'px';
    cv.style.height = Math.round(cv.height * fit) + 'px';
  }

  /* 打开遮罩弹窗：只服务主界面的手动局部重绘（AI 助手不提供局部重绘） */
  async function openMask() {
    const first = state.images[0];
    if (!first) return heroNotice('请先上传一张参考图，再绘制遮罩', 'error');
    $('#maskModal').classList.remove('hidden');
    $('#maskInfo').textContent = '图片加载中…';
    try {
      const img = new Image(); img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = first.url; });
      const ow = img.naturalWidth || 1024, oh = img.naturalHeight || 1024;
      // 画布必须与原图同尺寸（1:1）：遮罩会等比贴到 VAE latent 上，
      // 画布被缩放或取整会让涂抹区域和实际重绘区域错位，看起来「遮罩不管用」。
      const MAX = 6144;   // 超大图兜底，避免浏览器 canvas 爆内存
      const k = Math.min(1, MAX / Math.max(ow, oh));
      const w = Math.max(1, Math.round(ow * k)), h = Math.max(1, Math.round(oh * k));
      const cv = $('#maskCanvas'); cv.width = w; cv.height = h;
      const base = document.createElement('canvas'); base.width = w; base.height = h;
      base.getContext('2d').drawImage(img, 0, 0, w, h);
      const m = document.createElement('canvas'); m.width = w; m.height = h;
      maskState.canvas = cv; maskState.base = base; maskState.mask = m; maskState.img = img;
      maskState.name = first.name; setBrush(false); composite(); fitMaskCanvas();
      $('#maskInfo').textContent = k < 1
        ? `原图 ${ow}×${oh} 过大，画布按 ${Math.round(k * 100)}% 等比缩放（遮罩仍对齐）`
        : `画布 ${w}×${h} · 与原图 1:1 · 涂抹需要修改的区域`;
    } catch (e) { $('#maskInfo').textContent = '图片加载失败：' + e.message; }
  }
  async function saveMask() {
    if (!maskState.mask) return heroNotice('画布尚未就绪');
    // 遮罩按画布原始尺寸导出（与原图 1:1），交给 ComfyUI 自己等比缩放到 latent
    const out = document.createElement('canvas');
    out.width = maskState.canvas.width; out.height = maskState.canvas.height;
    const c = out.getContext('2d');
    c.fillStyle = '#000000'; c.fillRect(0, 0, out.width, out.height);
    c.drawImage(maskState.mask, 0, 0);
    const blob = await new Promise(res => out.toBlob(res, 'image/png'));
    const fd = new FormData(); fd.append('image', new File([blob], 'cyui_mask.png', { type: 'image/png' }));
    try {
      const r = await api('/api/upload', { method: 'POST', body: fd });
      state.mask = r.images[0].name;
      renderRefs(); updateComposer();
      $('#maskModal').classList.add('hidden');
      heroNotice('遮罩已保存，可以发送了');
    } catch (e) { heroNotice('遮罩上传失败：' + e.message, 'error'); }
  }

  /* ---------------- DeepSeek 悬浮助手 ---------------- */
  const AI_TOOL_LABELS = {
    list_skills: '查询技能', generate_images: '提交生成', upscale_image: '高清放大',
    get_workspace: '读取当前设置', set_workspace: '调整参数',
    polish_prompt: '润色提示词', reverse_prompt: '反推提示词',
    batch_process: '启动批量', batch_status: '查询批量', wait_batch: '等待批量完成',
    list_loras: '搜索 LoRA', list_gallery: '查看作品',
  };
  const AI_MODE_LABELS = { text2img: '文生图', img2img: '图生图', edit: '图片编辑', upscale: '高清放大', prompt: '提示词' };

  const AI_MSG_MAP_KEY = 'cyui_ai_msgs_map';
  const AI_HIST_SEL = new Set();
  let AI_IMG_META = {};   // url -> 完整作品信息（名称 / 尺寸 / 提示词 / 参数 / 技能 / 时间）
  let AI_MSG_MAP = {};    // 后端 session id -> 该会话里的 AI 助手消息

  /* 会话的唯一数据源是后端 state.sessions；本地只持久化「每个会话里的 AI 消息」。
     人工「最近对话」和助手「历史对话」因此是同一批会话：任意一侧新建 / 删除 /
     重命名 / 切换，另一侧看到的都是同一条记录。 */
  function aiCurrentChat() {
    return (state.sessions || []).find(s => s.id === state.ai.chatId) || null;
  }

  function aiLoadMsgs() {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(AI_MSG_MAP_KEY) || '{}') || {}; } catch (e) { map = {}; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
    const sessions = state.sessions || [];
    // 迁移旧版多会话 cyui_ai_chats：按标题或 id 挂到现有后端会话，匹配不到就挂当前会话
    try {
      const old = JSON.parse(localStorage.getItem('cyui_ai_chats') || '[]');
      if (Array.isArray(old)) old.forEach(c => {
        const hit = sessions.find(s => s.title === c.title);
        const sid = hit ? hit.id : (sessions.some(s => s.id === c.id) ? c.id : (state.sessionId || c.id));
        if (sid && !map[sid]) map[sid] = (c.messages || []).slice(-30);
      });
    } catch (e) { /* 忽略 */ }
    // 迁移更老的单会话 cyui_ai_msgs
    try {
      const one = JSON.parse(localStorage.getItem('cyui_ai_msgs') || '[]');
      if (Array.isArray(one) && one.length && state.sessionId && !map[state.sessionId]) {
        map[state.sessionId] = one.slice(-30);
      }
    } catch (e) { /* 忽略 */ }
    return map;
  }

  function aiSyncCurrent() {
    if (state.ai.chatId) AI_MSG_MAP[state.ai.chatId] = state.ai.messages.slice(-30);
  }

  function aiSaveChats() {
    try {
      aiSyncCurrent();
      localStorage.setItem(AI_MSG_MAP_KEY, JSON.stringify(AI_MSG_MAP));
    } catch (e) { /* 忽略 */ }
  }
  function aiSave() { aiSaveChats(); }   // 兼容原有调用点

  /* 人工侧会话变化后同步 AI 面板：切换当前会话、清理已删会话的消息、重绘列表与标题 */
  function aiOnSessionsChanged() {
    const ids = new Set((state.sessions || []).map(s => s.id));
    if (state.ai.chatId !== (state.sessionId || null)) {
      aiSyncCurrent();
      state.ai.chatId = state.sessionId || null;
      state.ai.messages = state.ai.chatId ? (AI_MSG_MAP[state.ai.chatId] || []).slice(-30) : [];
      state.ai.images = [];
    }
    Object.keys(AI_MSG_MAP).forEach(k => { if (!ids.has(k)) delete AI_MSG_MAP[k]; });
    aiSave();
    aiRenderHistory(); aiUpdateHeader(); aiRender(); aiRenderAttach();
    // 三模式通路：切会话后拉一次后端消息，人工侧的对话 / 生成结果在助手面板也能看到
    refreshSessionMessages();
  }

  async function aiNewChat(switchTo) {
    aiSyncCurrent();
    try {
      const r = await post('/api/sessions', { title: '新对话' });
      const s = r.session || {};
      if (!s.id) return null;
      await refreshSessions();
      state.sessionId = s.id; state.ai.chatId = s.id;
      persistSessionId(s.id);
      AI_MSG_MAP[s.id] = [];
      state.messages = [];
      state.ai.messages = []; state.ai.images = []; state.ai.busy = false;
      aiSave();
      if (switchTo !== false) aiShowView('chat');
      renderSessions(); aiRender(); aiRenderAttach(); aiRenderHistory(); aiUpdateHeader();
      heroNotice('已开始新对话');
      return { id: s.id, title: s.title };
    } catch (e) { heroNotice('新建对话失败：' + e.message, 'error'); return null; }
  }

  async function aiSwitchChat(id) {
    if (id === state.ai.chatId) { aiShowView('chat'); return; }
    aiSyncCurrent();
    state.sessionId = id; state.ai.chatId = id;
    persistSessionId(id);
    try {
      const d = await api('/api/sessions/' + encodeURIComponent(id));
      state.messages = (d.session || {}).messages || [];
    } catch (e) { state.messages = []; }
    state.ai.messages = (AI_MSG_MAP[id] || []).slice(-30);
    state.ai.images = []; state.ai.busy = false;
    await refreshSessions();
    aiSave(); aiShowView('chat');
    renderChat(); aiRender(); aiRenderAttach(); aiRenderHistory(); aiUpdateHeader();
  }

  async function aiDeleteChats(ids) {
    const arr = Array.from(new Set(ids || []));
    if (!arr.length) return;
    try {
      const r = await post('/api/sessions/batch-delete', { ids: arr });
      arr.forEach(id => delete AI_MSG_MAP[id]);
      AI_HIST_SEL.clear();
      await applyLinkedDeletion(r);     // 会话 / 图库 / 画布 + AI 面板一起刷新
      notifyDeleteFailed(r);
      aiSave(); aiRenderHistory(); aiRender(); aiRenderAttach(); aiUpdateHeader();
    } catch (e) { heroNotice('删除对话失败：' + e.message, 'error'); }
  }

  async function aiRenameChat(id, title) {
    const t = String(title || '').trim().slice(0, 40) || '新对话';
    try {
      await post('/api/sessions/' + encodeURIComponent(id) + '/rename', { title: t });
      await refreshSessions();
      aiRenderHistory(); aiUpdateHeader();
      if (state.view === 'chat') switchView('chat');
      if (state.view === 'canvas') renderCanvas();
    } catch (e) { heroNotice('重命名失败：' + e.message, 'error'); }
  }

  /* 聊天 / 历史对话两个视图 */
  function aiShowView(v) {
    state.ai.view = v;
    $('#aiChatView').classList.toggle('hidden', v !== 'chat');
    $('#aiHistoryView').classList.toggle('hidden', v !== 'history');
    $('#aiHistoryBtn').classList.toggle('active', v === 'history');
    aiUpdateHeader();
    if (v === 'history') {
      aiRenderHistory();
      // 人工侧可能在别的页面删过 / 改过会话，打开历史时先对账
      refreshSessions().then(() => aiOnSessionsChanged()).catch(() => {});
    } else { aiRender(); setTimeout(() => { const i = $('#aiInput'); if (i) i.focus(); }, 60); }
  }

  function aiUpdateHeader() {
    const c = aiCurrentChat();
    $('#aiTitle').textContent = state.ai.view === 'history' ? '历史对话'
      : (c && c.title && c.title !== '新对话' ? c.title : 'DeepSeek 助手');
    const st = $('#aiStatus');
    if (!st) return;
    const noKey = !state.params.deepseek_key;
    st.innerHTML = `<i class="ai-dot"></i> ${noKey ? '未配置 API Key' : esc(state.params.deepseek_model || 'deepseek-chat') + ' · 已就绪'}`;
    st.classList.toggle('ai-status-ok', !noKey);
  }

  function aiRenderHistory() {
    const list = $('#aiHistList'); if (!list) return;
    // 与人工「最近对话」同一个数据源：后端 sessions
    const items = (state.sessions || []).slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    $('#aiHistCount').textContent = items.length + ' 个对话';
    const when = (s) => {
      try {
        return new Date((s.updated_at || 0) * 1000 || Date.now())
          .toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (e) { return ''; }
    };
    list.innerHTML = items.length ? items.map(s => `<div class="ai-hist-item ${s.id === state.ai.chatId ? 'active' : ''} ${AI_HIST_SEL.has(s.id) ? 'picked' : ''}" data-ai-chat="${esc(s.id)}">
        <input type="checkbox" data-ai-check="${esc(s.id)}" ${AI_HIST_SEL.has(s.id) ? 'checked' : ''} title="选择">
        <div class="ai-hist-main" data-ai-open="${esc(s.id)}" title="点击切换到这个对话">
          <b>${esc(s.title || '新对话')}</b>
          <small>${(AI_MSG_MAP[s.id] || []).length} 条 AI 消息 · ${esc(when(s))}</small>
        </div>
        <div class="ai-hist-acts">
          <button data-ai-rename="${esc(s.id)}" title="重命名">✎</button>
          <button data-ai-del="${esc(s.id)}" title="删除">×</button>
        </div>
      </div>`).join('') : '<div class="ai-hist-empty">还没有对话，点右上角「＋ 新建对话」开始</div>';
    aiUpdateHistSel();
  }

  function aiUpdateHistSel() {
    const items = state.sessions || [];
    $('#aiHistSel').textContent = '已选 ' + AI_HIST_SEL.size + ' 个';
    const all = $('#aiHistAll');
    if (all) all.checked = !!items.length && items.every(c => AI_HIST_SEL.has(c.id));
  }

  function aiStartRename(id, item) {
    const main = $('.ai-hist-main', item); if (!main) return;
    const c = (state.sessions || []).find(x => x.id === id); if (!c) return;
    const input = document.createElement('input');
    input.className = 'ai-hist-rename';
    input.value = c.title || '新对话';
    main.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const commit = () => { if (done) return; done = true; aiRenameChat(id, input.value); };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { done = true; aiRenderHistory(); }
    });
    input.addEventListener('blur', commit);
  }

  function renderAssistantSkills() {
    const el = $('#assistantSkills'); if (!el) return;
    const list = state.assistantSkills || [];
    el.innerHTML = list.map(s => `<div class="ai-skill-card">
        <span class="asc-cat">${esc(s.cat)}</span>
        <b>${esc(s.name)}</b>
        <p>${esc(s.desc)}</p>
        <em>${esc(AI_MODE_LABELS[s.mode] || s.mode)}${s.images ? ' · 需 ' + s.images + ' 张图' : ''}</em>
      </div>`).join('') || '<div class="help-muted">暂无助手技能</div>';
  }

  /* 助手里的图片统一渲染成缩略块：点图片看大图+信息，点 ⋯ 打开与对话/画布相同的图片菜单，
     也可以直接拖到下方输入框，作为下一步处理的输入图 */
  function aiImgHTML(im, fallbackName) {
    const o = (typeof im === 'string') ? { url: im } : (im || {});
    if (!o.url) return '';
    const w = Number(o.width) || 0, h = Number(o.height) || 0;
    const name = o.name || fallbackName || '图片';
    // 高度按原图比例算（限幅），竖图不会被压成细条，横图也不会被裁掉
    const boxH = (w && h) ? Math.max(96, Math.min(210, Math.round(132 * h / w))) : 132;
    return `<figure class="ai-img" style="height:${boxH}px" draggable="true"
        data-ai-img="${esc(o.url)}" data-ai-name="${esc(name)}" data-ai-w="${w}" data-ai-h="${h}"
        data-ai-input="${esc(o.input_name || '')}" title="点击查看大图与作品信息，也可拖到输入框继续处理">
        <img src="${esc(o.url)}" alt="${esc(name)}" loading="lazy" draggable="false">
        <span class="ai-img-cap">${esc(w && h ? w + '×' + h : '查看大图')}</span>
        <button class="ai-img-more" data-ai-more="1" title="图片操作菜单">⋯</button>
      </figure>`;
  }

  /* 每次渲染时把消息里所有图片的完整元数据按 url 建索引，点击时不依赖图库是否已刷新 */
  function aiIndexImages() {
    AI_IMG_META = {};
    (state.ai.messages || []).forEach(m => (m.images || []).forEach(im => {
      const o = (typeof im === 'string') ? { url: im } : (im || {});
      if (o.url) AI_IMG_META[o.url] = o;
    }));
  }

  /* 与对话模式 / 画布一致：名称、尺寸、正负面提示词、参数、技能、时间都要带全 */
  function aiImgInfo(el) {
    const url = el.dataset.aiImg || '';
    const img = el.querySelector('img');
    const meta = AI_IMG_META[url] || {};
    const g = state.gallery.find(x => x.url === url) || {};
    const mp = meta.params || {};
    return {
      url,
      name: meta.name || g.name || el.dataset.aiName || '助手图片',
      width: Number(meta.width) || Number(el.dataset.aiW) || (img && img.naturalWidth) || Number(g.width) || 0,
      height: Number(meta.height) || Number(el.dataset.aiH) || (img && img.naturalHeight) || Number(g.height) || 0,
      prompt: meta.prompt || g.prompt || '',
      params: Object.keys(mp).length ? mp : (g.params || {}),
      skill: meta.skill || g.skill || '',
      ts: meta.ts || g.ts || 0,
      session_id: meta.session_id || g.session_id || '',
      prompt_id: meta.prompt_id || g.prompt_id || '',
      input_name: meta.input_name || '',
    };
  }

  /* 步骤卡里的工具名：查看作品 → 大图；提交生成 / 放大 / 批量 → 队列进度弹窗 */
  const AI_CLICKABLE_TOOLS = ['list_gallery', 'generate_images', 'upscale_image', 'batch_process', 'batch_status'];
  function aiStepLabelHTML(t, ti) {
    if (t.running) return `<b class="ai-step-link static">${esc(t.label)}</b>`;
    if (!AI_CLICKABLE_TOOLS.includes(t.tool || '')) {
      return `<b class="ai-step-link static">${esc(t.label)}</b>`;
    }
    const tip = t.tool === 'list_gallery' ? '点击看作品大图' : '点击查看队列进度';
    return `<button class="ai-step-link" data-ai-step="${ti}" title="${tip}">${esc(t.label)}</button>`;
  }

  /* ---------------- 三模式共用一条对话通路 ----------------
     会话消息的唯一数据源是后端 state.sessions；AI 面板 = 后端会话消息 + 本地 AI 专属消息
     （工具步骤 / 批量进度）按时间合并。人工在对话模式发的消息、生成的图，DeepSeek
     面板能看到；DeepSeek 的回复也写回后端会话，对话模式同样能看到。 */
  function aiMergedMessages() {
    const local = state.ai.messages || [];
    const mids = new Set(local.map(m => m.mid).filter(Boolean));
    const back = (state.messages || [])
      .filter(m => !mids.has(m.id))
      .filter(m => m.role === 'user' || m.role === 'assistant')
      // pending 且无图无文（生成骨架）不进助手面板；错误空消息也不进
      .filter(m => !(m.role === 'assistant' && !m.content && !(m.images || []).length));
    const mapped = back.map(m => ({
      role: m.role, content: m.content || '',
      images: (m.images || []).map(i => (typeof i === 'string' ? { url: i } : i)),
      names: (m.images || []).map(i => (i && i.name) || ''),
      ts: m.ts || 0, backend: true,
    }));
    const all = local.map(m => ({ ...m, ts: m.ts || 0 })).concat(mapped);
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return all;
  }

  /* 拉当前会话的完整消息（对话模式与 AI 面板共用），拉完各自重绘 */
  async function refreshSessionMessages() {
    const sid = state.sessionId; if (!sid) return;
    try {
      const r = await api('/api/sessions/' + encodeURIComponent(sid));
      if (r.session) {
        state.messages = r.session.messages;
        // 单条输入通路：后端用户消息被升级为优化后的完整提示词时，同步本地副本内容
        (state.ai.messages || []).forEach(m => {
          if (!m.mid) return;
          const bm = (state.messages || []).find(x => x.id === m.mid);
          if (bm && bm.content) m.content = bm.content;
        });
        if (state.view === 'chat') renderChat();
        if ($('#aiBody')) aiRender();
      }
    } catch (e) { /* 静默 */ }
  }

  function aiRender() {
    const body = $('#aiBody'); if (!body) return;
    aiIndexImages();
    aiUpdateHeader();
    const noKey = !state.params.deepseek_key;
    const tip = noKey ? `<div class="ai-msg ai-bot error">还没有配置 DeepSeek Key。请到「全局设置 → 提示词润色 / 反推」填写 API Key 后再使用助手。
      <div class="btn-row" style="margin-top:8px"><button class="ghost-btn" data-ai-settings>去填写</button></div></div>` : '';
    const merged = aiMergedMessages();
    const welcome = (!merged.length && !state.ai.busy)
      ? `<div class="ai-msg ai-bot">你好，我是 DeepSeek 助手。可以直接说：
· 做一张电商白底图（先上传商品图）
· 把这张图换成胶片风 / 换装 / 抠图
· 给 D://素材//待处理 文件夹批量抠图
· 生成一张赛博朋克城市海报</div>` : '';
    const msgs = merged.map(m => {
      if (m.role === 'user') {
        const imgs = (m.images || []).length
          ? `<div class="ai-imgs">${m.images.map((u, i) => aiImgHTML(u, (m.names || [])[i] || '参考图')).join('')}</div>` : '';
        return `<div class="ai-msg ai-user">${esc(m.content)}${imgs}</div>`;
      }
      const imgs = (m.images || []).length
        ? `<div class="ai-imgs">${m.images.map(i => aiImgHTML(i, '生成结果')).join('')}</div>` : '';
      const running = (m.tools || []).some(t => t.running);
      const tools = (m.tools || []).length
        ? `<div class="ai-steps"><b>${m.pending ? (running ? '正在执行' : '思考中') : '已完成'} ${m.tools.length} 步</b>${m.tools.map((t, ti) =>
            `<div class="ai-step${t.running ? ' running' : ''}"><i>${t.running ? '⟳' : '⚙'}</i><span>${aiStepLabelHTML(t, ti)} · ${esc(t.detail)}</span></div>`).join('')}</div>` : '';
      const batch = m.batch ? `<div class="ai-steps"><b>批量任务</b><div class="ai-step"><i>📦</i><span>${m.batch.done}/${m.batch.total} · ${m.batch.status === 'done' ? '已完成' : '处理中'}</span></div></div>` : '';
      return `<div class="ai-msg ai-bot${m.error ? ' error' : ''}">${esc(m.content)}${imgs}${tools}${batch}</div>`;
    }).join('');
    const typing = state.ai.busy ? `<div class="ai-typing"><i>●</i> 助手正在思考 / 调用工具…（可点 ■ 停止）</div>` : '';
    body.innerHTML = tip + welcome + msgs + typing;
    body.scrollTop = body.scrollHeight;
    // 忙碌时发送键变成停止键
    const sendBtn = $('#aiSend');
    if (sendBtn) {
      sendBtn.classList.toggle('stop', !!state.ai.busy);
      sendBtn.textContent = state.ai.busy ? '■' : '↑';
      sendBtn.title = state.ai.busy ? '停止生成' : '发送';
    }
  }

  /* DeepSeek 上下文：用合并后的完整对话（含人工侧手动生成的消息），保持 AI 对全局有感知 */
  function aiMessagesPayload() {
    return aiMergedMessages().map(m => {
      let content = m.content || '';
      const names = (m.names && m.names.length ? m.names
        : (m.images || []).map(i => (i && i.name) || '')).filter(Boolean);
      if (m.role === 'user' && names.length) {
        content += '\n[图片:' + names.join(',') + ']';
      }
      return { role: m.role, content };
    }).filter(m => (m.content || '').trim());
  }

  /* ---- 工作台快照 / AI 改参数 ----
     助手要能「按我现在的设置出图」和「帮我改设置」，所以每次请求都把
     技能 / 尺寸 / 参数 / LoRA / 润色 / 当前视图原样上报；
     返回的 ui 动作再原样落回界面（set_workspace 的返回值里带着）。 */
  function aiWorkspaceSnapshot() {
    const p = state.params || {};
    const sk = state.skillMap[state.mode] || {};
    return {
      view: state.view || '',
      skill: state.mode || '',
      skill_name: sk.name || '',
      draft: String(state.draft || '').slice(0, 200),
      images: (state.images || []).map(i => (i && i.name) || '').filter(Boolean),
      loras: aiLorasPayload(),
      params: {
        sampling: p.sampling || 'turbo', steps: Number(p.steps) || 0, cfg: Number(p.cfg) || 0,
        sampler: p.sampler || '', scheduler: p.scheduler || '',
        denoise: Number(p.denoise) || 1, seed: Number(p.seed),
        batch: Number(p.batch) || 1, max_images: Number(p.max_images) || 0,
        resolution: Number(p.resolution) || 0,
        width: Number(p.width) || 1024, height: Number(p.height) || 1024,
        size_mode: p.size_mode || 'auto', ratio: p.ratio || '', res_level: p.res_level || '',
        negative: String(p.negative || ''),
        unet: p.unet || '', clip: p.clip || '', vae: p.vae || '',
        cache_device: p.cache_device || 'auto', cache_dtype: p.cache_dtype || 'default',
        polish: !!p.polish,
      },
    };
  }

  /* AI 改界面参数：后端已经把范围收敛 + 方案联动都做完了，这里照抄到界面并重绘。
     技能先切（setMode 会带技能的 denoise），参数后写，避免互相覆盖。 */
  function aiApplyUiAction(ui) {
    if (!ui || ui.action !== 'apply_params') return false;
    const p = ui.params || {};
    let changed = 0;
    if (ui.skill_id && state.skillMap[ui.skill_id] && state.mode !== ui.skill_id) {
      state.mode = ui.skill_id;
      const sk = skill();
      if (sk && !sk.needs_mask) state.mask = null;
      if (state.images.length > cap()) state.images = state.images.slice(0, cap());
      changed++;
    }
    Object.keys(p).forEach(k => {
      if (state.params[k] === p[k]) return;
      state.params[k] = p[k]; changed++;
    });
    // 尺寸三态与「自定义画布」开关始终同步，否则圆点与像素会各说各话
    if ('width' in p || 'height' in p || 'size_mode' in p) {
      state.params.custom_size = (state.params.size_mode || 'auto') === 'fixed';
    }
    try { persistParams(); } catch (e) { /* 存不下也不影响本次 */ }
    // 抽屉控件 / 采样卡片 / 尺寸摘要 / LoRA 列表 / 输入区标签全部按新值重绘
    if (typeof fillParams === 'function') fillParams(); else renderParamPanel();
    renderSkillNav(); renderParamPanel(); updateComposer();
    if (state.view === 'canvas' && typeof renderCanvas === 'function') renderCanvas();
    if (ui.view && ui.view !== state.view && $('#view' + ui.view[0].toUpperCase() + ui.view.slice(1))) {
      switchView(ui.view);
    }
    if (changed && ui.note) heroNotice(ui.note);
    return true;
  }

  function aiToolDetail(ev) {
    const r = ev.result || {};
    if (r.error) return '失败：' + String(r.error).slice(0, 80);
    // set_workspace：直接把「改了什么」显示出来，用户不用翻抽屉确认
    if (r.ui && r.ui.action === 'apply_params') return String(r.note || '界面参数已更新').slice(0, 96);
    if (r.current && r.limits) return '已读取当前设置';
    if (r.job_id) {
      if (r.duplicate) return '已提交过，跳过重复提交 · #' + String(r.job_id).slice(0, 8);
      // 把实际模式 / 画布 / 张数 / LoRA 显示出来，用户一眼能确认「1 张、什么尺寸、什么模式」
      const bits = [r.skill || AI_MODE_LABELS[r.mode] || '', r.size || '',
        Number(r.count) > 1 ? '共 ' + r.count + ' 张' : ''].filter(Boolean).join(' · ');
      const loraBit = (r.loras && r.loras.length) ? ' · LoRA×' + r.loras.length : '';
      // 加速 LoRA 被剔除时说清楚，别让用户以为挂了却没生效
      const dropBit = (r.dropped_loras && r.dropped_loras.length) ? ' · 已忽略加速 LoRA' : '';
      // 实际用的那套参数（步数 / CFG / 采样方案）：用户能一眼看到「AI 真的按我的设置跑了」
      const pu = r.params_used || {};
      const paramBit = (pu.steps != null)
        ? ' · ' + (pu.sampling || 'turbo') + ' ' + pu.steps + '步/CFG' + pu.cfg : '';
      return '已提交' + (bits ? ' · ' + bits : '') + loraBit + paramBit + dropBit + ' #' + String(r.job_id).slice(0, 8);
    }
    if (r.batch_id) return '批量 ' + (r.total || 0) + ' 张 · ' + r.batch_id;
    if (r.skills) return (r.skills.length || 0) + ' 个技能';
    if (r.polished) return String(r.polished).slice(0, 46) + '…';
    if (r.prompt) return String(r.prompt).slice(0, 46) + '…';
    if (r.items) return (r.items.length || 0) + ' 件作品';
    return '完成';
  }

  /* AI 助手与人工「最近对话」打通：把本次生成用的会话 id 认领为当前对话 */
  async function aiAdoptSession(events) {
    const sid = (events || []).map(e => (e.result || {}).session_id).find(Boolean);
    if (!sid) return;
    if (!state.sessionId) {
      aiSyncCurrent();
      state.sessionId = sid;
      state.ai.chatId = sid;
      persistSessionId(sid);
      AI_MSG_MAP[sid] = state.ai.messages.slice(-30);
      aiSave();
    }
    await refreshSessions().then(() => aiOnSessionsChanged()).catch(() => {});
  }

  /* 停止当前 AI 思考 / 工具执行：先请求服务端截断（能收到 stopped 事件、
     wait_batch 等长任务也会提前退出），服务端不可达时再直接断开流 */
  async function aiStop() {
    if (!state.ai.busy) return;
    const bot = [...state.ai.messages].reverse().find(m => m.role === 'assistant' && m.pending);
    const sid = bot && bot.streamId;
    if (sid) {
      try { await post('/api/assistant/stop', { stream_id: sid }); return; } catch (e) { /* 落到断开 */ }
    }
    if (state.ai.ctrl) { try { state.ai.ctrl.abort(); } catch (e) {} }
    heroNotice('已请求停止');
  }

  /* 流式发送：SSE 逐事件渲染（DeepSeek 风格步骤卡），
     每步完成即启动任务跟踪，不再等整轮对话结束。
     三模式共用一条会话通路：用户输入与最终回复都写进后端会话。 */
  async function aiSend() {
    const input = $('#aiInput');
    const text = (input.value || '').trim();
    if (state.ai.busy) return;
    if (!text) return heroNotice('先说说你想做什么', 'warn');
    if (!state.params.deepseek_key) { heroNotice('请先在全局设置填写 DeepSeek API Key', 'error'); return; }
    const names = state.ai.images.map(i => i.name);
    // 上传图也存成完整对象，点开大图时才有名称与尺寸
    const attached = state.ai.images.map(i => ({
      url: i.url, name: i.name, width: Number(i.width) || 0, height: Number(i.height) || 0,
    }));
    state.ai.images = [];
    input.value = ''; input.style.height = 'auto';
    state.ai.busy = true;
    aiRender(); aiRenderAttach();

    // 三模式通路：没有会话就先建一条，再把用户消息写进后端（对话模式立即可见）
    let sid = state.sessionId || '';
    if (!sid) {
      try {
        const r = await post('/api/sessions', { title: (text.slice(0, 20) || '新对话') });
        sid = (r.session || {}).id || '';
        if (sid) {
          state.sessionId = sid; state.ai.chatId = sid;
          persistSessionId(sid);
          AI_MSG_MAP[sid] = [];
          await refreshSessions().catch(() => {});
        }
      } catch (e) { /* 会话创建失败也不阻断对话 */ }
    }
    let userMid = '';
    if (sid) {
      try {
        const r = await post('/api/sessions/' + encodeURIComponent(sid) + '/messages', {
          role: 'user', content: text, source: 'ai',
          images: attached,
        });
        userMid = (r.message || {}).id || '';
      } catch (e) { /* 本地仍然显示 */ }
      refreshSessionMessages();
    }
    const localUser = { role: 'user', content: text, names, images: attached, mid: userMid, ts: Date.now() / 1000 };
    state.ai.messages.push(localUser);
    const bot = { role: 'assistant', content: '', tools: [], pending: true, ts: Date.now() / 1000 };
    state.ai.messages.push(bot);
    aiRender(); aiSave();

    const ctrl = new AbortController();
    state.ai.ctrl = ctrl;
    let streamDone = false;
    const finish = () => {
      if (streamDone) return;
      streamDone = true;
      bot.pending = false;
      state.ai.busy = false;
      state.ai.ctrl = null;
      aiRender(); aiSave();
    };
    const markStopped = (steps) => {
      if (bot.stopped) return;
      bot.stopped = true;
      bot.content = (bot.content ? bot.content + '\n' : '') +
        '（已停止' + (steps ? '，已完成 ' + steps + ' 步' : '') + '）';
      (bot.tools || []).forEach(t => { t.running = false; });
      finish();
      // 三模式通路：截断后的部分回复同样写进后端会话
      const useSid = sid || state.sessionId || '';
      if (useSid && (bot.content || '').trim()) {
        post('/api/sessions/' + encodeURIComponent(useSid) + '/messages', {
          role: 'assistant', content: bot.content, source: 'ai', status: 'done', images: [],
        }).then(r => { bot.mid = (r.message || {}).id || ''; aiSave(); }).catch(() => {});
        refreshSessionMessages();
      }
    };
    try {
      const resp = await fetch('/api/assistant/chat_stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: aiMessagesPayload(),
          api_key: state.params.deepseek_key,
          model: state.params.deepseek_model || 'deepseek-chat',
          session_id: sid || state.sessionId || '',
          max_steps: 8,
          // 用户手选的 LoRA（每轮强制带上）+ 当前采样方案（决定加速 LoRA 是否可用）
          loras: aiLorasPayload(),
          sampling: state.params.sampling || '',
          // 整份工作台状态：技能 / 尺寸 / 参数 / 润色开关，助手据此「按我的设置来」
          workspace: aiWorkspaceSnapshot(),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        let msg = '服务返回 ' + resp.status;
        try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = raw.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === 'start') {
            bot.streamId = ev.stream_id;
          } else if (ev.type === 'step_start') {
            bot.tools.push({
              label: AI_TOOL_LABELS[ev.tool] || ev.tool || '处理中',
              tool: ev.tool || '', detail: '执行中…', running: true,
            });
            aiRender();
          } else if (ev.type === 'step_result') {
            const t = bot.tools[Number(ev.i) || 0] || bot.tools[bot.tools.length - 1];
            const res = ev.result || {};
            if (t) {
              t.running = false;
              t.detail = aiToolDetail(ev);
              t.result = {
                job_id: res.job_id || '', batch_id: res.batch_id || '',
                input_name: res.input_name || '',
                items: Array.isArray(res.items) ? res.items.slice(0, 8) : [],
              };
            }
            // set_workspace 会把「改哪些参数」放在 ui 里带回来，收到就立刻落地到界面
            if (res.ui) aiApplyUiAction(res.ui);
            // 每步完成即启动结果跟踪：生成任务 / 批量进度立刻开始轮询
            aiWatch([ev], bot);
            aiRender();
          } else if (ev.type === 'reply') {
            bot.content = ev.text || bot.content;
            aiRender();
          } else if (ev.type === 'stopped') {
            markStopped(ev.steps || 0);
          } else if (ev.type === 'error') {
            bot.content = '出错了：' + (ev.error || '未知错误');
            bot.error = true;
            aiRender();
          } else if (ev.type === 'done') {
            // 三模式通路：最终回复写进后端会话，对话模式立即可见同一条 AI 回复
            const useSid = sid || state.sessionId || '';
            if (useSid && ((bot.content || '').trim() || (bot.images || []).length)) {
              try {
                // 生成结果由后端 generation 消息承载，这里只补文字；
                // 同一张图重复挂到回复消息上，对话页就会看到两份
                const back = aiBackendUrls();
                const extra = (bot.images || []).filter(i => i.url && !back.has(i.url));
                const r = await post('/api/sessions/' + encodeURIComponent(useSid) + '/messages', {
                  role: 'assistant', content: bot.content, source: 'ai', status: 'done',
                  images: extra.map(i => ({
                    name: i.name || '', url: i.url, width: Number(i.width) || 0, height: Number(i.height) || 0,
                  })),
                });
                bot.mid = (r.message || {}).id || '';
              } catch (e) { /* 后端写失败只影响对话页显示 */ }
              await refreshSessions().catch(() => {});
              await refreshSessionMessages();
            }
            if (Array.isArray(ev.events)) await aiAdoptSession(ev.events);
            finish();
          }
          if (streamDone) break;
        }
        if (streamDone) break;
        if (done) break;
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        markStopped(bot.tools ? bot.tools.filter(t => !t.running).length : 0);
      } else if (!bot.content && !(bot.tools || []).length) {
        bot.content = '出错了：' + e.message;
        bot.error = true;
      }
    }
    finish();
  }

  function aiWatch(events, msg) {
    for (const ev of (events || [])) {
      const r = ev.result || {};
      if (r.job_id) aiPollJob(r.job_id, msg);
      else if (r.batch_id) aiPollBatch(r.batch_id, msg);
    }
  }

  /* 后端会话消息里已有的图片 url：用来避免同一张图在助手面板被贴两遍
     （后端生成消息已承载结果，本地消息再贴一次 = 一张图变成两张） */
  function aiBackendUrls() {
    const s = new Set();
    (state.messages || []).forEach(m => (m.images || []).forEach(i => {
      const u = (typeof i === 'string') ? i : (i && i.url);
      if (u) s.add(u);
    }));
    return s;
  }

  async function aiPollJob(pid, msg) {
    const t0 = Date.now();
    while (Date.now() - t0 < 15 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r = await api('/api/job/' + pid);
        const j = r.job || {};
        if (j.status === 'done') {
          // 保留后端返回的完整作品信息：每张图都有名称 / 尺寸 / 提示词 / 参数 / 技能 / 时间
          const imgs = (j.results || []).map(i => ({
            url: i.url, width: i.width, height: i.height,
            name: i.name || '', prompt: i.prompt || '', params: i.params || {},
            skill: i.skill || '', ts: i.ts || 0,
            session_id: i.session_id || '', prompt_id: i.prompt_id || '',
            input_name: i.input_name || '',
          }));
          // 把结果图的 input 文件名写进助手消息：下一轮 DeepSeek 就能直接把它当输入图
          const usable = imgs.map(x => x.input_name).filter(Boolean);
          if (usable.length) msg.content += '\n[结果图可继续作为输入图：' + usable.join('、') + ']';
          await aiAdoptSession([{ result: { session_id: (j.meta || {}).session_id || '' } }]);
          await syncGeneratedViews();     // 先把后端生成消息拉回来
          // 后端那条生成消息已经带图时，本地不再重复贴——否则一张图会显示成两张
          if (!msg.mid) {
            const back = aiBackendUrls();
            const fresh = imgs.filter(i => i.url && !back.has(i.url));
            if (fresh.length) msg.images = (msg.images || []).concat(fresh);
          }
          aiRender(); aiSave();
          return;
        }
        if (j.status === 'error') {
          msg.content += '\n（任务失败：' + (j.error || '未知错误') + '）';
          aiRender(); aiSave();
          return;
        }
      } catch (e) { /* 继续等 */ }
    }
    msg.content += '\n（等待超时，可到对话页查看结果）';
    aiRender();
  }

  async function aiPollBatch(bid, msg) {
    while (true) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const r = await api('/api/assistant/batch/' + bid);
        // 批量任务归属当前会话：结果带 session_id，画布按会话过滤才能显示
        if (r.session_id) await aiAdoptSession([{ result: { session_id: r.session_id } }]);
        const prevDone = msg.batch ? msg.batch.done : 0;
        msg.batch = { done: r.done, total: r.total, status: r.status };
        // 每完成一张就同步一次，批量过程中对话与画布也能逐张看到结果
        if (r.done > prevDone) syncGeneratedViews({ silent: true });
        if (r.status === 'done') {
          msg.content += '\n批量完成：成功 ' + r.done + ' 张' + (r.failed ? '，失败 ' + r.failed + ' 张' : '') + '。';
          await syncGeneratedViews();     // 批量结果即时落到对话 / 画布 / 助手
          // 批量结果不再截断到 8 张，也不再退化成纯 url 字符串；
          // 后端生成消息已带图的跳过，避免同一张图显示两次
          if (!msg.mid) {
            const back = aiBackendUrls();
            const fresh = (r.results || []).map(u => (typeof u === 'string') ? { url: u } : (u || {}))
              .filter(i => i.url && !back.has(i.url));
            if (fresh.length) msg.images = (msg.images || []).concat(fresh);
          }
          aiRender(); aiSave();
          return;
        }
        aiRender();
      } catch (e) { /* 继续等 */ }
    }
  }

  function aiRenderAttach() {
    const row = $('#aiAttachRow'); if (!row) return;
    row.classList.toggle('hidden', !state.ai.images.length);
    row.innerHTML = state.ai.images.map((im, i) => {
      const w = Number(im.width) || 0, h = Number(im.height) || 0;
      return `<div class="ai-attach-card" data-ai-preview="${esc(im.url)}" data-ai-name="${esc(im.name)}"
          data-ai-w="${w}" data-ai-h="${h}" title="点击查看大图">
          <img src="${esc(im.url)}" alt="${esc(im.name)}">
          <div class="ai-attach-meta"><b>${esc(im.name)}</b><small>${w && h ? w + '×' + h : '参考图'}</small></div>
          <button class="ai-attach-x" data-ai-remove="${i}" title="移除">×</button>
        </div>`;
    }).join('');
  }

  async function aiAttachFiles(files) {
    const list = Array.from(files || []).slice(0, 3 - state.ai.images.length);
    if (!list.length) return heroNotice('最多同时带 3 张图', 'warn');
    for (const f of list) {
      const fd = new FormData(); fd.append('image', f);
      try {
        const r = await api('/api/upload', { method: 'POST', body: fd });
        const im = (r.images || [])[0];
        if (im) state.ai.images.push({
          name: im.name, url: im.url,
          width: Number(im.width) || 0, height: Number(im.height) || 0,
        });
      } catch (e) { heroNotice('上传失败：' + e.message, 'error'); }
    }
    aiRenderAttach();
  }

  /* ---------------- 助手的 LoRA 手选面板 ----------------
     两条通路并存：
     1) 用户在这里勾选 → 每条指令都随请求带给后端（_CTX_USER_LORAS），AI 不能擅自删掉
     2) AI 自己按提示词调 list_loras 搜（用户没勾时才自由发挥，勾了就只做补充）
     面板里的清单与 AI 搜索共用 /api/assistant/loras 同一份数据。 */
  const AI_LORA_KEY = 'cyui_ai_loras';
  const AI_LORA_MAX = 5;

  function aiLoraLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem(AI_LORA_KEY) || '[]');
      const list = Array.isArray(raw) ? raw : [];
      state.ai.loras = list.map(x => (typeof x === 'string')
        ? { name: x, strength: 1.0 }
        : { name: String((x && x.name) || ''), strength: Number((x && x.strength)) || 1.0 })
        .filter(x => x.name).slice(0, AI_LORA_MAX);
    } catch (e) { state.ai.loras = []; }
  }
  function aiLoraSave() {
    try { localStorage.setItem(AI_LORA_KEY, JSON.stringify(state.ai.loras)); } catch (e) { /* 忽略 */ }
  }
  /* 发给后端的结构：[{name, strength}] */
  function aiLorasPayload() {
    return state.ai.loras.map(l => ({ name: l.name, strength: Number(l.strength) || 1.0 }));
  }
  function aiLoraIsAccel(name) {
    const low = String(name || '').toLowerCase();
    const hints = state.ai.accelHint || [];
    return hints.some(h => low.includes(String(h).toLowerCase()));
  }
  /* 按钮角标 + 面板计数：有选中才亮 */
  function aiLoraSyncBtn() {
    const n = state.ai.loras.length;
    const cnt = $('#aiLoraCount'); if (cnt) cnt.textContent = String(n);
    const btn = $('#aiLora'); if (btn) btn.classList.toggle('has', n > 0);
    const c = $('#ailCount'); if (c) c.textContent = '已选 ' + n + ' / ' + AI_LORA_MAX;
    // 勾了加速 LoRA 但当前不是 Viggle 方案 → 提前说清楚它会被忽略，别让用户以为生效了
    const tip = $('#ailTip');
    if (tip) {
      const accelOn = state.ai.loras.some(l => aiLoraIsAccel(l.name));
      // 采样方案以选择框的当前值为准：state.params 要等到保存参数才更新，会读到旧值
      const samp = ($('#p_sampling') || {}).value || (state.params || {}).sampling || 'turbo';
      tip.textContent = (accelOn && samp !== 'viggle')
        ? '加速 LoRA 仅 Viggle 生效，本次忽略'
        : '勾选后每轮都带上';
      tip.style.color = (accelOn && samp !== 'viggle') ? '#d6913a' : '';
    }
  }

  async function aiLoraLoadPool(force) {
    if (!force && (state.ai.loraPool || []).length) return;
    try {
      const r = await api('/api/assistant/loras?limit=999');
      state.ai.loraPool = Array.isArray(r.items) ? r.items : [];
      state.ai.accelHint = Array.isArray(r.accel_hint) ? r.accel_hint : [];
      state.ai.loraTotal = Number(r.total) || state.ai.loraPool.length;
    } catch (e) {
      state.ai.loraPool = [];
      heroNotice('LoRA 清单读取失败：' + e.message, 'error');
    }
    // 接口挂了也尽量有东西可选：退回 catalog 里的 LoRA 名称（没有用途标签）
    if (!state.ai.loraPool.length) {
      const names = (state.catalog || {}).loras || [];
      if (names.length) {
        state.ai.loraPool = names.map(n => ({ name: n, hint: '' }));
        state.ai.loraTotal = names.length;
      }
    }
  }

  /* 与后端 search_loras 一致：多关键词任一命中，名称与用途标签都参与匹配 */
  function aiLoraHit(it, q) {
    if (!q) return true;
    const words = q.toLowerCase().split(/[\s,，、;；+/]+/).filter(Boolean);
    if (!words.length) return true;
    const hay = (String(it.name || '') + ' ' + String(it.hint || '')).toLowerCase();
    return words.some(w => hay.includes(w));
  }

  function renderAiLoraList() {
    const box = $('#ailList'); if (!box) return;
    const q = (($('#ailSearch') || {}).value || '').trim();
    const picked = new Map(state.ai.loras.map(l => [l.name, l]));
    const pool = state.ai.loraPool || [];
    let items = pool.filter(it => aiLoraHit(it, q));
    // 已选但被搜索过滤掉的也要留在列表里，否则用户没法取消
    if (q) {
      const names = new Set(items.map(it => it.name));
      state.ai.loras.forEach(l => {
        if (names.has(l.name)) return;
        const meta = pool.find(it => it.name === l.name);
        items.unshift(meta || { name: l.name, hint: '' });
      });
    }
    // 已选排前面，其余按名称排，加速 LoRA 沉底（它不是常规创作 LoRA）
    items.sort((a, b) => {
      const pa = picked.has(a.name) ? 0 : 1, pb = picked.has(b.name) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const aa = aiLoraIsAccel(a.name) ? 1 : 0, ab = aiLoraIsAccel(b.name) ? 1 : 0;
      if (aa !== ab) return aa - ab;
      return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
    });
    if (!items.length) {
      box.innerHTML = (pool.length
        ? '<div class="ail-empty">没有匹配的 LoRA' + (q ? '，换个关键词试试' : '') + '</div>'
        : '<div class="ail-empty">还没读到 LoRA 清单<br>确认 ComfyUI 已连上、models/loras 里有文件</div>');
      return;
    }
    box.innerHTML = items.slice(0, 300).map(it => {
      const sel = picked.get(it.name);
      const accel = aiLoraIsAccel(it.name);
      // 加速 LoRA 用短标签，避免长说明挤掉文件名
      const hint = accel ? '加速·仅 Viggle' : (it.hint || '');
      return `<label class="ail-row${sel ? ' on' : ''}" title="${esc(it.name)}">
        <input type="checkbox" data-ail="${esc(it.name)}" ${sel ? 'checked' : ''}>
        <span class="ail-name">${esc(shortName(it.name))}</span>
        ${hint ? `<span class="ail-hint${accel ? ' accel' : ''}">${esc(hint)}</span>` : ''}
        <input type="number" data-ailst="${esc(it.name)}" step="0.1" min="-2" max="2"
          value="${sel ? sel.strength : 1.0}" title="强度">
      </label>`;
    }).join('');
  }

  function aiLoraToggle(name, on) {
    if (!name) return;
    state.ai.loras = state.ai.loras.filter(l => l.name !== name);
    if (on) {
      if (state.ai.loras.length >= AI_LORA_MAX) {
        heroNotice('最多选择 ' + AI_LORA_MAX + ' 个 LoRA', 'warn');
        return false;
      }
      state.ai.loras.push({ name, strength: 1.0 });
    }
    aiLoraSave(); aiLoraSyncBtn();
    return true;
  }

  async function aiLoraOpen() {
    const pop = $('#aiLoraPop'); if (!pop) return;
    if (!pop.classList.contains('hidden')) { aiLoraClose(); return; }
    pop.classList.remove('hidden');
    if ($('#ailSearch')) $('#ailSearch').value = '';
    aiLoraSyncBtn();
    // 清单先渲染（可能是缓存的），再去拉最新的，避免面板空白等待
    renderAiLoraList();
    // 每次打开都刷新一遍：用户新装了 LoRA 不用重开页面
    await aiLoraLoadPool(true);
    renderAiLoraList();
    aiLoraSyncBtn();
    if ($('#ailSearch')) setTimeout(() => { try { $('#ailSearch').focus(); } catch (e) {} }, 30);
  }
  function aiLoraClose() {
    const pop = $('#aiLoraPop'); if (pop) pop.classList.add('hidden');
  }

  /* 把拖进对话框的结果图转成 ComfyUI input 文件名，作为待发送图片。
     走已有的 /api/upload（把图片上传进 ComfyUI input），不依赖新增接口，后端未重启也能用。 */
  async function aiAddDroppedImage(obj) {
    if (!obj || !obj.url) return;
    if (state.ai.images.length >= 3) return heroNotice('最多同时带 3 张图', 'warn');
    let name = obj.input_name || '';
    if (!name) {
      try {
        const blob = await (await fetch(obj.url)).blob();
        const fd = new FormData();
        fd.append('image', new File([blob], 'cyui_drop.png', { type: blob.type || 'image/png' }));
        const up = await api('/api/upload', { method: 'POST', body: fd });
        name = ((up.images || [])[0] || {}).name || '';
      } catch (e) { heroNotice('图片转输入失败：' + e.message, 'error'); return; }
    }
    if (!name) return heroNotice('没有拿到 ComfyUI input 文件名', 'error');
    state.ai.images.push({
      name, url: obj.url,
      width: Number(obj.width) || 0, height: Number(obj.height) || 0,
    });
    aiRenderAttach();
    heroNotice('已加入待发送图片，描述下一步处理即可');
  }

  function aiOpen(open, view) {
    const panel = $('#aiPanel');
    const show = open !== undefined ? open : panel.classList.contains('hidden');
    // 关闭后全局只剩悬浮按钮，没有任何依附在右侧的把手 / 收缩态
    panel.classList.toggle('hidden', !show);
    state.ai.open = show;
    $('#aiFull').textContent = panel.classList.contains('ai-full') ? '⤡' : '⛶';
    if (show) { aiShowView(view || 'chat'); aiRenderAttach(); aiLoraSyncBtn(); }
  }

  function initAi() {
    state.ai.view = state.ai.view || 'chat';
    AI_MSG_MAP = aiLoadMsgs();
    // 会话 id 与人工侧完全一致；boot 稍后恢复 sessionId 时会调用 aiOnSessionsChanged 再同步一次
    state.ai.chatId = state.sessionId || null;
    state.ai.messages = state.ai.chatId ? (AI_MSG_MAP[state.ai.chatId] || []).slice(-30) : [];
    // 手选 LoRA 存在 localStorage（跟会话无关，用户换对话也还在）
    aiLoraLoad();
    aiLoraSyncBtn();

    const fab = $('#aiFab');
    let pos = { left: window.innerWidth - 84, top: window.innerHeight - 170 };
    try {
      const s = JSON.parse(localStorage.getItem('cyui_ai_pos') || 'null');
      if (s && typeof s.left === 'number') pos = s;
    } catch (e) { /* 忽略 */ }
    const place = () => {
      fab.style.left = Math.max(8, Math.min(window.innerWidth - 66, pos.left)) + 'px';
      fab.style.top = Math.max(8, Math.min(window.innerHeight - 66, pos.top)) + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    };
    place();
    let drag = null;
    fab.addEventListener('pointerdown', e => {
      drag = { sx: e.clientX, sy: e.clientY, left: pos.left, top: pos.top, moved: false };
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      pos.left = Math.max(8, Math.min(window.innerWidth - 66, drag.left + dx));
      pos.top = Math.max(8, Math.min(window.innerHeight - 66, drag.top + dy));
      place();
    });
    fab.addEventListener('pointerup', () => {
      // 悬浮按钮是打开助手对话的唯一入口
      if (drag && !drag.moved) aiOpen();
      if (drag && drag.moved) { try { localStorage.setItem('cyui_ai_pos', JSON.stringify(pos)); } catch (e) { /* 忽略 */ } }
      drag = null;
    });

    $('#aiClose').addEventListener('click', () => aiOpen(false));
    $('#aiHistoryBtn').addEventListener('click', () =>
      aiShowView(state.ai.view === 'history' ? 'chat' : 'history'));
    $('#aiNew').addEventListener('click', () => aiNewChat());
    $('#aiHistNew').addEventListener('click', () => aiNewChat());
    $('#aiSettings').addEventListener('click', () => { switchView('settings'); aiOpen(false); });
    $('#aiFull').addEventListener('click', () => {
      const panel = $('#aiPanel');
      panel.classList.toggle('ai-full');
      $('#aiFull').textContent = panel.classList.contains('ai-full') ? '⤡' : '⛶';
    });

    /* 历史对话：切换 / 重命名 / 单个删除 / 勾选批量删除 */
    $('#aiHistoryView').addEventListener('click', async e => {
      const rename = e.target.closest('[data-ai-rename]');
      if (rename) { aiStartRename(rename.dataset.aiRename, rename.closest('.ai-hist-item')); return; }
      const del = e.target.closest('[data-ai-del]');
      if (del) {
        const id = del.dataset.aiDel;
        const c = (state.sessions || []).find(x => x.id === id) || {};
        // 删会话会连带删除它在图库/画布的作品（store.delete_session 联动），
        // 确认弹窗必须明说，否则用户清个对话就把作品库清没了（真实事故：45 张图连带被删）
        const n = (state.gallery || []).filter(g => g.session_id === id).length;
        if (!(await confirmDialog('删除历史对话「' + (c.title || '新对话') + '」？'
            + (n ? '\n⚠ 该对话名下有 ' + n + ' 张作品图，将一并删除（含本地文件）！' : '')))) return;
        await aiDeleteChats([id]); heroNotice('对话已删除' + (n ? '（连带删除 ' + n + ' 张作品）' : ''));
        return;
      }
      const open = e.target.closest('[data-ai-open]');
      if (open) aiSwitchChat(open.dataset.aiOpen);
    });
    $('#aiHistoryView').addEventListener('change', e => {
      const cb = e.target.closest('[data-ai-check]');
      if (cb) {
        if (cb.checked) AI_HIST_SEL.add(cb.dataset.aiCheck);
        else AI_HIST_SEL.delete(cb.dataset.aiCheck);
        const item = cb.closest('.ai-hist-item');
        if (item) item.classList.toggle('picked', cb.checked);
        aiUpdateHistSel();          // 局部更新，不重绘列表，保留滚动位置
        return;
      }
      if (e.target.id === 'aiHistAll') {
        const on = e.target.checked;
        (state.sessions || []).forEach(c => {
          if (on) AI_HIST_SEL.add(c.id); else AI_HIST_SEL.delete(c.id);
        });
        $$('#aiHistList [data-ai-check]').forEach(x => { x.checked = on; });
        $$('#aiHistList .ai-hist-item').forEach(x => x.classList.toggle('picked', on));
        aiUpdateHistSel();
      }
    });
    $('#aiHistDelSel').addEventListener('click', async () => {
      const ids = Array.from(AI_HIST_SEL);
      if (!ids.length) return heroNotice('请先勾选历史对话', 'error');
      // 与单条删除同样的连带删除警告（删会话会连带删它名下的作品图）
      const n = (state.gallery || []).filter(g => ids.includes(g.session_id)).length;
      if (!(await confirmDialog('删除选中的 ' + ids.length + ' 个历史对话？'
          + (n ? '\n⚠ 这些对话名下共有 ' + n + ' 张作品图，将一并删除（含本地文件）！' : '')))) return;
      await aiDeleteChats(ids); heroNotice('已删除 ' + ids.length + ' 个对话' + (n ? '（连带删除 ' + n + ' 张作品）' : ''));
    });

    // 忙碌时发送键 = 停止键：点击截断 AI 思考 / 工具执行
    $('#aiSend').addEventListener('click', () => {
      if (state.ai.busy) aiStop(); else aiSend();
    });
    $('#aiInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!state.ai.busy) aiSend(); }
    });
    $('#aiInput').addEventListener('input', e => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px';
    });
    $('#aiAttach').addEventListener('click', () => openImgPicker('ai'));
    // LoRA 手选：⭐ 打开面板，勾选即生效（每轮请求都会带上）
    $('#aiLora').addEventListener('click', e => { e.stopPropagation(); aiLoraOpen(); });
    $('#ailClose').addEventListener('click', () => aiLoraClose());
    $('#ailDone').addEventListener('click', () => aiLoraClose());
    $('#ailClear').addEventListener('click', () => {
      state.ai.loras = [];
      aiLoraSave(); aiLoraSyncBtn(); renderAiLoraList();
      heroNotice('已清空 LoRA');
    });
    $('#ailSearch').addEventListener('input', () => renderAiLoraList());
    $('#ailSearch').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); aiLoraClose(); }
      // 在搜索框里回车不要触发发送
      if (e.key === 'Enter') { e.preventDefault(); }
    });
    // 勾选 / 改强度：change 覆盖勾选框，input 让数字框边输入边生效
    $('#ailList').addEventListener('change', e => {
      const cb = e.target.closest('[data-ail]');
      if (cb) {
        const ok = aiLoraToggle(cb.dataset.ail, cb.checked);
        if (!ok && cb.checked) cb.checked = false;
        renderAiLoraList();
        return;
      }
      const st = e.target.closest('[data-ailst]');
      if (st) {
        const l = state.ai.loras.find(x => x.name === st.dataset.ailst);
        const v = Number(st.value);
        if (l && isFinite(v)) { l.strength = Math.max(-2, Math.min(2, v)); aiLoraSave(); }
      }
    });
    $('#ailList').addEventListener('input', e => {
      const st = e.target.closest('[data-ailst]');
      if (!st) return;
      const l = state.ai.loras.find(x => x.name === st.dataset.ailst);
      const v = Number(st.value);
      if (l && isFinite(v)) { l.strength = Math.max(-2, Math.min(2, v)); aiLoraSave(); }
    });
    // 点面板外面 / Esc 关闭
    document.addEventListener('click', e => {
      const pop = $('#aiLoraPop');
      if (!pop || pop.classList.contains('hidden')) return;
      if (e.target.closest('#aiLoraPop') || e.target.closest('#aiLora')) return;
      aiLoraClose();
    });
    document.addEventListener('keydown', e => {
      const pop = $('#aiLoraPop');
      if (e.key === 'Escape' && pop && !pop.classList.contains('hidden')) aiLoraClose();
    });
    $('#aiFile').addEventListener('change', e => {
      aiAttachFiles(e.target.files); e.target.value = '';
    });
    $('#aiBody').addEventListener('click', e => {
      const fig = e.target.closest('[data-ai-img]');
      if (fig) {
        const info = aiImgInfo(fig);
        // ⋯ 与对话模式 / 自由画布使用同一套图片菜单（查看大图、反推、放大、发送…）
        if (e.target.closest('[data-ai-more]')) { openImgMenu(e.clientX, e.clientY, info); return; }
        // 点图片本身：直接打开与对话/画布一致的大图 + 作品信息
        openLightbox(info);
        return;
      }
      const step = e.target.closest('[data-ai-step]');
      if (step) {
        const ti = Number(step.dataset.aiStep);
        const bot = state.ai.messages.slice().reverse().find(m => m.role === 'assistant' && (m.tools || [])[ti]);
        const t = bot && bot.tools[ti];
        if (!t) return;
        if (t.tool === 'list_gallery') {
          const item = (t.result.items || [])[0] || state.gallery[0];
          if (item) openLightbox(item); else heroNotice('图库里还没有作品', 'error');
        } else {
          openQueueModal();
        }
        return;
      }
      if (e.target.closest('[data-ai-settings]')) { switchView('settings'); aiOpen(false); }
    });
    $('#aiAttachRow').addEventListener('click', e => {
      const b = e.target.closest('[data-ai-remove]');
      if (b) {
        state.ai.images.splice(Number(b.dataset.aiRemove), 1);
        aiRenderAttach();
        return;
      }
      const th = e.target.closest('[data-ai-preview]');
      if (th) {
        const img = th.querySelector('img');
        openLightbox({
          url: th.dataset.aiPreview, name: th.dataset.aiName || '参考图',
          width: Number(th.dataset.aiW) || (img && img.naturalWidth) || 0,
          height: Number(th.dataset.aiH) || (img && img.naturalHeight) || 0,
        });
      }
    });
    /* 结果图可直接拖进对话框继续处理：带完整 url / 尺寸 / input_name */
    $('#aiBody').addEventListener('dragstart', e => {
      const fig = e.target.closest('[data-ai-img]');
      if (!fig) return;
      const meta = AI_IMG_META[fig.dataset.aiImg] || {};
      const payload = JSON.stringify({
        url: fig.dataset.aiImg,
        name: fig.dataset.aiName,
        width: Number(fig.dataset.aiW) || 0,
        height: Number(fig.dataset.aiH) || 0,
        input_name: fig.dataset.aiInput || meta.input_name || '',
      });
      try {
        e.dataTransfer.setData('application/x-cyui-image', payload);
        e.dataTransfer.setData('text/plain', payload);
        e.dataTransfer.effectAllowed = 'copy';
      } catch (err) { /* 浏览器限制时忽略 */ }
    });
    const chatView = $('#aiChatView');
    chatView.addEventListener('dragover', e => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* 忽略 */ }
      chatView.classList.add('ai-dropping');
      if (!$('.ai-drop-hint', chatView)) {
        const tip = document.createElement('div');
        tip.className = 'ai-drop-hint';
        tip.textContent = '松手即可把图片加入对话';
        chatView.appendChild(tip);
      }
    });
    chatView.addEventListener('dragleave', e => {
      if (chatView.contains(e.relatedTarget)) return;
      chatView.classList.remove('ai-dropping');
      const tip = $('.ai-drop-hint', chatView); if (tip) tip.remove();
    });
    chatView.addEventListener('drop', async e => {
      e.preventDefault();
      chatView.classList.remove('ai-dropping');
      const tip = $('.ai-drop-hint', chatView); if (tip) tip.remove();
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        aiAttachFiles(e.dataTransfer.files);
        return;
      }
      let raw = '';
      try {
        raw = e.dataTransfer.getData('application/x-cyui-image')
          || e.dataTransfer.getData('text/plain') || '';
      } catch (err) { /* 忽略 */ }
      let obj = null;
      try { obj = JSON.parse(raw); } catch (err) { obj = null; }
      if (!obj) {
        const uri = e.dataTransfer.getData('text/uri-list') || raw;
        if (uri) obj = { url: String(uri).split('\n')[0].trim() };
      }
      if (!obj || !obj.url) return heroNotice('没有识别到可拖入的图片', 'error');
      try {
        const u = new URL(obj.url, location.href);
        obj.url = u.pathname + u.search;          // 去掉跨域 origin，转成同源可访问路径
      } catch (err) { /* 保持原值 */ }
      aiAddDroppedImage(obj);
    });

    window.addEventListener('resize', place);
    aiRenderAttach(); aiRender(); aiRenderHistory(); aiOpen(false);
  }

  /* ---------------- 启动 ---------------- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
