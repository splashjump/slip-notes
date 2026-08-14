/* ============================================================
   方案三 · 分区展板
   四列：收件箱 / 今日 / 进行中 / 归档
   自动分区 + 拖拽换列 + FLIP 重排 + 叠放/合并（九宫格）
   ============================================================ */
const S = window.Slip;
const {
  defaultNotes, COLORS, buildNote, popIn, shake,
  makeDraggable, dropAt, stage, mountShell, clamp, rand,
} = S;

const STAGE = stage();
const MAX_PANES = 9;
const MAX_STACK = 9;
const HOLD_MS = 800;

let notes = [];
let byId = {};
let uid = 0;
let cols = { inbox: [], today: [], doing: [], done: [] };
const COL_DEFS = [
  { id: "inbox", title: "收件箱", icon: "📥" },
  { id: "today", title: "今日", icon: "🔥" },
  { id: "doing", title: "进行中", icon: "🛠" },
  { id: "done", title: "归档", icon: "🗄" },
];
let dragSource = null;
let ghostEl = null;

/* ================= 分区规则 ================= */
const noteDone = (n) => n.items && n.items.length > 0 && n.items.every((i) => i.done);
const noteHot = (n) => n.urgent || (n.items && n.items.some((i) => (i.urgent || i.time) && !i.done));
function zone(n) {
  if (noteDone(n)) return "done";
  if (noteHot(n)) return "today";
  if (n.age < 1) return "inbox";
  return "doing";
}

/* ================= 模型 ================= */
function mkStack(members) { return { id: "k" + (++uid), kind: "stack", members }; }
function mkContainer(dir, children) { return { id: "m" + (++uid), kind: "container", dir, children }; }
const nodeCount = (n) => (n.kind === "leaf" ? 1 : n.children.reduce((s, c) => s + nodeCount(c), 0));
function nodeAt(card, path) {
  let n = { kind: "container", children: card.children };
  for (const i of path) n = n.children[i];
  return n;
}
function replaceNode(card, path, node) {
  let cur = card;
  for (let i = 0; i < path.length - 1; i++) cur = cur.children[path[i]];
  cur.children[path[path.length - 1]] = node;
}

/* ================= 初始化 ================= */
function initBoard() {
  uid = 0;
  cols = { inbox: [], today: [], doing: [], done: [] };
  for (const n of notes) cols[zone(n)].push({ id: "l" + (++uid), kind: "leaf", noteId: n.id });
}

/* ================= 渲染 ================= */
function render(opt) {
  const dur = (opt && opt.dur) || 430;
  const first = new Map();
  STAGE.querySelectorAll("[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (!first.has(k)) first.set(k, el.getBoundingClientRect());
  });
  buildDOM();
  const els = STAGE.querySelectorAll("[data-key]");
  els.forEach((el, idx) => {
    const k = el.dataset.key;
    const f = first.get(k);
    if (!f) { popIn(el, Math.min(idx * 14, 200)); return; }
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
    el.animate([
      { transform: "translate(" + dx + "px," + dy + "px)" },
      { transform: "none" },
    ], { duration: dur, easing: "cubic-bezier(.25,.8,.35,1)", fill: "backwards" });
  });
}

function buildDOM() {
  byId = {};
  for (const n of notes) byId[n.id] = n;
  STAGE.innerHTML = "";
  // 独立便签自动分区（堆/容器保持手动位置）
  for (const key of Object.keys(cols)) {
    const manual = cols[key].filter((c) => c.kind !== "leaf");
    const leaves = cols[key].filter((c) => c.kind === "leaf");
    const byZone = { inbox: [], today: [], doing: [], done: [] };
    for (const l of leaves) byZone[zone(byId[l.noteId])].push(l);
    cols[key] = [...byZone[key], ...manual];
  }
  const wrap = document.createElement("div");
  wrap.id = "board";
  for (const def of COL_DEFS) {
    const col = document.createElement("div");
    col.className = "col";
    col.dataset.col = def.id;
    const head = document.createElement("div");
    head.className = "col-head";
    head.innerHTML = "<span>" + def.icon + "</span>" + def.title + '<span class="cnt">' + cols[def.id].length + "</span>";
    col.appendChild(head);
    const body = document.createElement("div");
    body.className = "col-body";
    for (const card of cols[def.id]) body.appendChild(buildCardEl(card));
    col.appendChild(body);
    wrap.appendChild(col);
  }
  STAGE.appendChild(wrap);
}

function buildCardEl(card) {
  if (card.kind === "leaf") {
    const el = buildNote(byId[card.noteId], "board");
    el.dataset.key = "n" + card.noteId;
    el.dataset.card = card.id;
    el.dataset.drop = "card";
    bindCardDrag(el, card);
    return el;
  }
  if (card.kind === "stack") {
    const top = byId[card.members[0]];
    const el = buildNote(top, "board");
    el.dataset.key = "st" + card.id;
    el.dataset.card = card.id;
    el.dataset.drop = "card";
    if (card.members.length > 1) {
      const b = document.createElement("span");
      b.className = "s-badge";
      b.textContent = "×" + card.members.length;
      el.appendChild(b);
    }
    bindCardDrag(el, card);
    return el;
  }
  // container
  const el = document.createElement("div");
  el.className = "container mini";
  el.dataset.key = "c" + card.id;
  el.style.position = "static";
  el.setAttribute("dir", card.dir);
  const bar = document.createElement("div");
  bar.className = "c-bar";
  bar.textContent = "🗂 合并 · " + nodeCount(card) + " 张";
  bar.dataset.card = card.id;
  bar.dataset.drop = "card";
  bindCardDrag(bar, card);
  el.appendChild(bar);
  const panes = document.createElement("div");
  panes.className = "c-panes";
  card.children.forEach((node, i) => panes.appendChild(buildPane(node, [i], card)));
  el.appendChild(panes);
  return el;
}

function buildPane(node, path, card) {
  if (node.kind === "leaf") {
    const pane = buildNote(byId[node.noteId], "card");
    pane.classList.add("pane");
    pane.dataset.drop = "pane";
    pane.dataset.card = card.id;
    pane.dataset.path = path.join(",");
    pane.addEventListener("click", (e) => {
      if (e.target.classList.contains("cb")) toggleItem(node.noteId, e.target);
    });
    return pane;
  }
  const sub = document.createElement("div");
  sub.className = "container mini";
  sub.style.position = "static";
  sub.style.boxShadow = "none";
  sub.setAttribute("dir", node.dir);
  const panes = document.createElement("div");
  panes.className = "c-panes";
  node.children.forEach((c, i) => panes.appendChild(buildPane(c, path.concat(i), card)));
  sub.appendChild(panes);
  return sub;
}

/* ================= 拖拽 ================= */
function bindCardDrag(el, card) {
  makeDraggable(el, {
    onStart(e, st) {
      const r = el.getBoundingClientRect();
      st.grabX = e.clientX - r.left;
      st.grabY = e.clientY - r.top;
      ghostEl = cloneGhost(el, r);
      el.classList.add("dim");
      dragSource = { card };
    },
    onMove(x, y, dx, dy, e, st) {
      ghostEl.style.left = x - st.grabX + "px";
      ghostEl.style.top = y - st.grabY + "px";
      // 目标高亮
      document.querySelectorAll(".drop-stack,.drop-merge").forEach((q) => q.classList.remove("drop-stack", "drop-merge"));
      const excl = el.closest(".container") || el.closest("[data-card]");
      const over = dropAt(x, y, excl || el);
      if (over) {
        if (st.holdTarget !== over) { st.holdTarget = over; st.holdAt = performance.now(); }
        const hold = performance.now() - st.holdAt;
        const ce = over.closest("[data-card]") || over;
        ce.classList.add(hold >= HOLD_MS ? "drop-merge" : "drop-stack");
      }
    },
    onEnd(x, y, dx, dy, e, st) {
      ghostEl.remove();
      ghostEl = null;
      el.classList.remove("dim");
      document.querySelectorAll(".drop-stack,.drop-merge").forEach((q) => q.classList.remove("drop-stack", "drop-merge"));
      const src = dragSource;
      dragSource = null;
      if (!src) { render(); return; }
      const excl = el.closest(".container") || el.closest("[data-card]");
      const over = dropAt(x, y, excl || el);
      const hold = st.holdTarget === over ? performance.now() - st.holdAt : 0;
      if (over && hold >= HOLD_MS && (over.dataset.drop === "card" || over.dataset.drop === "pane")) {
        doMerge(over, x, y);
      } else if (over && over.dataset.drop === "card") {
        doStack(over);
      } else if (over) {
        shake(over.closest(".container") || over);
      } else {
        insertAt(x, y);
      }
      render();
    },
    onCancel() {
      if (ghostEl) ghostEl.remove();
      ghostEl = null;
      el.classList.remove("dim");
    },
    onClick(e) {
      if (e.target.classList.contains("cb")) { toggleItem(card.noteId, e.target); return; }
      if (card.kind === "stack" && card.members.length > 1) {
        card.members.push(card.members.shift());
        render();
      }
    },
  });
}

function cloneGhost(src, r) {
  const g = src.cloneNode(true);
  g.classList.add("drag-ghost");
  g.style.position = "fixed";
  g.style.left = r.left + "px";
  g.style.top = r.top + "px";
  g.style.width = r.width + "px";
  g.style.height = r.height + "px";
  g.style.pointerEvents = "none";
  document.body.appendChild(g);
  return g;
}

function toggleItem(noteId, cbEl) {
  const n = byId[noteId];
  const li = cbEl.closest("li");
  const idx = Array.from(li.parentElement.children).indexOf(li);
  if (!n.items || !n.items[idx]) return;
  n.items[idx].done = !n.items[idx].done;
  li.classList.toggle("done", n.items[idx].done);
  if (noteDone(n)) render(); // 全部完成 → 自动飞向归档
}

/* ---------- 插入列 ---------- */
function columnAt(px) {
  for (const el of document.querySelectorAll(".col")) {
    const r = el.getBoundingClientRect();
    if (px >= r.left && px <= r.right) return el;
  }
  return null;
}
function removeFromCol(card) {
  for (const key of Object.keys(cols)) cols[key] = cols[key].filter((c) => c !== card);
}
function insertAt(px, py) {
  const src = dragSource;
  if (!src) return;
  let fromCol = null;
  for (const key of Object.keys(cols)) {
    if (cols[key].indexOf(src.card) >= 0) fromCol = key;
  }
  removeFromCol(src.card);
  let colEl = columnAt(px);
  if (!colEl && fromCol) colEl = document.querySelector('.col[data-col="' + fromCol + '"]');
  if (!colEl) { cols[fromCol || "inbox"].push(src.card); return; }
  const colId = colEl.dataset.col;
  let idx = cols[colId].length;
  const els = Array.from(colEl.querySelectorAll("[data-card]")).filter((q) => !q.classList.contains("dim"));
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (py < r.top + r.height / 2) { idx = i; break; }
  }
  cols[colId].splice(idx, 0, src.card);
}

/* ---------- 叠放 ---------- */
function doStack(over) {
  const src = dragSource;
  if (!src) return;
  const target = cardById(over.dataset.card);
  if (!target) return;
  if (target.kind === "container") { shake(over.closest(".container") || over); return; }
  const srcNodes = src.card.kind === "leaf" ? [{ kind: "leaf", noteId: src.card.noteId }]
    : src.card.kind === "stack" ? src.card.members.map((id) => ({ kind: "leaf", noteId: id }))
    : null;
  if (!srcNodes) { shake(over.closest(".container") || over); return; }
  const add = srcNodes.map((n) => n.noteId);
  if (target.kind === "stack") {
    const add2 = add.filter((id) => !target.members.includes(id));
    if (!add2.length) return;
    if (target.members.length + add2.length > MAX_STACK) { shake(over); return; }
    target.members.push(...add2);
  } else {
    const add2 = add.filter((id) => id !== target.noteId);
    if (!add2.length) return;
    if (add2.length + 1 > MAX_STACK) { shake(over); return; }
    const st = mkStack([target.noteId, ...add2]);
    replaceInCol(target, st);
  }
  removeFromCol(src.card);
}
function cardById(id) {
  for (const key of Object.keys(cols)) {
    const c = cols[key].find((q) => q.id === id);
    if (c) return c;
  }
  return null;
}
function replaceInCol(oldCard, newCard) {
  for (const key of Object.keys(cols)) {
    const idx = cols[key].indexOf(oldCard);
    if (idx >= 0) { cols[key][idx] = newCard; return; }
  }
}

/* ---------- 合并 ---------- */
function doMerge(over, px, py) {
  const src = dragSource;
  if (!src) return;
  const target = cardById(over.dataset.card);
  if (!target) return;
  const r = over.getBoundingClientRect();
  const top = py < r.top + r.height / 2;
  const left = px < r.left + r.width / 2;
  let dir, sourceFirst;
  if (top && left) { dir = "col"; sourceFirst = true; }
  else if (top) { dir = "row"; sourceFirst = false; }
  else if (left) { dir = "row"; sourceFirst = true; }
  else { dir = "col"; sourceFirst = false; }

  const srcNodes = src.card.kind === "leaf" ? [{ kind: "leaf", noteId: src.card.noteId }]
    : src.card.kind === "stack" ? src.card.members.map((id) => ({ kind: "leaf", noteId: id }))
    : [{ kind: "container", dir: src.card.dir, children: src.card.children }];
  const tgtNodes = over.dataset.drop === "pane"
    ? [nodeAt(target, over.dataset.path.split(",").map(Number))]
    : target.kind === "stack"
      ? target.members.map((id) => ({ kind: "leaf", noteId: id }))
      : target.kind === "container"
        ? null
        : [{ kind: "leaf", noteId: target.noteId }];
  if (!tgtNodes) { shake(over.closest(".container") || over); return; }
  const tgtIds = new Set(tgtNodes.filter((n) => n.kind === "leaf").map((n) => n.noteId));
  const srcF = srcNodes.filter((n) => (n.kind === "leaf" ? !tgtIds.has(n.noteId) : true));
  if (!srcF.length) return;
  const total = tgtNodes.reduce((s, n) => s + nodeCount(n), 0) + srcF.reduce((s, n) => s + nodeCount(n), 0);
  if (total > MAX_PANES) { shake(over.closest("[data-card]") || over); return; }
  const merged = { kind: "container", dir, children: sourceFirst ? [...srcF, ...tgtNodes] : [...tgtNodes, ...srcF] };
  if (over.dataset.drop === "pane") {
    replaceNode(target, over.dataset.path.split(",").map(Number), merged);
  } else {
    replaceInCol(target, mkContainer(dir, merged.children));
  }
  removeFromCol(src.card);
}

/* ================= 控制 ================= */
function addNote() {
  const color = COLORS[Math.floor(rand(COLORS.length))];
  notes.push(S.N({ title: "新便签", text: "点击编辑，或拖到别的便签上", color, age: 0 }));
  initBoard();
  render();
}
function warp(d) {
  for (const n of notes) n.age = Math.max(0, n.age + d);
  render();
}
function reset() {
  notes = defaultNotes();
  initBoard();
  render({ dur: 300 });
}

mountShell({
  title: "方案三 · 分区展板",
  sub: "自动分区 · 拖拽换列重排 · 快速松手 = 叠放 · 停留 = 合并 · 勾满自动归档",
  buttons: [
    { label: "↺ 重置", fn: reset },
    { label: "➕ 新便签", fn: addNote },
    { label: "⏩ +2 天", fn: () => warp(2) },
  ],
});

// 初始化
notes = defaultNotes();
initBoard();
render({ dur: 0 });
