// Q31 验收补充：真实鼠标行为验证（不是 SendMessage 模拟）
// 空白处真实光标 → WindowFromPoint 应落在桌面（explorer），而非 slip 窗口
// 卡片处真实光标 → 应落在 slip 画布窗口
import { connect } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const probePs = `param([int]$X, [int]$Y)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct SlipPOINT { public int X; public int Y; }
public static class SlipProbe {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(SlipPOINT p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetClassName(IntPtr h, System.Text.StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out SlipRECT r);
    public struct SlipRECT { public int Left, Top, Right, Bottom; }
}
"@
[void][SlipProbe]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 200
$p = New-Object SlipPOINT
$p.X = $X; $p.Y = $Y
$h = [SlipProbe]::WindowFromPoint($p)
$pid_ = 0
[void][SlipProbe]::GetWindowThreadProcessId($h, [ref]$pid_)
$cls = New-Object System.Text.StringBuilder 128
[void][SlipProbe]::GetClassName($h, $cls, 128)
$proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
Write-Output "hwnd=$($h.ToInt64()) pid=$pid_ proc=$($proc.ProcessName) cls=$($cls.ToString())"
`;

writeFileSync(join(__dir, "_probe.ps1"), probePs, "utf8");

const canvas = await connect("slip-canvas-0");
// 用 nchittest 一样的坐标（屏幕物理）
const info = await canvas.eval(`(() => {
  const el = document.querySelector('.note-card');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width/2, cy: r.top + r.height/2, dpr: window.devicePixelRatio || 1 };
})()`);
const winPhys = await canvas.eval("JSON.parse(JSON.stringify(window.__slipDebug.winPhys()))");
const px = Math.round(winPhys.x + info.cx * info.dpr);
const py = Math.round(winPhys.y + info.cy * info.dpr);

const blank = await canvas.eval(`(() => {
  const cards = [...document.querySelectorAll('.note-card')].map(e => e.getBoundingClientRect());
  for (let y = window.innerHeight - 40; y > 0; y -= 20)
    for (let x = window.innerWidth - 40; x > 0; x -= 20)
      if (!cards.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return { x, y };
})()`);
const bx = Math.round(winPhys.x + blank.x * info.dpr);
const by = Math.round(winPhys.y + blank.y * info.dpr);

const probe = (x, y) => execFileSync("powershell", ["-NoProfile","-ExecutionPolicy","Bypass","-File", join(__dir,"_probe.ps1"), String(x), String(y)], { encoding: "utf8" }).trim();

const cardWin = probe(px, py);
const blankWin = probe(bx, by);
console.log(`卡片处(真实光标 ${px},${py}) → ${cardWin}`);
console.log(`空白处(真实光标 ${bx},${by}) → ${blankWin}`);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fails++; };
ok(cardWin.includes("proc=win") || cardWin.includes("cls=Chrome"), `卡片处光标下应为 slip(win/Chrome) → ${cardWin}`);
ok(!blankWin.includes("proc=win"), `空白处不能是 slip 窗口（穿透成功）→ ${blankWin}`);

console.log(fails === 0 ? "\n真实鼠标穿透验收 ✅" : `\n${fails} 项失败 ❌`);
process.exit(fails === 0 ? 0 : 1);