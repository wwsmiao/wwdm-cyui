/* 所有后端接口集中在这里，页面逻辑不直接写 URL */
const API = {
  listProjects: () => request("/api/projects"),
  createProject: (name) => request("/api/projects", { method: "POST", body: { name } }),
  duplicateProject: (id) => request(`/api/projects/${id}/duplicate`, { method: "POST" }),
  batchDeleteProjects: (ids) => request("/api/projects/batch-delete", { method: "POST", body: { ids } }),
  activateProject: (id) => request(`/api/projects/${id}/activate`, { method: "POST" }),
  renameProject: (id, name) => request(`/api/projects/${id}`, { method: "PATCH", body: { name } }),
  saveNotes: (id, notes) => request(`/api/projects/${id}/notes`, { method: "PUT", body: { notes } }),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: "DELETE" }),

  listWorkflows: () => request("/api/workflows"),
  workflowParams: (id) => request(`/api/workflows/${encodeURIComponent(id)}/params`),
  generate: (payload) => request("/api/generate", { method: "POST", body: payload }),
  runPrompt: (body, opts = {}) => request("/api/prompt/run", { method: "POST", body, ...opts }),
  interruptComfy: () => request("/api/comfy/interrupt", { method: "POST" }),
  comfyStatus: () => request("/api/comfy/status"),
  promptTemplates: () => request("/api/prompt-templates"),
  savePromptTemplates: (templates, bindings) =>
    request("/api/prompt-templates", { method: "PUT", body: { templates, bindings } }),
  deepseekModels: (body) => request("/api/deepseek/models", { method: "POST", body }),
  tasks: (projectId) => request(`/api/projects/${projectId}/tasks`),
  clearTasks: (projectId) => request(`/api/projects/${projectId}/tasks/clear`, { method: "POST" }),
  cancelTask: (id) => request(`/api/tasks/${id}/cancel`, { method: "POST" }),
  reclaimTask: (id) => request(`/api/tasks/${id}/reclaim`, { method: "POST" }),
  deleteTask: (id) => request(`/api/tasks/${id}`, { method: "DELETE" }),
  deleteImages: (items) => request("/api/images/delete", { method: "POST", body: { items } }),
  // 本地图片编辑：裁剪 / 旋转翻转 / 色调，直接出新作品
  editImage: (url, op, options = {}) =>
    request("/api/images/edit", { method: "POST", body: { url, op, options } }),

  // 资产库：分类=文件夹，资产=文件
  libraryAssets: (category = "") =>
    request(`/api/library/assets${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  libraryCreateCategory: (name) => request("/api/library/categories", { method: "POST", body: { name } }),
  libraryRenameCategory: (name, to) => request("/api/library/categories", { method: "PATCH", body: { name, to } }),
  libraryDeleteCategory: (name) => request("/api/library/categories", { method: "DELETE", body: { name } }),
  libraryAdd: (payload) => request("/api/library/items", { method: "POST", body: payload }),
  savePromptText: (text, title = "") =>
    request("/api/library/prompts", { method: "POST", body: { text, title } }),
  libraryMove: (payload) => request("/api/library/items", { method: "PATCH", body: payload }),
  libraryCopyItem: (payload) => request("/api/library/items/copy", { method: "POST", body: payload }),
  libraryRenameItem: (payload) => request("/api/library/items/rename", { method: "PATCH", body: payload }),
  libraryCopyCategory: (payload) => request("/api/library/categories/copy", { method: "POST", body: payload }),
  libraryRemove: (payload) => request("/api/library/items", { method: "DELETE", body: payload }),
  comfyDelete: (source, name) => request("/api/comfy/delete", { method: "POST", body: { source, name } }),

  stats: () => request("/api/system/stats"),
  manifest: () => request("/api/manifest"),
  assets: (scope, projectId) =>
    request(`/api/assets?scope=${encodeURIComponent(scope)}&project_id=${encodeURIComponent(projectId || "")}`),
  comfyFileUrl: (source, name) =>
    `/api/comfy/file?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`,
  importReferences: (items) => request("/api/references/import", { method: "POST", body: { items } }),
  uploadReferences: (files, projectId) => {
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file, file.name));
    if (projectId) form.append("project_id", projectId);
    return request("/api/references/upload", { method: "POST", body: form, raw: true });
  },
  settings: () => request("/api/settings"),
  saveSettings: (body) => request("/api/settings", { method: "POST", body }),

  // ---- AI Agent（独立模块）----
  agentConfig: () => request("/api/agent/config"),
  saveAgentConfig: (body) => request("/api/agent/config", { method: "POST", body }),
  agentModels: (override) => request("/api/agent/models", { method: "POST", body: override || {} }),
  agentChat: (messages, tools) => request("/api/agent/chat", { method: "POST", body: { messages, tools } }),
  renameMedia: (taskId, url, name) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/media-name`, { method: "POST", body: { url, name } }),
  saveWorkflowParams: (workflowId, params) =>
    request(`/api/workflows/${encodeURIComponent(workflowId)}/params`, { method: "POST", body: { params } }),
  agentTest: (override) => request("/api/agent/test", { method: "POST", body: override || {} }),
};
