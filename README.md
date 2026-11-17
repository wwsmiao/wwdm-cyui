# CYUI · 对话式 ComfyUI 创作台

一个本地网页工具：用聊天的方式驱动 ComfyUI 出图。输入一句话或丢一张图，自动挑选技能（文生图 / 图生图 / 图片编辑 / 局部重绘）、自动配参数，出图后进入图库与自由画布整理。

## 功能一览

- **对话式生成**：像聊天一样描述需求，自动路由到合适的技能与参数
- **四种技能**：文生图 · 图生图 · 图片编辑 · 局部重绘（涂抹遮罩，只改涂过的区域）
- **DeepSeek 助手模式**：接入 DeepSeek 后可用自然语言指挥出图、改参数、管图库
- **图库与自由画布**：生成结果自动入库，画布里拖拽整理、编组、打组下载
- **局部重绘**：主界面涂遮罩 → 只重绘涂抹区域，遮罩外逐像素不变
- **高清放大**：SeedVR2 放大链路（需按帮助页提示放置模型）
- **提示词润色 / 反推**：DeepSeek 或本地 Qwen3-VL 可选

## 部署（使用 ComfyUI 自带 Python，无需另装环境）

> 前提：本机已有一个能正常出图的 ComfyUI。下文把 ComfyUI 的安装目录记作 `<ComfyUI>`，
> 它的内嵌 Python 就是 `<ComfyUI>\python312\python.exe`（目录名以实际为准）。

### 1. 获取代码

```bat
git clone https://github.com/wwsmiao/wwdm-cyui.git
cd wwdm-cyui
```

### 2. 安装依赖（用 ComfyUI 的内嵌 Python）

```bat
<ComfyUI>\python312\python.exe -m pip install -r requirements.txt
```

只依赖 4 个包：flask、requests、pillow、websocket-client（详见 requirements.txt 内注释）。

### 3. 启动

```bat
<ComfyUI>\python312\python.exe run.py
```

浏览器打开 <http://127.0.0.1:7871>。

### 4. 连接 ComfyUI

进入「设置」页，填 ComfyUI 服务地址（默认 `http://127.0.0.1:8188`），保存后看到「在线」即可开始出图。

## 模型与插件

不用对着文档找文件——启动后打开应用内的「**帮助**」页：

- 自动检测缺失的**模型**（Qwen-Image-2.1 底模 / CLIP / VAE、放大模型等），逐项给出放置目录与 hf-mirror 下载链接
- 自动检测缺失的**插件**（自定义节点），给出 ComfyUI-Manager 安装名
- 照着清单放文件 → 设置页点「刷新模型清单」→ 状态全部变绿即可

## 部署到其它电脑（便携形态）

要把 CYUI 带到另一台 Windows 电脑的 ComfyUI 环境里跑，用仓库 `deploy/` 目录里的便携包方案：

- `deploy/launch.py` + `deploy/start.bat`：一键拉起 ComfyUI + CYUI 并自动开浏览器
- 仓库根的 `deploy_sync.py`：把代码同步到任意部署目录，自动备份旧文件，**`data/` 永不覆盖**

详见 [deploy/README.md](deploy/README.md)。

## 数据与更新

- 你的全部数据（对话历史、作品图库、上传图）都在项目的 `data\` 目录里
- 更新代码时直接覆盖 `app\ static\ templates\ run.py` 即可，**不要动 `data\` 文件夹**
- 最新版本发布在网盘（应用内「帮助 → 版本与更新」有链接）

## 目录结构

```
wwdm-cyui/
├─ run.py            启动入口
├─ requirements.txt  依赖清单（含踩坑注释）
├─ app/              后端（Flask 路由 / 工作流构建 / DeepSeek 助手 / 存储）
├─ templates/        页面模板
├─ static/           前端 JS / CSS
└─ data/             运行数据（自动生成，不入库）
```

## 常见问题

- **启动报 `ModuleNotFoundError`**：依赖没装进 ComfyUI 的 Python——确认第 2 步用的是 `<ComfyUI>\python312\python.exe`，不是系统 Python。
- **进度条一直不动**：requirements.txt 第三节的 websocket 说明（十有八九装成了 `websocket` 而不是 `websocket-client`）。
- **7871 端口被占用**：改 `run.py` 末尾的 `port=7871`，或确保旧实例已关闭。
- **ComfyUI 在另一台机器**：设置页填 `http://那台机器IP:8188` 即可，本项目与 ComfyUI 不必同机。
