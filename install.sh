#!/usr/bin/env bash
set -e
echo "========================================"
echo "  轻量化聊天程序 - 安装依赖"
echo "========================================"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js"
  echo "请先安装 Node.js 14 以上版本：https://nodejs.org/"
  exit 1
fi
echo "检测到 Node.js: $(node -v)"
echo
echo "正在安装依赖..."
npm install
echo
echo "========================================"
echo "  安装完成！"
echo "  运行 ./start.sh 即可启动服务"
echo "========================================"
