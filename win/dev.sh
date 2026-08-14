#!/bin/bash
# spike 开发重启脚本：精准清理旧进程 → 启动 tauri dev
# 注意：绝不全杀 node（pi 也是 node 进程），只按端口/PID 杀
cd "$(dirname "$0")"
export PATH="/c/Users/admin/.cargo/bin:$PATH"

echo "== 清理旧 win.exe =="
taskkill //F //IM win.exe 2>/dev/null || echo "  (无 win.exe)"

echo "== 清理 14300 端口监听者 =="
powershell -Command "Get-NetTCPConnection -LocalPort 14300 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output ('  killed ' + \$_.OwningProcess) }" 2>/dev/null || true

sleep 2

echo "== 启动 tauri dev =="
nohup npx tauri dev > /tmp/tauri_dev.log 2>&1 &
echo "已启动，PID=$!，日志 /tmp/tauri_dev.log"
