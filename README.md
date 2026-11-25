# WWDM CYUI 创作台

基于 ComfyUI 的本地 AI 创作台。把 ComfyUI 的节点工作流包成一套顺手的中文界面：卡片流、无限画布、文本三种视图，作品、素材、项目都留在本机。本地或远程 ComfyUI 都能连。

> **软件整合包（含 ComfyUI + 本项目用到的全部插件与模型）**
> 夸克网盘：<https://pan.quark.cn/s/29a3bb94f9cb?pwd=y5iP> ｜ 提取码 `y5iP`
> 更新时整包覆盖即可；只缺个别文件的话，看应用内「设置 → 项目清单」里每个文件的仓库地址。

## 功能

- **三种视图**：卡片流（浏览作品）、无限画布（节点连线创作）、文本（提示词模式），切换不丢输入
- **工作流接入**：Qwen-Image 2.1 文生图 / 图片编辑 / 局部重绘、MiniMax H3 首帧 / 尾帧 / 首尾帧 / 多参考生视频、Z-Image Turbo 文生图与图生图、TTP + SeedVR2 高清放大、SD1.5 局部重绘
- **局部重绘**：作品卡片或画布节点上涂遮罩，只重画选中区域；弹窗里可临时改负面提示词、重绘幅度、遮罩外扩
- **纯 Python 工作流**：网格拼接（多图按 a×b 原画质拼接）、视频尾帧提取（取视频最后一帧存成新图片），都不走 ComfyUI
- **多模态参考**：最多 9 图 + 3 视频 + 3 音频一起喂给多参考工作流
- **实例自适应**：换 ComfyUI 实例后模型名自动对齐（量化后缀 / 子目录前缀 / 大小写差异），跑不起来的工作流自动隐藏并说明缺什么
- **AI 助手**：提示词润色、单图反推、图片编辑指令、Agent 对话（支持 DeepSeek 官方 API）
- **素材与作品**：图库、资产库、项目分组、按原图重新生成、批量下载/删除
- **不依赖公网服务**：界面通过后端代理访问 ComfyUI，前端不直连

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（其他系统未测） |
| Python | 3.10+，3.12 实测 |
| ComfyUI | ≥ 0.44（Qwen-Image 2.1、MiniMax H3、ResolutionSelector、SaveImageAdvanced 都是内置节点，版本太老会提示缺节点），本机或远程均可 |
| 显存 | 视模型而定：Qwen-Image 2.1 int8 约 12G，MiniMax H3 pruned 约 16G+ |
| ffmpeg | 可选，「视频尾帧」功能需要（放在 `PATH` 里，或用环境变量 `FFMPEG_BIN` 指定路径） |

## 安装

```bash
git clone https://github.com/wwsmiao/wwdm-cyui.git
cd wwdm-cyui
pip install -r requirements.txt
python app.py
```

打开 <http://127.0.0.1:7860>。首次启动会自动创建 `data/`、`static/outputs/`、`workflows/graphs/` 等目录。

也可以不手动装：直接用上面的整合包，解压即用。

## 连接 ComfyUI

「设置 → ComfyUI 连接」里填服务地址：

- 本机：`http://127.0.0.1:8188`（连接本机时 `comfy_dir` 可留空自动探测，用于浏览 input/output 素材）
- 远程：`https://你的实例地址`（建议 https，进度走 wss）

填完点保存，界面会自动重新拉取该实例的节点与模型清单。

## 插件与模型

本项目只需要三个自定义节点包，其余都是 ComfyUI 内置节点：

| 节点包 | 用途 | 地址 |
|---|---|---|
| ComfyUI-SeedVR2 Video Upscaler | SeedVR2 高清放大 / 二采 | <https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler> |
| ComfyUI TTP Toolset | 图片分块批处理（配合放大） | <https://github.com/TTPlanetPig/ComfyUI_TTP_Toolset> |
| Qwen-Image 2.1 Viggle Turbo | Viggle 6 步加速 | <https://github.com/RiverSide71/Qwen-Image-2.1-viggle-turbo> |
| ComfyUI-Manager（推荐） | 一键安装 / 更新节点与缺失模型 | <https://github.com/ltdrdata/ComfyUI-Manager> |

模型按目录分六类（diffusion_models / text_encoders / vae / loras / checkpoints / SEEDVR2），
完整清单、文件名、放置路径和来源仓库都在应用内 **设置 → 项目清单** 里，由工作流自动扫描生成，
可以直接复制下载链接，也能看到当前连接的实例还缺哪个文件。

主要来源仓库：

- Qwen-Image 2.1：<https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1>
- Qwen3-VL 文本编码器：<https://modelscope.cn/models/Comfy-Org/Qwen3-VL>
- MiniMax H3：<https://modelscope.cn/models/Comfy-Org/MiniMax-H3>
- Z-Image Turbo：<https://modelscope.cn/models/Comfy-Org/z_image_turbo>
- Gemma 4：<https://modelscope.cn/models/Comfy-Org/gemma-4>
- Qwen-Image 2.1 Viggle Turbo LoRA：<https://modelscope.cn/models/Viggle/Qwen-Image-2.1-viggle-turbo>
- SeedVR2 权重：<https://modelscope.cn/models/numz/SeedVR2_comfyUI>
- SD1.5 inpaint（diffusers 格式，需转单文件）：<https://modelscope.cn/models/AI-ModelScope/stable-diffusion-inpainting>

## 目录结构

```
app.py                Flask 入口（默认 7860 端口）
config.py             路径、默认参数、比例与分辨率表
api/                  HTTP 接口（作品、生成、素材、设置、Agent…）
core/                 业务核心：任务调度、ComfyUI 客户端、实例探测、模型名解析、
                      工作流装配、图片处理、网格拼接、素材库、监控
workflows/            每个 ComfyUI 工作流一个模块 + graphs/ 下的工作流图
templates/index.html  单页界面
static/css|js         样式与模块化前端（composer / canvas / card-menu / mask-editor …）
data/                 项目、作品、设置（不入库）
```

## 数据与隐私

- 作品、项目、素材索引、设置（含 API Key）全部存在本机 `data/`，已在 `.gitignore` 里排除，不会进仓库
- 仓库里只有代码与工作流图，没有任何作品图片
- 界面所有请求走后端代理，API Key 只保存在本机配置文件

## 几个已知要点

- **局部重绘必须 `denoise = 1.0`**：`VAEEncodeForInpaint` 会先把遮罩区填灰再编码，调小会留灰块
- **换实例后改设置里的模型**：不同实例的模型文件名常常不一致（量化后缀、子目录、大小写）。程序会自动映射同名 / 同系列文件，映射不到的 LoRA 会跳过并提示；实在没有的模型请到「设置 → 图片参数 / 视频参数」重新选
- **远程实例偶尔读超时**：轮询已做容错；排队中的任务在作品卡上点「找回」会重新挂上进度
- **修改工作流图后要重启服务**：图有内存缓存

## 版本

当前版本 `1.1.0`，ComfyUI 适配 ≥ 0.44。

## 反馈

问题反馈与改进方向收集：<https://docs.qq.com/form/page/DZmZLQ0prWU5wbEdp>

## 作者

- 微微的猫
- B 站：<https://space.bilibili.com/472768517>
- AI 绘画交流 QQ 群：652115462
- 拼多多店铺：像素织梦
