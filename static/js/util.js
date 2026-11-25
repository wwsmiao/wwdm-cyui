/* 通用小工具 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function icon(name, cls = "") {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

async function request(url, options = {}) {
  const config = { method: "GET", headers: {}, ...options };
  delete config.raw;
  // FormData 交给浏览器自己带 boundary，不能自己写 Content-Type
  const isForm = typeof FormData !== "undefined" && config.body instanceof FormData;
  if (config.body && !isForm && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  let response;
  try {
    response = await fetch(url, config);
  } catch (error) {
    // 主动停止（AbortController）不是网络故障，标记后原样抛出
    if (error?.name === "AbortError") {
      const stopped = new Error("已停止");
      stopped.aborted = true;
      throw stopped;
    }
    throw new Error("无法连接到创作台服务");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

function timeLabel(timestamp) {
  if (!timestamp) return "";
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN");
}

function sizeFor(ratio, resolution) {
  const map = {
    "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "3:4": [3, 4],
    "4:3": [4, 3], "3:2": [3, 2], "2:3": [2, 3], "21:9": [21, 9], "9:21": [9, 21],
  };
  const longest = { "1k": 1024, "1.5k": 1536, "2k": 2048 }[resolution] || 1024;
  const [rw, rh] = map[ratio] || [1, 1];
  const scale = longest / Math.max(rw, rh);
  return [Math.floor(rw * scale / 64) * 64 || 64, Math.floor(rh * scale / 64) * 64 || 64];
}

function sizeForParams(params) {
  if (params?.custom) {
    const align = (value, fallback) => {
      const n = Math.max(64, Math.min(4096, Number(value) || fallback));
      return Math.floor(n / 8) * 8 || 64;
    };
    return [align(params.custom_width, 1024), align(params.custom_height, 1024)];
  }
  return sizeFor(params?.ratio, params?.resolution);
}

/* 视频尺寸估算：比例 + 百万像素 → 大致宽高（ResolutionSelector 按 32 对齐） */
function estimateMpSize(ratio, megapixels) {
  const [rw, rh] = String(ratio || "16:9").split(":").map(Number);
  if (!rw || !rh) return "—";
  const scale = Math.sqrt((Math.max(0.1, Number(megapixels) || 1) * 1e6) / (rw * rh));
  const w = Math.max(32, Math.round((rw * scale) / 32) * 32);
  const h = Math.max(32, Math.round((rh * scale) / 32) * 32);
  return `${w} × ${h}`;
}
