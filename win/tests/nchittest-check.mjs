// Q31 验收：WM_NCHITTEST 命中穿透真实验证（OS 层）
// 运行：tauri dev 运行中 → node tests/nchittest-check.mjs
// 从 canvas-0 前端取卡片矩形（CSS）× dpr + 窗口原点 → 屏幕物理坐标，
// 分别对「卡片中心」「卡片外空白」「窗口外」打 SendMessage(WM_NCHITTEST)，
// 断言：卡片=HTCLIENT(1)，空白=HTTRANSPARENT(-1)。
import { connect } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync as wfs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const HTCLIENT = 1;
const HTTRANSPARENT = -1;

function psh(scriptPath, args) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(__dir, scriptPath), ...args.map(String)],
    { encoding: "utf8" },
  ).trim();
}

// 写临时查找脚本
const findPs = null; // 不再用 PowerShell 枚举（改用 state.hwnds）

const canvas = await connect("slip-canvas-0");
const info = await canvas.eval(`(() => {
  const el = document.querySelector('.note-card');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dpr: window.devicePixelRatio || 1 };
})()`);
if (!info) throw new Error("canvas-0 无卡片（state 未就绪）");
const { cx, cy, dpr } = info;
const winPhys = await canvas.eval("JSON.parse(JSON.stringify(window.__slipDebug.winPhys()))");
console.log(`卡片 CSS 中心=(${cx},${cy}) dpr=${dpr} 窗口原点(物理)=${JSON.stringify(winPhys)}`);

const px = Math.round(winPhys.x + cx * dpr);
const py = Math.round(winPhys.y + cy * dpr);

const blank = await canvas.eval(`(() => {
  const cards = [...document.querySelectorAll('.note-card')].map(e => e.getBoundingClientRect());
  const cw = window.innerWidth, ch = window.innerHeight;
  for (let y = ch - 40; y > 0; y -= 20) {
    for (let x = cw - 40; x > 0; x -= 20) {
      if (!cards.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return { x, y };
    }
  }
  return null;
})()`);
if (!blank) throw new Error("找不到空白点");
const bx = Math.round(winPhys.x + blank.x * dpr);
const by = Math.round(winPhys.y + blank.y * dpr);

const hwnd = (await canvas.state())?.hwnds?.["canvas-0"] ?? 0;
console.log(`canvas-0 hwnd=${hwnd}`);
if (!hwnd) throw new Error("state 无 hwnd（窗口未就绪 / 广播未到）");

const rCard = await psh("nchittest-check.ps1", [hwnd, px, py]);
const rBlank = await psh("nchittest-check.ps1", [hwnd, bx, by]);
const rOutside = await psh("nchittest-check.ps1", [hwnd, winPhys.x - 50, winPhys.y - 50]);

console.log(`卡片中心 (${px},${py}) → ${rCard}`);
console.log(`空白点   (${bx},${by}) → ${rBlank}`);
console.log(`窗口外   (${winPhys.x - 50},${winPhys.y - 50}) → ${rOutside}`);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fails++; };
const codeOf = (s) => { const m = s.match(/NCHITTEST=(-?\d+)/); return m ? parseInt(m[1], 10) : NaN; };

const c1 = codeOf(rCard);
const c2 = codeOf(rBlank);
const c3 = codeOf(rOutside);
ok(c1 === HTCLIENT, `卡片中心应 HTCLIENT(${HTCLIENT}) → 实际: ${rCard}`);
ok(c2 === HTTRANSPARENT, `空白点应 HTTRANSPARENT(${HTTRANSPARENT}) → 实际: ${rBlank}`);
ok(c3 === HTTRANSPARENT, `窗口外应 HTTRANSPARENT(${HTTRANSPARENT}) → 实际: ${rOutside}`);

console.log(fails === 0 ? "\nQ31 命中穿透真实验收 ✅" : `\n${fails} 项失败 ❌`);
process.exit(fails === 0 ? 0 : 1);