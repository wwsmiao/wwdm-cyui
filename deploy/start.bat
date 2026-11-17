@echo off
setlocal

rem 1. Base directory = folder of this bat file
set "BASE=%~dp0"
set "PYTHON=%BASE%python312\python.exe"
set "LAUNCH=%BASE%ComfyUI\launch.py"

rem 2. Sanity check
if not exist "%PYTHON%" (
    echo [ERROR] Python not found: "%PYTHON%"
    pause
    exit /b 1
)
if not exist "%LAUNCH%" (
    echo [ERROR] launch.py not found: "%LAUNCH%"
    pause
    exit /b 1
)

rem 3. Run launcher
"%PYTHON%" "%LAUNCH%"

echo.
echo [start.bat] launcher exited.
pause
exit /b 0