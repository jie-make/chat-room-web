@echo off
chcp 65001 >nul
echo ========================================
echo   轻量化聊天程序 - 安装依赖
echo ========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo 请先安装 Node.js 14 以上版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo 检测到 Node.js:
call node -v
echo.
echo 正在安装依赖...
call npm install
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败，请检查网络
  pause
  exit /b 1
)
echo.
echo ========================================
echo   安装完成！
echo   双击 start.bat 即可启动服务
echo ========================================
pause
