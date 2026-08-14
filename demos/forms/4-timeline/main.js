/* ============================================================
   方案四 · 时间流
   时间即秩序：按更新时间自动排布，新鲜度决定形态
   新鲜(<1天)大卡 · 近期(<7天)中卡 · 更久标题条 · 完成/逾期沉入抽屉
   ============================================================ */
const S = window.Slip;
const {
  defaultNotes, COLORS, buildNote, popIn, shake,
  stage, mountShell, rand,
} = S;

const STAGE = stage();
const DRAWER_MAX = 14;

let notes = [];
let byId = {};
const pinnedIds = new Set();
const expanded = new Set();
let drawerOpen = false;

const noteDone = (n) => n.items && n.items.length > 0 && n.items.every((i) => i.done);
const noteOverdue = (n) => n.items && n.items.some((i) => i.time && i.overdue && !i.done);

function zoneOf(n) {
  if (pinnedIds.has(n.id)) return "pinned";
  if (noteDone(n) || noteOverdue(n)) return "drawer";
  if (n.age < 1) return "fresh";
  if (n.age < 7) return "recent";
  return "old";
}

/* ================= 渲染 ================= */
function render(opt) {
  const dur = (opt && opt.dur) || 500;
  const first = new Map();
  STAGE.querySelectorAll("[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (!first.has(k)) first.set(k, el.getBoundingClientRect());
  });
  buildDOM();
  let idx = 0;
  for (const el of STAGE.querySelectorAll("[data-key]")) {
    const k = el.dataset.key;
    const f = first.get(k);
    if (!f) { popIn(el, Math.min(idx * 16, 240)); idx++; continue; }
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) { idx++; continue; }
    el.animate([
      { transform: "translate(" + dx + "px," + dy + "px)" },
      { transform: "none" },
    ], { duration: dur, easing: "cubic-bezier(.3,.7,.3,1)", delay: Math.min(idx * 16, 240), fill: "backwards" });
    idx++;
  }
}

function buildDOM() {
  byId = {};
  for (const n of notes) byId[n.id] = n;
  STAGE.innerHTML = "";
  const flow = document.createElement("div");
  flow.id = "flow";
  flow.appendChild(zoneEl("📌 置顶", "pinned"));
  flow.appendChild(zoneEl("✨ 新鲜 · <1 天", "fresh"));
  flow.appendChild(zoneEl("📄 近期 · <7 天", "recent"));
  flow.appendChild(zoneEl("🗞 旧 · ≥7 天", "old"));
  flow.appendChild(drawerEl());
  STAGE.appendChild(flow);
}

function zoneEl(label, zone) {
  const items = notes.filter((n) => zoneOf(n) === zone).sort((a, b) => a.age - b.age);
  const wrap = document.createElement("div");
  wrap.className = "zone";
  if (!items.length) return wrap;
  const head = document.createElement("div");
  head.className = "zone-head";
  head.innerHTML = label + '<span class="cnt">' + items.length + "</span>";
  wrap.appendChild(head);
  for (const n of items) {
    wrap.appendChild(noteEl(n, zone));
  }
  return wrap;
}

function noteEl(n, zone) {
  const isCard = (zone === "drawer" ? expanded.has(n.id) : (n.age < 1 || pinnedIds.has(n.id) || expanded.has(n.id)));
  const mode = isCard ? "card" : n.age < 7 ? "board" : "strip";
  const el = buildNote(n, mode);
  el.dataset.key = "n" + n.id;
  if (mode === "card") {
    const bar = document.createElement("span");
    bar.className = "tl-bar";
    bar.innerHTML = pinnedIds.has(n.id)
      ? '<span class="tl-btn pin on" title="取消置顶">📌</span><span class="tl-btn" title="收起">⤓</span>'
      : '<span class="tl-btn pin" title="置顶">📌</span><span class="tl-btn" title="收起">⤓</span>';
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".tl-btn");
      if (!btn) return;
      if (btn.classList.contains("pin")) {
        if (pinnedIds.has(n.id)) pinnedIds.delete(n.id); else pinnedIds.add(n.id);
        render();
      } else {
        expanded.delete(n.id);
        render();
      }
    });
    el.appendChild(bar);
  } else {
    // 条/中卡：点击展开
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("cb")) { toggleItem(n.id, e.target); return; }
      expanded.add(n.id);
      render();
    });
  }
  // 卡片本体交互
  el.addEventListener("click", (e) => {
    if (e.target.closest(".tl-bar")) return;
    if (e.target.classList.contains("cb")) { toggleItem(n.id, e.target); return; }
    const body = el.querySelector(".body");
    if (body && mode === "card") {
      if (editingEl && editingEl !== body) editingEl.contentEditable = "false";
      editingEl = body;
      body.contentEditable = "true";
      body.focus();
    }
  });
  return el;
}
let editingEl = null;
document.addEventListener("pointerdown", (e) => {
  if (editingEl && !e.target.closest(".note")) {
    editingEl.contentEditable = "false";
    editingEl = null;
  }
});

function drawerEl() {
  const items = notes.filter((n) => zoneOf(n) === "drawer").sort((a, b) => a.age - b.age);
  const wrap = document.createElement("div");
  wrap.className = "zone";
  if (!items.length) return wrap;
  const head = document.createElement("div");
  head.className = "zone-head drawer-head";
  head.innerHTML = "📥 抽屉 · " + items.length + (drawerOpen ? "（点击收起）" : "（点击展开）");
  head.addEventListener("click", () => { drawerOpen = !drawerOpen; render(); });
  wrap.appendChild(head);
  if (drawerOpen) {
    const list = document.createElement("div");
    list.className = "drawer-list";
    for (const n of items.slice(0, DRAWER_MAX)) {
      list.appendChild(noteEl(n, "drawer"));
    }
    if (items.length > DRAWER_MAX) {
      const more = document.createElement("div");
      more.className = "drawer-more";
      more.textContent = "还有 " + (items.length - DRAWER_MAX) + " 张…";
      list.appendChild(more);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function toggleItem(noteId, cbEl) {
  const n = byId[noteId];
  const li = cbEl.closest("li");
  const idx = Array.from(li.parentElement.children).indexOf(li);
  if (!n.items || !n.items[idx]) return;
  n.items[idx].done = !n.items[idx].done;
  li.classList.toggle("done", n.items[idx].done);
  if (noteDone(n)) render(); // 完成 → 沉入抽屉
}

/* ================= 控制 ================= */
function addNote() {
  notes.push(S.N({ title: "新便签", text: "刚记的，会随时间自动从大卡变成标题条", color: COLORS[Math.floor(rand(COLORS.length))], age: 0 }));
  render();
}
function warp(d) {
  for (const n of notes) n.age = Math.max(0, n.age + d);
  render();
}
function reset() {
  notes = defaultNotes();
  pinnedIds.clear();
  expanded.clear();
  drawerOpen = false;
  pinnedIds.add(notes.find((n) => n.title === "纸筏").id);
  render({ dur: 300 });
}

mountShell({
  title: "方案四 · 时间流",
  sub: "零整理：时间即秩序 · 点条展开 · 📌 置顶 · 完成/逾期自动沉入抽屉",
  buttons: [
    { label: "↺ 重置", fn: reset },
    { label: "➕ 新便签", fn: addNote },
    { label: "⏩ +2 天", fn: () => warp(2) },
  ],
});

reset();
