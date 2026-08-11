#!/usr/bin/env bash
set -e
echo "========================================"
echo "  轻量化聊天程序 - 启动服务"
echo "========================================"
echo
if [ ! -d node_modules ]; then
  echo "[错误] 未检测到依赖包，请先运行 ./install.sh"
  exit 1
fi
echo "正在启动服务..."
echo "启动后请在浏览器访问 http://localhost:3000"
echo "按 Ctrl+C 可停止服务"
echo
node server.js
