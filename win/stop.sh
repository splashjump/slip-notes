#!/bin/bash
# win/stop.sh — 停止 slip 开发环境（与 dev.sh 对应）
# 用法（在 win/ 目录，git bash）：./stop.sh    （Windows PowerShell 用户用 .\stop.ps1）
# 注意：绝不全杀 node（pi 也是 node 进程），只按命令行/PID 杀
cd "$(dirname "$0")"

echo "== 停止 win.exe =="
taskkill //F //IM win.exe 2>/dev/null || echo "  (无 win.exe)"

echo "== 停止 tauri dev 包装进程（仅 cmd/node，命令行含 tauri dev）=="
powershell -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -in @('cmd.exe','node.exe') -and \$_.CommandLine -like '*tauri dev*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('  killed ' + \$_.Name + ' PID ' + \$_.ProcessId) }" 2>/dev/null || true

echo "== 停止 14300 端口监听者（vite）=="
powershell -Command "Get-NetTCPConnection -LocalPort 14300 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output ('  killed PID ' + \$_.OwningProcess) }" 2>/dev/null || true

sleep 1
echo "== 已停止 =="
