# win/dev.ps1 — slip 画布 spike 开发重启脚本（PowerShell）
# 用法（在 win/ 目录）：.\dev.ps1        （pwsh7 / Windows PowerShell 5.1 通用）
# 功能：精准清理旧进程（绝不误杀 node/pi）→ 启动 tauri dev（后台）→ 日志落 %TEMP%
# 停止 slip：taskkill /F /IM win.exe；或见脚本内"手动停止"注释

Write-Host "== 停止旧 win.exe（只杀本项目编译产物）=="
Get-CimInstance Win32_Process -Filter "Name = 'win.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*slip-notes*' } |
    ForEach-Object {
        Write-Host "  停止 win.exe (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host "== 停止 1430 端口监听者（vite；按 PID 杀，绝不全杀 node）=="
Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "  停止 1430 端口进程 (PID $($_.OwningProcess))"
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 2

# 确保 Rust 工具链在 PATH（pwsh 的 PATH 可能不含 ~/.cargo/bin，dev.sh 时代靠 bash 配置）
if (-not [bool](Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
        $env:PATH = "$cargoBin;$env:PATH"
        Write-Host "== 已补充 cargo 路径: $cargoBin =="
    } else {
        Write-Host "警告：找不到 cargo（$cargoBin），请先安装 Rust 工具链"
    }
}

Write-Host "== 启动 tauri dev =="
$log = Join-Path $env:TEMP 'tauri_dev.log'
# cmd 包装：npx 是 .cmd 脚本，Start-Process 直接调 npx 不可靠；stdout/stderr 合并进单一日志
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx tauri dev > `"$log`" 2>&1" `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru

Write-Host ""
Write-Host "已启动（包装进程 PID=$($proc.Id)，实际 tauri/cargo 子进程见日志）"
Write-Host "日志: $log"
Write-Host "查看: Get-Content -Wait $log    （或 tail -f，如果你有 git bash）"
Write-Host ""
Write-Host "手动停止（下次重启前不必手动停，本脚本会自动清理）："
Write-Host "  taskkill /F /IM win.exe"
Write-Host "  Stop-Process -Id (Get-NetTCPConnection -LocalPort 1430 -State Listen).OwningProcess -Force"
