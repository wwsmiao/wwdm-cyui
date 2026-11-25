/* 全局共享状态：一个项目ID切换，所有模块跟着换数据 */
const State = {
  projects: [],
  activeId: "",
  workflows: [],
  workflow: "z-image-turbo-文生图",
  references: [],
  mediaType: "image",
  params: {
    ratio: "1:1", resolution: "1k", batch: 1,
    custom: false, custom_width: 1024, custom_height: 1024,
    // 视频工作流专用：比例仅作记录，画面比例永远跟随参考图
    video_ratio: "16:9", quality: 1, duration: 3,
  },
  tasks: [],
  // 首屏视图要跟上次一致：不然刷新时会先渲染卡片再跳到文本/画布
  viewMode: (() => {
    try {
      const saved = localStorage.getItem("wwdm-view-mode");
      return ["text", "card", "canvas"].includes(saved) ? saved : "card";
    } catch {
      return "card";
    }
  })(),
  zoom: 1,
  cardZoom: 1,   // 卡片模式的缩放单独记，切回画布不受影响

  activeProject() {
    return this.projects.find((item) => item.id === this.activeId) || null;
  },
};
