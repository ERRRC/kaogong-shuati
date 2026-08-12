@echo off
rem ============================================
rem  考公刷题 - 本地启动器（双击即可，无需敲命令）
rem  关闭本窗口即停止服务
rem ============================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo  正在启动考公刷题服务...
echo.
echo  本机访问:    http://localhost:3000
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo  局域网访问:  http://%%a:3000 ^(手机需连同一WiFi^)
echo.
echo  提示：关闭本窗口 = 停止服务
echo.

rem 2 秒后自动打开浏览器
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

node server.mjs 3000
pause
