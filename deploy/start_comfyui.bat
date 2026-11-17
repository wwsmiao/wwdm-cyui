@echo off
setlocal

rem 1. Base directory = folder of this bat file
set "BASE=%~dp0"
set "PYTHON=%BASE%python312\python.exe"
set "COMFY_DIR=%BASE%ComfyUI"
set "ENTRY=%COMFY_DIR%\main.py"

rem 2. Sanity check
if not exist "%PYTHON%" (
    echo [ERROR] Python not found: "%PYTHON%"
    pause
    exit /b 1
)
if not exist "%ENTRY%" (
    echo [ERROR] main.py not found: "%ENTRY%"
    pause
    exit /b 1
)

rem 3. Run ComfyUI (cwd must be ComfyUI dir)
cd /d "%COMFY_DIR%"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
"%PYTHON%" -u "%ENTRY%"

echo.
echo [start_comfyui.bat] ComfyUI exited.
pause
exit /b 0