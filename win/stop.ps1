# win/stop.ps1 — 停止 slip 开发环境（dev.ps1/dev.sh 启动的整套进程）
# 用法（在 win/ 目录）：.\stop.ps1      （pwsh7 / Windows PowerShell 5.1 通用）
# 停止对象：
#   1. win.exe（仅本项目的编译产物，按可执行路径匹配 *slip-notes*）
#   2. tauri dev 包装进程（仅 cmd.exe / node.exe，按命令行匹配 *tauri dev*）
#      注意：限定进程名，防止误杀命令行里恰好含该字符串的其他进程（如调试 shell）
#   3. 14300 端口监听者（vite）
# 安全：绝不误杀 node/pi，只按 PID、进程名或命令行匹配杀

Write-Host "== 停止 win.exe（只杀本项目编译产物）=="
Get-CimInstance Win32_Process -Filter "Name = 'win.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*slip-notes*' } |
    ForEach-Object {
        Write-Host "  停止 win.exe (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host "== 停止 tauri dev 包装进程（cmd.exe/node.exe，命令行含 'tauri dev'）=="
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -in @('cmd.exe', 'node.exe') -and $_.CommandLine -like '*tauri dev*'
    } |
    ForEach-Object {
        Write-Host "  停止 $($_.Name) (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host "== 停止 14300 端口监听者（vite；按 PID 杀，绝不全杀 node）=="
Get-NetTCPConnection -LocalPort 14300 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "  停止 14300 端口进程 (PID $($_.OwningProcess))"
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "== 停止后检查 =="
$left = @()
Get-CimInstance Win32_Process -Filter "Name = 'win.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*slip-notes*' } |
    ForEach-Object { $left += "win.exe PID $($_.ProcessId)" }
if (Get-NetTCPConnection -LocalPort 14300 -State Listen -ErrorAction SilentlyContinue) {
    $left += '14300 端口仍有监听'
}
if ($left.Count -eq 0) {
    Write-Host "  全部已停止 ✔"
} else {
    Write-Host "  未完全停止：$($left -join '；')"
    Write-Host "  可手动执行：taskkill /F /IM win.exe（仅本项目产物，路径匹配 slip-notes）"
}
