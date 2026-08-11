@echo off
chcp 65001 >nul
echo ========================================
echo   轻量化聊天程序 - 启动服务
echo ========================================
echo.
if not exist node_modules (
  echo [错误] 未检测到依赖包，请先运行 install.bat
  echo.
  pause
  exit /b 1
)
echo 正在启动服务...
echo 启动后请在浏览器访问 http://localhost:3000
echo 按 Ctrl+C 可停止服务
echo.
node server.js
pause
