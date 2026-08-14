// 形态先行冒烟测试（T1 手势 / T2 动作层 / T3 边界）—— CDP 连 tauri dev
// 运行：先 .\dev.ps1 启动（已开 9222），然后 node tests/smoke-form.mjs
// 覆盖：状态广播 / 动作层往返 / 方向语义 / 拖拽刷卡(dock/portal) / 叠放合并 /
//       自动收回(时间快进+未确认) / 视图开合 / 边栏收起 / 撤销批次

import { connect, check, waitFor, sleep } from "./cdp.mjs";

let canvas, sidebar, console_;
let failCount = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failCount += 1;
    check(false, msg);
  } else {
    check(true, msg);
  }
};

async function st() {
  return canvas.state();
}

async function act(name, args = {}, batch) {
  const r = await canvas.act(name, args, batch);
  if (!r.ok) throw new Error(`${name} 失败: ${r.error}`);
  return r;
}

// ---------------------------------------------------------------------------
// 0) 连接
// ---------------------------------------------------------------------------
console.log("== 连接 WebView2 目标 ==");
canvas = await connect("slip-canvas-0");
sidebar = await connect("slip-sidebar");
// Y8：控制台窗口可能被用户关闭 → 连接可选，失败仅警告，不阻塞其余检查
let consoleTarget = null;
try {
  console_ = await connect("slip — 控制台");
  consoleTarget = console_.target.title;
} catch (e) {
  console.warn(`⚠ 控制台未连接（跳过控制台相关检查）：${e.message}`);
}
console.log(
  `  canvas: ${canvas.target.title} / sidebar: ${sidebar.target.title} / console: ${consoleTarget ?? "（未连接）"}`,
);

// ---------------------------------------------------------------------------
// 1) 状态广播（T5：Rgn 跟随的前提 = state 事件）
// ---------------------------------------------------------------------------
console.log("\n== T5: 窗口壳 ==");
const s0 = await waitFor(async () => {
  const s = await st();
  return s?.notes?.length > 0 ? s : null;
});
// 预检：清掉上一轮残留（视图态 / 数据）
await act("view", { name: "recent", open: false });
await act("view", { name: "timeline", open: false });
await act("debug.reset", {}, "smoke-prefly");
const s1 = await waitFor(async () => {
  const ss = await st();
  return ss?.view === null && ss?.notes?.length >= 10 ? ss : null;
});
ok(s1.view === null, "初始无视图");
const wp = () => canvas.eval("JSON.stringify(window.__slipDebug.winPhys())");
ok(s1.notes.length >= 10, `state 事件到达（${s1.notes.length} 张便签）`);
ok(s1.monitors.length >= 1, `monitors 已枚举（${s1.monitors.length} 屏）`);
ok(s1.sidebarRect && s1.sidebarRect[2] > 200, `sidebarRect 已下发 ${JSON.stringify(s1.sidebarRect)}`);

// Y9：边栏渲染断言（上次 capabilities 漏配导致边栏空白，测试必须拦住）
await waitFor(async () => {
  const v = await sidebar.eval("!!document.querySelector('.sb-panel')");
  return v === true ? v : null;
});
const sbPanel = await sidebar.eval("!!document.querySelector('.sb-panel')");
const todayCount = await sidebar.eval("document.querySelectorAll('.today-entry').length");
const slotCount = await sidebar.eval("document.querySelectorAll('.slot').length");
const entryCount = await sidebar.eval("document.querySelectorAll('.sb-entry').length");
ok(sbPanel === true, "边栏 .sb-panel 已渲染（capabilities 授权生效）");
ok(todayCount > 0, `今日投影有条目（${todayCount}）`);
ok(slotCount >= 1, `档案格已渲染（${slotCount}）`);
ok(entryCount >= 1, `归档扁平条目已渲染（${entryCount}）`);

// ---------------------------------------------------------------------------
// 2) 动作层往返（T2 / T3 数据侧）
// ---------------------------------------------------------------------------
console.log("\n== T2: 动作层（AI 路径等价） ==");
const rCreate = await act("create", { text: "CDP 冒烟新建 📝", x: 500, y: 300 }, "smoke-create");
ok(rCreate.notes?.[0]?.mode === "desk", `create → 桌面卡 ${rCreate.notes?.[0]?.id}`);
const newId = rCreate.notes[0].id;

const rStore = await act("store", { id: newId }, "smoke-store");
ok(rStore.notes?.[0]?.mode === "archive", "store → 归档扁平条目");
ok(rStore.notes?.[0]?.last_desk_pos, "store 保留 lastDeskPos");

const rTake = await act("take", { id: newId, x: 600, y: 400 }, "smoke-take");
ok(rTake.notes?.[0]?.mode === "desk", "take → 回到桌面（显式落点）");

const rTag = await act("tag", { id: newId, tag: "urgent", v: true }, "smoke-tag");
ok(rTag.notes?.[0]?.urgent === true, "tag urgent=true");
await act("tag", { id: newId, tag: "timed", v: Date.now() + 3600_000 }, "smoke-tag2");
let s = await st();
ok(s.notes.find((n) => n.id === newId)?.timed != null, "tag timed 生效");
// 📄 清全部 = 两次 tag
await act("tag", { id: newId, tag: "urgent", v: false }, "smoke-tag3");
await act("tag", { id: newId, tag: "timed", v: null }, "smoke-tag4");
s = await st();
const n = s.notes.find((x) => x.id === newId);
ok(!n.urgent && n.timed === null, "清全部（urgent=false + timed=null）");

// 方向语义（T4）：向右 = 最近的 dock（主屏右缘边栏）
const sb0 = (await st()).sidebarRect;
await act("move", { id: newId, x: sb0[0] - 300, y: 400 }, "smoke-move-near");
const rDir = await act("move", { id: newId, direction: "right" }, "smoke-move-dir");
ok(rDir.notes?.[0]?.mode === "archive", "move(right) → store（方向语义）");
await act("take", { id: newId, x: 500, y: 300 }, "smoke-take2");

// 叠放/拆叠
const rStack = await act("stack", { ids: ["n11", "n12", newId], x: 1500, y: 320 }, "smoke-stack");
ok(rStack.ok, "stack 对齐同位置");
s = await st();
const stacked = s.notes.filter((x) => ["n11", "n12", newId].includes(x.id));
ok(stacked.every((x) => x.x === 1500 && x.y === 320), "stack 成员同位置");
ok(stacked.length === 3, "stack 3 张");
await act("unstack", { id: "n11" }, "smoke-unstack");
s = await st();
const still = s.notes.filter((x) => ["n11", "n12", newId].includes(x.id) && x.x === 1500 && x.y === 320);
// Y10：unstack 语义 = 散开同位置同伴，id 自身不动（drag_end 已更新其位置）
const n11 = s.notes.find((x) => x.id === "n11");
ok(n11.x === 1500 && n11.y === 320, "unstack：n11 自身留在原位（drag_end 已定位置）");
ok(still.length === 1, `unstack 级联散开（同位置成员 = 1，仅剩 n11 自身）`);
const n12After = s.notes.find((x) => x.id === "n12");
const newIdAfter = s.notes.find((x) => x.id === newId);
ok(n12After.x !== 1500 && newIdAfter.x !== 1500, "unstack：同伴已散开");

// 合并上限 4（容器不能再合并）
const rMerge = await act("merge", { ids: ["n1", "n2"], x: 700, y: 300 }, "smoke-merge");
ok(rMerge.notes?.[0]?.merge_tree, "merge → 容器");
const containerId = rMerge.notes[0].id;
const rMerge2 = await canvas.act("merge", { ids: [containerId, "n3"], x: 700, y: 300 }, "smoke-merge2");
ok(!rMerge2.ok, "合并容器不能再合并（上限 4 边界）");
await act("unmerge", { id: containerId }, "smoke-unmerge");
s = await st();
ok(s.notes.some((x) => x.id === "n1") && s.notes.some((x) => x.id === "n2"), "unmerge 还原成员");

// 撤销批次（快照式）
await act("create", { text: "待撤销", x: 100, y: 100 }, "smoke-undo");
const rUndo = await canvas.actRaw({ name: "undoBatch", args: { batchId: "smoke-undo" }, batch: "smoke-undo" });
ok(rUndo.ok, "undoBatch 执行");
s = await st();
ok(s.notes.every((x) => x.text !== "待撤销"), "撤销后便签消失（快照恢复）");

// 归档排序（Y2 语义）：toIndex = 归档扁平序列下标，不越界插入到档案格/桌面卡前
const rk1 = await act("create", { text: "排序卡 A", x: 420, y: 240 }, "smoke-reorder");
const rk2 = await act("create", { text: "排序卡 B", x: 460, y: 280 }, "smoke-reorder");
await act("store", { id: rk1.notes[0].id }, "smoke-reorder");
await act("store", { id: rk2.notes[0].id }, "smoke-reorder");
const flatIds0 = await sidebar.eval(
  "window.__slip.state().notes.filter(n => n.mode === 'archive' && !n.slot_id && !n.deleted).map(n => n.id)",
);
ok(
  flatIds0.slice(-2).join(",") === `${rk1.notes[0].id},${rk2.notes[0].id}`,
  "排序前：新卡在扁平列表末尾",
);
await act("reorder", { id: rk2.notes[0].id, toIndex: 0 }, "smoke-reorder");
s = await st();
const flatIds1 = s.notes
  .filter((n) => n.mode === "archive" && !n.slot_id && !n.deleted)
  .map((n) => n.id);
ok(flatIds1[0] === rk2.notes[0].id, "reorder(toIndex=0) → 拖到扁平列表头（未越界插入全局头部）");
const slotMembers = s.notes.filter((n) => n.slot_id).length;
ok(slotMembers === 3, "档案格成员不受 reorder 影响（仍为种子 3 张）");

// ---------------------------------------------------------------------------
// 3) 真实手势：拖拽到传送门（T1）—— 专用便签（避开 merge/unmerge 还原的 n1/n2）
// ---------------------------------------------------------------------------
console.log("\n== T1: 拖拽刷卡（真实 CDP 手势） ==");
const gNote = (
  await act("create", { text: "手势专用卡", x: 100, y: 100 }, "smoke-gesture")
).notes[0].id;
s = await st();
const mon = s.monitors[0];
const dpr = mon.dpi / 96;
const bandW = 662 * dpr;
const bandH = 96 * dpr;
const bandX = (mon.rect[0] + mon.rect[2]) / 2 - bandW / 2;
const bandTop = mon.rect[3] - 14 * dpr - bandH; // 与 CSS bottom:14px 对齐（Y4）
const slotY = bandTop + bandH / 2;
const targetCx = (bandX - mon.rect[0]) / dpr + (210 * dpr / dpr) * 0.25;
const slotCy = (slotY - mon.rect[1]) / dpr;

// 等状态收敛 + DOM 渲染 + FLIP 动画结束（WebView2 节流下动画可能明显慢于标称时长）
const waitNoteAt = (id, x, y) =>
  waitFor(async () => {
    const ss = await st();
    const n = ss?.notes.find((n) => n.id === id);
    if (!n || n.x !== x || n.y !== y) return null;
    const settled = await canvas.eval(
      `(() => { const el = document.querySelector('.note-card[data-id="${id}"]'); return el && el.getAnimations().length === 0 ? "yes" : null; })()`,
    );
    return settled === "yes" ? n : null;
  });
await waitNoteAt(gNote, 100, 100);

// 拖到 ⚡ 槽（便签左缘落在槽内 → 重叠 ≥ 50%）
const g1 = await waitNoteAt(gNote, 100, 100);
const gx1 = (g1.x + g1.w / 2 - mon.rect[0]) / dpr;
const gy1 = (g1.y + g1.h / 2 - mon.rect[1]) / dpr;
await canvas.mouse("mousePressed", gx1, gy1, { buttons: 1 });
await sleep(80);
for (let i = 1; i <= 16; i++) {
  await canvas.mouse("mouseMoved", gx1 + ((targetCx - gx1) * i) / 16, gy1 + ((slotCy - gy1) * i) / 16, { buttons: 1 });
  await sleep(16);
}
await canvas.mouse("mouseReleased", targetCx, slotCy, { buttons: 0 });
await sleep(500);
s = await st();
ok(s.notes.find((x) => x.id === gNote)?.urgent === true, "拖到 ⚡ 槽 → tag urgent 生效（划过 50% 触发）");

// 拖到边栏（dock）→ store（先移出光带，避免被 portal div 遮挡）
await act("move", { id: gNote, x: 300, y: 500 }, "smoke-move-out");
await waitNoteAt(gNote, 300, 500);
s = await st();
const sb = s.sidebarRect;
const dockX = (sb[0] + sb[2] / 2 - mon.rect[0]) / dpr;
const dockY = (sb[1] + 300 - mon.rect[1]) / dpr;
const g2 = s.notes.find((x) => x.id === gNote);
const gx2 = (g2.x + g2.w / 2 - mon.rect[0]) / dpr;
const gy2 = (g2.y + g2.h / 2 - mon.rect[1]) / dpr;
await canvas.drag(gx2, gy2, dockX, dockY, 14);
await sleep(500);
s = await st();
ok(s.notes.find((x) => x.id === gNote)?.mode === "archive", "拖到边栏 → store（dock 落点）");

// 拖回桌面
await act("take", { id: gNote, x: 300, y: 500 }, "smoke-back");
await waitNoteAt(gNote, 300, 500);
s = await st();
ok(s.notes.find((x) => x.id === gNote)?.mode === "desk", "take 回桌面");
// 清理手势专用卡
await act("delete", { id: gNote }, "smoke-gesture-del");

// Y9 缺口：⏰ 松手 → chips 弹层 → 选值生效（端到端）
console.log("\n== T1b: chips 弹层 =");
const chipNote = (
  await act("create", { text: "chips 专用卡", x: 400, y: 200 }, "smoke-chips")
).notes[0].id;
await waitNoteAt(chipNote, 400, 200);
s = await st();
const timedCx = (bandX - mon.rect[0]) / dpr + 210 + 16 + 210 / 2; // ⏰ 槽中心（slot0 宽 210 + gap 16 + slot1 半宽 105）
const cg = s.notes.find((x) => x.id === chipNote);
const cgx = (cg.x + cg.w / 2 - mon.rect[0]) / dpr;
const cgy = (cg.y + cg.h / 2 - mon.rect[1]) / dpr;
await canvas.drag(cgx, cgy, timedCx, slotCy, 14);
await sleep(400);
const chipCount = await canvas.eval("document.querySelectorAll('.chips .chip').length");
ok(chipCount >= 2, "chips 弹层出现");
const chipPos = await canvas.eval(
  "(() => { const el = document.querySelector('.chips .chip'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()",
);
if (chipPos) {
  await canvas.mouse("mousePressed", chipPos[0], chipPos[1], { buttons: 1 });
  await canvas.mouse("mouseReleased", chipPos[0], chipPos[1], { buttons: 0 });
  s = await waitFor(async () => {
    const ss = await st();
    return ss.notes.find((x) => x.id === chipNote)?.timed != null ? ss : null;
  });
  ok(s.notes.find((x) => x.id === chipNote)?.timed != null, "chips 选值 → timed 生效");
} else {
  ok(false, "chips 弹层渲染（未找到 .chip）");
}
await act("delete", { id: chipNote }, "smoke-chips-del");

// Y9 缺口：编辑（editText）/ 勾选（check）/ take 默认落点
console.log("\n== T1c: 编辑 / 勾选 / take 默认落点 =");
const editNote = (
  await act("create", { text: "编辑专用卡", x: 420, y: 240 }, "smoke-edit")
).notes[0].id;
await waitNoteAt(editNote, 420, 240);
const editPos = await canvas.eval(
  `(() => { const el = document.querySelector('.note-card[data-id="${editNote}"] .text'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
);
ok(!!editPos, "编辑目标 .text 定位");
if (editPos) {
  await canvas.click(editPos[0], editPos[1]);
  await sleep(200);
  await canvas.eval(
    `(() => { const el = document.querySelector('.note-card[data-id="${editNote}"] .text'); if (el) { el.focus(); document.execCommand('insertText', false, ' 已改'); } return true; })()`,
  );
  // 点画布空白 → endEdit 提交
  await canvas.click(60, 60);
  s = await waitFor(async () => {
    const ss = await st();
    return ss.notes.find((x) => x.id === editNote)?.text.includes("已改") ? ss : null;
  });
  ok(s.notes.find((x) => x.id === editNote)?.text.includes("已改"), "editText 提交生效");
}
// 勾选：n2 有清单项
const checkPos = await canvas.eval(
  `(() => { const el = document.querySelector('.note-card[data-id="n2"] .check-item input'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
);
ok(!!checkPos, "清单项定位");
if (checkPos) {
  await canvas.click(checkPos[0], checkPos[1]);
  s = await waitFor(async () => {
    const ss = await st();
    return ss.notes.find((x) => x.id === "n2")?.items?.[0]?.done === true ? ss : null;
  });
  ok(s.notes.find((x) => x.id === "n2")?.items[0]?.done === true, "check 勾选生效");
}
// take 默认落点（无 x/y → lastDeskPos 或边栏左侧空白）
const tDefault = (
  await act("create", { text: "take 默认落点卡", x: 500, y: 260 }, "smoke-tdefault")
).notes[0].id;
await act("store", { id: tDefault }, "smoke-tdefault");
const rTakeDefault = await act("take", { id: tDefault }, "smoke-tdefault");
s = await st();
const tdn = s.notes.find((x) => x.id === tDefault);
ok(rTakeDefault.notes[0]?.mode === "desk" && tdn.x > 0 && tdn.y > 0, `take 默认落点（${Math.round(tdn.x)},${Math.round(tdn.y)}）`);
await act("delete", { id: editNote }, "smoke-edit-del");
await act("delete", { id: tDefault }, "smoke-tdefault-del");

// ---------------------------------------------------------------------------
// 5) 视图开合（T4：抬升/遮罩/Rgn 全屏由 Rust 侧执行）
// ---------------------------------------------------------------------------
console.log("\n== T4: 视图 ==");
await act("view", { name: "recent", open: true }, "smoke-view");
s = await waitFor(async () => {
  const ss = await st();
  return ss?.view?.name === "recent" && ss.ephemeral.borrowing.length > 0 ? ss : null;
});
ok(s.view?.name === "recent", "view(recent) 打开");
ok(s.ephemeral.borrowing.length > 0, "视图打开 → 桌面卡借用中（portal 挂起）");
await act("view", { name: "recent", open: false });
s = await waitFor(async () => {
  const ss = await st();
  return ss?.view === null && ss.ephemeral.borrowing.length === 0 ? ss : null;
});
ok(s.view === null, "view 关闭");
ok(s.ephemeral.borrowing.length === 0, "借用态清除");

// 视图期间 portal 挂起：从时间线卡拖出（崩塌）到光带 → 不 tag
await act("view", { name: "timeline", open: true }, "smoke-view2");
await sleep(400); // 等时间线渲染
s = await st();
ok(s.view?.name === "timeline", "timeline 视图打开");
// G6：从 DOM 读第一张时间线卡实际位置（不再用魔法坐标）
const tlPos = await canvas.eval(
  "(() => { const el = document.querySelector('.view-body .note-card'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()",
);
ok(!!tlPos, "时间线第一张卡定位（DOM 读取）");
if (tlPos) {
  await canvas.drag(tlPos[0], tlPos[1], targetCx, slotCy, 12);
  await sleep(400);
}
// 时间线拖出超阈值 → 视图崩塌关闭
s = await st();
ok(s.view === null, "时间线拖出超阈值 → 视图崩塌关闭");
await act("view", { name: "timeline", open: false });
s = await st();
ok(!s.notes.find((x) => x.id === "n3")?.urgent, "视图打开时刷卡被挂起（不 tag）");


// ---------------------------------------------------------------------------
// 4) 自动收回（T3：时间快进 31 天 + 未确认）
// ---------------------------------------------------------------------------
console.log("\n== T3: 自动收回（30 天 + 未确认） ==");
await act("debug.fastForward", { days: 31 }, "smoke-ff");
s = await st();
const oldDesk = s.notes.filter((x) => x.mode === "desk" && !x.deleted);
// 快进前把 newId 变老：直接改 updated_at 不可行（Rust 侧），用 take 后等种子 n14 逻辑验证：
// 种子 n14（40 天旧）在启动 3s 后应已被自动收回 → 现在应处于 archive + unconfirmed
ok(s.notes.find((x) => x.id === "n14")?.mode === "archive", "n14（40 天旧）已自动收回");
ok(s.ephemeral.unconfirmed.includes("n14"), "n14 带未确认标记");
// 快进后所有桌面卡 updated_at 均已超过 30 天（时间偏移生效）→ 全被收回
ok(oldDesk.length === 0, `快进 31 天后桌面清空（${oldDesk.length} 张残留）`);
// 确认动作
await act("confirm", { id: "n14" });
s = await st();
ok(!s.ephemeral.unconfirmed.includes("n14"), "confirm 清除未确认");

// 时间偏移也影响逾期判定：n6 timed = 明天 → 快进后已逾期（store 时钟基准 = 真实时间 + timeOffset）
s = await st();
const n6 = s.notes.find((x) => x.id === "n6");
ok(typeof s.timeOffset === "number" && s.timeOffset >= 31 * 86_400_000, `timeOffset 已下发（${s.timeOffset}）`);
ok(n6.timed < Date.now() + s.timeOffset, "快进后 n6 定时已逾期（store 时钟基准）");
// Y5：前端逾期排序也跟随 store 时钟（今日投影把 n6 排到逾期置顶）
const todayFirst = await sidebar.eval(
  "(() => { const rows = [...document.querySelectorAll('.today-entry')]; return rows.length ? rows[0].dataset.id : null; })()",
);
ok(todayFirst != null && (await st()).notes.find((x) => x.id === todayFirst)?.timed != null, "前端逾期排序跟随 store 时钟（🔴 置顶）");

// ---------------------------------------------------------------------------
// 6) 边栏收起（T5：Rgn 跟随由 update-regions 上报）
// ---------------------------------------------------------------------------
console.log("\n== T5: 边栏收起 ==");
await act("collapse");
s = await st();
ok(s.sidebarCollapsed === true, "边栏收起状态同步");
await act("expand");
s = await st();
ok(s.sidebarCollapsed === false, "边栏展开恢复");

// ---------------------------------------------------------------------------
// 7) 清理：重置数据
// ---------------------------------------------------------------------------
await act("debug.reset", {}, "smoke-reset");
s = await st();
ok(s.notes.length >= 10 && s.ephemeral.unconfirmed.length === 0, "debug.reset 恢复种子数据");

console.log(`\n==== 冒烟结束：${failCount === 0 ? "全部通过 ✅" : failCount + " 项失败 ❌"} ====`);
process.exit(failCount === 0 ? 0 : 1);
