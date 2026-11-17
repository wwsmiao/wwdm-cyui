# CYUI 便携部署（跨电脑 ComfyUI 使用）

把 CYUI 带到任何一台 Windows 电脑的 ComfyUI 环境里跑。核心就是三个文件 + 一个目录约定。

## 目录形态

```
<包根>/                       ← start.bat 所在目录（本机示例：G:\wwdm-cyui）
├─ start.bat                  ← 双击这个：一键拉起 ComfyUI + CYUI 并自动开浏览器
├─ python312/                 ← 便携 Python（ComfyUI 的内嵌环境）
└─ ComfyUI/                   ← ComfyUI 本体
   ├─ launch.py               ← 启动编排（等 ComfyUI 端口就绪后再启动 CYUI）
   └─ wwdm-cyui/              ← CYUI 代码（deploy_sync.py 的同步目标）
      └─ data/                ← 每台电脑自己的图库与对话（互不影响，同步永不覆盖）
```

## 首次部署到新电脑

1. 装好 ComfyUI 与便携 Python（`python312/`），模型按应用内「帮助」页清单放好
2. 把本仓库放进 `ComfyUI/wwdm-cyui/`（git clone 或复制）
3. 装 CYUI 依赖（用同一套便携 Python）：
   ```bat
   <包根>\python312\python.exe -m pip install -r <包根>\ComfyUI\wwdm-cyui\requirements.txt
   ```
4. 把本目录的 `launch.py` 复制到 `<包根>\ComfyUI\launch.py`，
   把 `start.bat` 复制到 `<包根>\start.bat`
5. 双击 `start.bat`，完成后自动打开浏览器

## 已部署电脑的代码更新

在**开发机**（本仓库）执行，一行同步全部代码，自动备份旧文件、绝不碰 `data/`：

```bat
python deploy_sync.py G:\wwdm-cyui\ComfyUI\wwdm-cyui
python deploy_sync.py --list G:\wwdm-cyui\ComfyUI\wwdm-cyui   :: 先预览
```

同步完重启 `start.bat` 即生效。

## 为什么 data/ 永不同步

每台电脑的 `data/` 是那台机器的使用痕迹（作品图库、对话、个人设置）。
`deploy_sync.py` 的同步清单里物理上不含 `data/`，误操作也不可能覆盖它。
