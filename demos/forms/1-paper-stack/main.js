/* ============================================================
   方案一 · 智能纸堆墙（最完善 demo）
   拖 = 移动（带磁吸）· 快速松手 = 叠放 · 停留 800ms = 合并（九宫格）
   旧便签自动折叠 · 今日聚合卡 · 纸堆扇形展开（边缘防溢出）
   ============================================================ */
const S = window.Slip;
const {
  defaultNotes, PALETTE, COLORS, ROTS, buildNote, popIn, shake,
  makeDraggable, dropAt, magnet, todayItems, stage, mountShell,
  clamp, rand, esc,
} = S;

const STAGE = stage();
const MAX_STACK = 9;    // 纸堆上限
const MAX_PANES = 9;    // 合并容器上限（九宫格）
const COLLAPSE_DAYS = 3;
const MAGNET_T = 16;
const HOLD_MS = 800;
const CARD_W = 210;

let notes = [];
let cards = [];          // {id, kind:'leaf'|'stack'|'container', ...}
let uid = 0;
let byId = {};
let cardEls = new Map(); // key -> el
let dragging = false;
let hoverStack = null;
let editing = null;
let ghostEl = null;
let dragSource = null;   // { card, srcNodes:[...] }
let previewKey = null;

/* ================= 卡片模型 ================= */
function mkLeaf(noteId, x, y, collapsed) {
  return { id: "c" + (++uid), kind: "leaf", noteId, x, y, w: CARD_W, h: 0, collapsed: collapsed ?? null };
}
function mkStack(memberIds, x, y) {
  return { id: "c" + (++uid), kind: "stack", x, y, w: CARD_W, h: 0, members: memberIds, spread: false };
}
function mkContainer(x, y, dir, children) {
  return { id: "c" + (++uid), kind: "container", x, y, w: CARD_W, h: 0, dir, children };
}
const nodeCount = (n) => (n.kind === "leaf" ? 1 : n.children.reduce((s, c) => s + nodeCount(c), 0));
const nodeHas = (n, noteId) =>
  n.kind === "leaf" ? n.noteId === noteId : n.children.some((c) => nodeHas(c, noteId));
function nodeAt(card, path) {
  let n = { kind: "container", children: card.children };
  for (const i of path) n = n.children[i];
  return n;
}
function replaceNode(card, path, node) {
  if (!path.length) { card.children = [node]; return; }
  let cur = card;
  for (let i = 0; i < path.length - 1; i++) cur = cur.children[path[i]];
  cur.children[path[i]] = node;
}
function findNodePath(card, node) {
  if (!card.children) return null;
  for (let i = 0; i < card.children.length; i++) {
    const c = card.children[i];
    if (c === node) return [i];
    const sub = c.kind === "container" ? findNodePath(c, node) : null;
    if (sub) return [i, ...sub];
  }
  return null;
}

/* ================= 初始化布局 ================= */
function initCards() {
  const find = (t) => notes.find((n) => n.title === t);
  const used = new Set();
  const units = [
    { kind: "container", dir: "row", kids: ["纸筏", "VPS 备份"] },
    { kind: "stack", kids: ["九宫格上限", "撕纸线", "磁吸阈值"] },
    { kind: "stack", kids: ["端口", "SSH"] },
  ];
  for (const u of units) for (const t of u.kids) used.add(t);
  for (const n of notes) if (!used.has(n.title)) units.push({ kind: "leaf", title: n.title });

  const SLOTS = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++) {
      if (r === 4 && c === 4) break;
      SLOTS.push({ x: 46 + c * 236 + ((r * 7) % 17) - 8, y: 252 + r * 148 + ((c * 5) % 13) - 6 });
    }
  const JITTER = [[0,0],[10,-4],[-6,6],[14,2],[-12,-2],[4,10],[-4,-10],[8,-8],[-10,4],[0,8],[-8,0],[6,-6],[-6,8],[10,2],[-14,0],[2,-10],[12,6],[-2,4],[0,-12],[-10,-6],[6,2],[-4,12],[8,0],[2,-2]];

  cards = [];
  units.forEach((u, i) => {
    const slot = SLOTS[i] || { x: 46 + (i % 5) * 236, y: 96 + 940 };
    const x = slot.x + (JITTER[i] ? JITTER[i][0] : 0);
    const y = slot.y + (JITTER[i] ? JITTER[i][1] : 0);
    if (u.kind === "container") {
      cards.push(mkContainer(x, y, u.dir, u.kids.map((t) => ({ kind: "leaf", noteId: find(t).id }))));
    } else if (u.kind === "stack") {
      cards.push(mkStack(u.kids.map((t) => find(t).id), x, y));
    } else {
      cards.push(mkLeaf(find(u.title).id, x, y));
    }
  });
}

/* ================= 渲染（带 key 的 FLIP） ================= */
function collapsedOf(card) {
  const n = byId[card.noteId];
  if (!n || n.urgent) return false;
  return card.collapsed ?? (n.age >= COLLAPSE_DAYS);
}
function fanOffsets(card, i) {
  const count = card.members.length;
  const right = card.x + CARD_W * 2 > window.innerWidth - 30;
  const bottom = card.y + 170 * count > window.innerHeight - 70;
  const dx = right ? -i * 26 : i * 26;
  const dy = bottom ? -i * 9 : i * 9;
  const rot = right ? -i * 2 : i * 2;
  return { dx, dy, rot };
}

function render(opt) {
  const dur = (opt && opt.dur) || 430;
  const first = new Map();
  STAGE.querySelectorAll("[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (!first.has(k)) first.set(k, el.getBoundingClientRect());
  });
  buildDOM();
  for (const el of STAGE.querySelectorAll("[data-key]")) {
    const k = el.dataset.key;
    const f = first.get(k);
    if (!f) { popIn(el); continue; }
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    const sx = f.width / l.width, sy = f.height / l.height;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .02 && Math.abs(sy - 1) < .02) continue;
    el.animate([
      { transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")", transformOrigin: "0 0" },
      { transform: "none", transformOrigin: "0 0" },
    ], { duration: dur, easing: "cubic-bezier(.25,.8,.35,1)", fill: "backwards" });
  }
}

function buildDOM() {
  byId = {};
  for (const n of notes) byId[n.id] = n;
  STAGE.innerHTML = "";
  cardEls.clear();
  for (const card of cards) {
    for (const el of buildCardEl(card)) {
      STAGE.appendChild(el);
      cardEls.set(el.dataset.key, el);
    }
  }
  buildToday();
}

function buildCardEl(card) {
  if (card.kind === "leaf") return [buildLeaf(card)];
  if (card.kind === "stack") return buildStack(card);
  return [buildContainer(card)];
}

/* ---------- 单张便签 ---------- */
function buildLeaf(card) {
  const n = byId[card.noteId];
  const collapsed = collapsedOf(card);
  const el = buildNote(n, collapsed ? "strip" : "card");
  el.dataset.key = "n" + n.id;
  el.dataset.card = card.id;
  el.dataset.drop = "leaf";
  el.style.left = card.x + "px";
  el.style.top = card.y + "px";
  el.style.width = card.w + "px";
  if (!collapsed && !n.urgent) {
    const btn = document.createElement("span");
    btn.className = "collapse-btn";
    btn.textContent = "⤓";
    btn.title = "收起为标题条";
    el.appendChild(btn);
  }
  bindLeafDrag(el, card);
  return el;
}

/* ---------- 纸堆 ---------- */
function buildStack(card) {
  const spread = card.spread || hoverStack === card.id;
  const els = [];
  card.members.forEach((noteId, i) => {
    const n = byId[noteId];
    const el = buildNote(n, "card");
    el.dataset.key = "n" + noteId;
    el.dataset.card = card.id;
    el.dataset.drop = "stack";
    el.style.width = CARD_W + "px";
    const o = spread ? fanOffsets(card, i) : { dx: 0, dy: 0, rot: 0 };
    el.style.left = card.x + o.dx + "px";
    el.style.top = card.y + o.dy + "px";
    el.style.zIndex = 10 + i;
    if (spread && o.rot) el.style.transform = "rotate(" + o.rot + "deg)";
    if (!spread && i < card.members.length - 1) el.style.pointerEvents = "none";
    if (i === card.members.length - 1) {
      // 顶卡：厚度边 + 角标
      if (!spread) {
        const edge = PALETTE[n.color].edge;
        let sh = "";
        for (let k = 1; k <= Math.min(card.members.length - 1, 8); k++) sh += "0 " + k + "px 0 " + edge + ",";
        el.style.boxShadow = sh + "0 10px 20px rgba(92,72,18,.28)";
      }
      if (card.members.length > 1) {
        const b = document.createElement("span");
        b.className = "s-badge";
        b.textContent = "×" + card.members.length;
        el.appendChild(b);
      }
    }
    bindMember(el, card, noteId, i);
    els.push(el);
  });
  return els;
}

/* ---------- 合并容器 ---------- */
function buildContainer(card) {
  const el = document.createElement("div");
  el.className = "container";
  el.dataset.key = "c" + card.id;
  el.dataset.card = card.id;
  el.style.left = card.x + "px";
  el.style.top = card.y + "px";
  el.style.width = card.w + "px";
  el.setAttribute("dir", card.dir);

  const bar = document.createElement("div");
  bar.className = "c-bar";
  bar.textContent = "🗂 合并 · " + nodeCount(card) + " 张";
  el.appendChild(bar);
  bindBarDrag(bar, card);

  const panes = document.createElement("div");
  panes.className = "c-panes";
  buildPanes(card.children, panes, [], card);
  el.appendChild(panes);
  return el;
}
function buildPanes(children, wrap, path, card) {
  children.forEach((node, i) => {
    if (node.kind === "leaf") {
      const n = byId[node.noteId];
      const pane = buildNote(n, "card");
      pane.classList.add("pane");
      pane.dataset.drop = "pane";
      pane.dataset.card = card.id;
      pane.dataset.path = path.concat(i).join(",");
      bindPaneDrag(pane, card, path.concat(i));
      wrap.appendChild(pane);
    } else {
      const sub = document.createElement("div");
      sub.className = "container";
      sub.style.position = "static";
      sub.style.boxShadow = "none";
      sub.setAttribute("dir", node.dir);
      const subPanes = document.createElement("div");
      subPanes.className = "c-panes";
      buildPanes(node.children, subPanes, path.concat(i), card);
      sub.appendChild(subPanes);
      wrap.appendChild(sub);
    }
  });
}

/* ================= 拖拽 ================= */
function ghostClone(src) {
  const r = src.getBoundingClientRect();
  const g = src.cloneNode(true);
  g.classList.add("drag-ghost");
  g.style.position = "fixed";
  g.style.left = r.left + "px";
  g.style.top = r.top + "px";
  g.style.width = r.width + "px";
  g.style.height = r.height + "px";
  g.style.margin = "0";
  g.style.pointerEvents = "none";
  g.style.zIndex = "300";
  g.querySelectorAll(".s-badge").forEach((b) => b.remove());
  document.body.appendChild(g);
  return g;
}
function startGhost(e, src, st) {
  const r = src.getBoundingClientRect();
  st.grabX = e.clientX - r.left;
  st.grabY = e.clientY - r.top;
  ghostEl = ghostClone(src);
  src.classList.add("dim");
}
function clearGhost() {
  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
}
function moveGhost(px, py, st, src) {
  let nx = clamp(px - st.grabX, 4, window.innerWidth - 90);
  let ny = clamp(py - st.grabY, 4, window.innerHeight - 120);
  const rect = { left: nx, top: ny, right: nx + ghostEl.offsetWidth, bottom: ny + ghostEl.offsetHeight };
  const others = [];
  for (const el of cardEls.values()) {
    if (el === src || src.contains(el)) continue;
    const r = el.getBoundingClientRect();
    others.push(r);
  }
  const m = magnet(rect, others, MAGNET_T);
  if (m) { nx += m.dx; ny += m.dy; drawMag(m); } else clearMag();
  ghostEl.style.left = nx + "px";
  ghostEl.style.top = ny + "px";
  st.ghostX = nx;
  st.ghostY = ny;
  updateDropHint(px, py, st, src);
}
function drawMag(m) {
  clearMag();
  if (m.vline !== null) {
    const v = document.createElement("div");
    v.className = "mag-line v";
    v.style.left = m.vline + "px";
    document.body.appendChild(v);
  }
  if (m.hline !== null) {
    const h = document.createElement("div");
    h.className = "mag-line h";
    h.style.top = m.hline + "px";
    document.body.appendChild(h);
  }
}
function clearMag() {
  document.querySelectorAll(".mag-line").forEach((el) => el.remove());
}

/* 叠放/合并提示 */
function updateDropHint(px, py, st, src) {
  document.querySelectorAll(".drop-stack,.drop-merge").forEach((el) => el.classList.remove("drop-stack", "drop-merge"));
  const excl = src.closest(".container") || src.closest("[data-card]") || src;
  const over = dropAt(px, py, excl);
  if (!over) { clearPreview(); st.holdTarget = null; return; }
  if (st.holdTarget !== over) { st.holdTarget = over; st.holdAt = performance.now(); clearPreview(); }
  const hold = performance.now() - st.holdAt;
  const cardEl = over.closest("[data-card]");
  if (hold >= HOLD_MS) {
    if (over.dataset.drop === "pane" || over.dataset.drop === "leaf" || over.dataset.drop === "stack") {
      cardEl.classList.add("drop-merge");
      showMergePreview(over, px, py);
    }
  } else if (over.dataset.drop !== "pane") {
    cardEl.classList.add("drop-stack");
  }
}
function showMergePreview(over, px, py) {
  const r = over.getBoundingClientRect();
  const top = py < r.top + r.height / 2;
  const left = px < r.left + r.width / 2;
  let dir, sourceFirst;
  if (top && left) { dir = "col"; sourceFirst = true; }
  else if (top) { dir = "row"; sourceFirst = false; }
  else if (left) { dir = "row"; sourceFirst = true; }
  else { dir = "col"; sourceFirst = false; }
  const key = over.dataset.card + ":" + over.dataset.path + ":" + dir + ":" + sourceFirst;
  if (key === previewKey) return;
  previewKey = key;
  const pv = document.createElement("div");
  pv.className = "merge-preview";
  pv.style.left = r.left + "px";
  pv.style.top = r.top + "px";
  pv.style.width = r.width + "px";
  pv.style.height = r.height + "px";
  if (dir === "col") {
    const line = document.createElement("div");
    line.className = "mp-line";
    line.style.left = "0"; line.style.right = "0";
    line.style.top = r.height / 2 - 1 + "px"; line.style.height = "2px";
    pv.appendChild(line);
    const g = document.createElement("div");
    g.className = "mp-ghost";
    g.style.left = "2px"; g.style.right = "2px";
    g.style.top = sourceFirst ? "2px" : r.height / 2 + "px";
    g.style.height = r.height / 2 - 4 + "px";
    pv.appendChild(g);
  } else {
    const line = document.createElement("div");
    line.className = "mp-line";
    line.style.top = "0"; line.style.bottom = "0";
    line.style.left = r.width / 2 - 1 + "px"; line.style.width = "2px";
    pv.appendChild(line);
    const g = document.createElement("div");
    g.className = "mp-ghost";
    g.style.top = "2px"; g.style.bottom = "2px";
    g.style.left = sourceFirst ? "2px" : r.width / 2 + "px";
    g.style.width = r.width / 2 - 4 + "px";
    pv.appendChild(g);
  }
  const tip = document.createElement("div");
  tip.className = "mp-tip";
  tip.textContent = "松开 = 合并" + (dir === "col" ? "（上下）" : "（左右）");
  tip.style.top = "-26px";
  tip.style.left = "50%";
  pv.appendChild(tip);
  STAGE.appendChild(pv);
}
function clearPreview() {
  previewKey = null;
  STAGE.querySelectorAll(".merge-preview").forEach((el) => el.remove());
}

/* ---------- 结束拖拽 ---------- */
function finishDrag(px, py, st, srcEl) {
  clearGhost();
  clearMag();
  document.querySelectorAll(".drop-stack,.drop-merge").forEach((el) => el.classList.remove("drop-stack", "drop-merge"));
  const srcCardEl = srcEl.closest(".container") || srcEl.closest("[data-card]");
  const over = dropAt(px, py, srcCardEl || srcEl);
  if (over) {
    const hold = st.holdTarget === over ? performance.now() - st.holdAt : 0;
    if (hold >= HOLD_MS) tryMerge(over, px, py);
    else if (over.dataset.drop !== "pane") tryStack(over);
    else shake(over.closest(".container"));
  } else if (dragSource) {
    dragSource.card.x = st.ghostX;
    dragSource.card.y = st.ghostY;
  }
  dragSource = null;
  render();
}

/* ---------- 叠放 ---------- */
function tryStack(over) {
  const src = dragSource;
  if (!src) return;
  if (src.srcNodes.some((n) => n.kind !== "leaf")) { shake(over.closest("[data-card]")); return; }
  const target = cards.find((c) => c.id === over.dataset.card);
  if (!target) return;
  if (target.kind === "container") { shake(over.closest(".container")); return; }
  const add = src.srcNodes.map((n) => n.noteId);
  if (target.kind === "stack") {
    const add2 = add.filter((id) => !target.members.includes(id));
    if (!add2.length) return;
    if (target.members.length + add2.length > MAX_STACK) { shake(over.closest("[data-card]")); return; }
    target.members.push(...add2);
    removeCard(src.card);
    return;
  }
  const add2 = add.filter((id) => id !== target.noteId);
  if (!add2.length) return;
  if (add2.length + 1 > MAX_STACK) { shake(over.closest("[data-card]")); return; }
  const st = mkStack([target.noteId, ...add2], target.x, target.y);
  replaceCard(target, st);
  removeCard(src.card);
}

/* ---------- 合并（容器分割） ---------- */
function tryMerge(over, px, py) {
  const src = dragSource;
  if (!src) return;
  const target = cards.find((c) => c.id === over.dataset.card);
  if (!target) return;
  const r = over.getBoundingClientRect();
  const top = py < r.top + r.height / 2;
  const left = px < r.left + r.width / 2;
  let dir, sourceFirst;
  if (top && left) { dir = "col"; sourceFirst = true; }
  else if (top) { dir = "row"; sourceFirst = false; }
  else if (left) { dir = "row"; sourceFirst = true; }
  else { dir = "col"; sourceFirst = false; }

  const tgtNodes = over.dataset.drop === "stack"
    ? target.members.map((id) => ({ kind: "leaf", noteId: id }))
    : over.dataset.drop === "pane"
      ? [nodeAt(target, over.dataset.path.split(",").map(Number))]
      : [{ kind: "leaf", noteId: target.noteId }];
  // 去重：源里的便签已在目标中则不重复合并
  const tgtIds = new Set(tgtNodes.map((n) => (n.kind === "leaf" ? n.noteId : null)));
  const srcNodes = src.srcNodes.filter((n) => (n.kind === "leaf" ? !tgtIds.has(n.noteId) : true));
  if (!srcNodes.length) return;
  const total = tgtNodes.reduce((s, n) => s + nodeCount(n), 0) + srcNodes.reduce((s, n) => s + nodeCount(n), 0);
  if (total > MAX_PANES) {
    shake(over.closest("[data-card]"));
    return;
  }
  const merged = {
    kind: "container", dir,
    children: sourceFirst ? [...srcNodes, ...tgtNodes] : [...tgtNodes, ...srcNodes],
  };
  if (over.dataset.drop === "pane") {
    const path = over.dataset.path.split(",").map(Number);
    replaceNode(target, path, merged);
  } else {
    const idx = cards.indexOf(target);
    cards[idx] = mkContainer(target.x, target.y, dir, merged.children);
  }
  removeCard(src.card);
}

/* ---------- 辅助 ---------- */
function pointerInEls(e, els) {
  for (const m of els) {
    const r = m.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
  }
  return false;
}
function removeCard(card) {
  cards = cards.filter((c) => c !== card);
}
function replaceCard(oldCard, newCard) {
  const idx = cards.indexOf(oldCard);
  if (idx >= 0) cards[idx] = newCard;
}

/* ================= 各卡拖拽绑定 ================= */
function bindLeafDrag(el, card) {
  makeDraggable(el, {
    onStart(e, st) {
      dragging = true;
      dragSource = { card, srcNodes: [{ kind: "leaf", noteId: card.noteId }] };
      startGhost(e, el, st);
    },
    onMove(x, y, dx, dy, e, st) { moveGhost(x, y, st, el); },
    onEnd(x, y, dx, dy, e, st) {
      dragging = false;
      finishDrag(x, y, st, el);
    },
    onCancel() { dragging = false; clearGhost(); clearMag(); clearPreview(); },
    onClick(e) {
      if (e.target.closest(".collapse-btn")) { card.collapsed = true; render(); return; }
      if (e.target.classList.contains("cb")) { toggleItem(card.noteId, e.target); return; }
      if (collapsedOf(card)) { card.collapsed = false; render(); return; }
      startEdit(el);
    },
  });
}
function bindMember(el, card, noteId, i) {
  el.addEventListener("mouseenter", () => {
    if (!dragging && !card.spread && card.members.length > 1 && hoverStack !== card.id) { hoverStack = card.id; render(); }
  });
  el.addEventListener("mouseleave", (e) => {
    if (hoverStack === card.id && !pointerInEls(e, el.closest("#stage").querySelectorAll('[data-card="' + card.id + '"]'))) {
      hoverStack = null;
      render();
    }
  });
  makeDraggable(el, {
    onStart(e, st) {
      dragging = true;
      if (card.spread || hoverStack === card.id) {
        // 分离成员
        const leaf = mkLeaf(noteId, card.x, card.y);
        cards.push(leaf);
        card.members = card.members.filter((id) => id !== noteId);
        if (card.members.length === 1) {
          const rest = card.members[0];
          cards = cards.filter((c) => c !== card);
          cards.push(mkLeaf(rest, card.x, card.y));
        }
        dragSource = { card: leaf, srcNodes: [{ kind: "leaf", noteId }] };
      } else {
        // 移动整堆
        dragSource = { card, srcNodes: card.members.map((id) => ({ kind: "leaf", noteId: id })) };
      }
      startGhost(e, el, st);
    },
    onMove(x, y, dx, dy, e, st) { moveGhost(x, y, st, el); },
    onEnd(x, y, dx, dy, e, st) {
      dragging = false;
      finishDrag(x, y, st, el);
    },
    onCancel() { dragging = false; clearGhost(); clearMag(); clearPreview(); },
    onClick(e) {
      if (e.target.classList.contains("cb")) { toggleItem(noteId, e.target); return; }
      if (!card.spread) { card.spread = true; render(); return; }
      startEdit(el);
    },
  });
}
function bindBarDrag(bar, card) {
  makeDraggable(bar, {
    onStart(e, st) {
      dragging = true;
      const src = cardEls.get("c" + card.id);
      dragSource = { card, srcNodes: [{ kind: "container", children: card.children, dir: card.dir }] };
      startGhost(e, src, st);
    },
    onMove(x, y, dx, dy, e, st) { moveGhost(x, y, st, bar); },
    onEnd(x, y, dx, dy, e, st) {
      dragging = false;
      finishDrag(x, y, st, bar);
    },
    onCancel() { dragging = false; clearGhost(); clearMag(); clearPreview(); },
  });
}
function bindPaneDrag(pane, card, path) {
  makeDraggable(pane, {
    onStart(e, st) {
      dragging = true;
      const node = nodeAt(card, path);
      // 解除合并
      const parent = path.length === 1 ? card : nodeAt(card, path.slice(0, -1));
      const rest = parent.children.filter((_, i) => i !== path[path.length - 1]);
      const leaf = node.kind === "leaf"
        ? mkLeaf(node.noteId, card.x, card.y)
        : mkContainer(card.x, card.y, node.dir, node.children);
      cards.push(leaf);
      if (rest.length === 1) {
        // 只剩一个 → 容器溶解（嵌套时只溶解父节点）
        const only = rest[0];
        if (path.length === 1) {
          const solo = only.kind === "leaf"
            ? mkLeaf(only.noteId, card.x, card.y)
            : mkContainer(card.x, card.y, only.dir, only.children);
          replaceCard(card, solo);
        } else {
          const parentPath = path.slice(0, -1);
          const grand = parentPath.length === 1 ? card : nodeAt(card, parentPath.slice(0, -1));
          grand.children[parentPath[parentPath.length - 1]] = only;
        }
      } else {
        parent.children = rest;
      }
      dragSource = { card: leaf, srcNodes: [node] };
      startGhost(e, pane, st);
    },
    onMove(x, y, dx, dy, e, st) { moveGhost(x, y, st, pane); },
    onEnd(x, y, dx, dy, e, st) {
      dragging = false;
      finishDrag(x, y, st, pane);
    },
    onCancel() { dragging = false; clearGhost(); clearMag(); clearPreview(); },
    onClick(e) {
      if (e.target.classList.contains("cb")) { toggleItem(nodeAt(card, path).noteId, e.target); return; }
      startEdit(pane);
    },
  });
}

/* ================= 编辑 / 勾选 ================= */
function toggleItem(noteId, cbEl) {
  const n = byId[noteId];
  const li = cbEl.closest("li");
  const idx = Array.from(li.parentElement.children).indexOf(li);
  if (n.items && n.items[idx]) n.items[idx].done = !n.items[idx].done;
  li.classList.toggle("done", n.items[idx].done);
}
function startEdit(el) {
  const body = el.querySelector(".body");
  if (!body) return; // checklist 卡无正文，不编辑
  if (editing) endEdit();
  editing = { el, body };
  body.contentEditable = "true";
  body.focus();
  el.classList.add("editing");
}
function endEdit() {
  if (!editing) return;
  editing.body.contentEditable = "false";
  editing.el.classList.remove("editing");
  editing = null;
}
document.addEventListener("pointerdown", (e) => {
  if (editing && !editing.el.contains(e.target)) endEdit();
  if (e.target === STAGE) {
    let changed = false;
    for (const c of cards) if (c.kind === "stack" && c.spread) { c.spread = false; changed = true; }
    if (changed) render();
  }
});

/* ================= 今日聚合卡 ================= */
function buildToday() {
  const items = todayItems(notes);
  const t = document.createElement("div");
  t.className = "today-card";
  const head = document.createElement("div");
  head.className = "t-title";
  head.innerHTML = '<span class="dot"></span>今日 · ' + items.length + " 项";
  t.appendChild(head);
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "t-empty";
    e.textContent = "没有紧急 / 定时项";
    t.appendChild(e);
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "t-item" + (it.overdue ? " ov" : "");
    row.innerHTML = '<span class="ic">' + it.icon + "</span><span>" + esc(it.label) + "</span>";
    row.onclick = () => jumpTo(it.note);
    t.appendChild(row);
  }
  STAGE.appendChild(t);
}
function jumpTo(note) {
  for (const card of cards) {
    let hit = null;
    if (card.kind === "leaf" && card.noteId === note.id) hit = card;
    else if (card.kind === "stack" && card.members.includes(note.id)) { card.spread = true; hit = card; }
    else if (card.kind === "container" && card.children.some((c) => nodeHas(c, note.id))) hit = card;
    if (hit) {
      render();
      const el = hit.kind === "stack" ? cardEls.get("n" + note.id) : cardEls.get(hit.kind === "leaf" ? "n" + note.id : "c" + hit.id);
      if (el) { el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 3000); }
      return;
    }
  }
}

/* ================= 控制 ================= */
function addNote() {
  const color = COLORS[Math.floor(rand(COLORS.length))];
  const note = S.N({ title: "新便签", text: "点击编辑，或拖到别的便签上试试", color, age: 0 });
  notes.push(note);
  // 找空槽
  let x = 46, y = 96;
  outer:
  for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) {
    const cx = 46 + c * 236, cy = 96 + r * 156;
    const occ = cards.some((k) => Math.abs(k.x - cx) < 120 && Math.abs(k.y - cy) < 90);
    if (!occ) { x = cx; y = cy; break outer; }
  }
  cards.push(mkLeaf(note.id, x, y));
  render();
}
function warp(d) {
  for (const n of notes) n.age = Math.max(0, n.age + d);
  render();
}
function reset() {
  notes = defaultNotes();
  uid = 0;
  initCards();
  render({ dur: 300 });
}

mountShell({
  title: "方案一 · 智能纸堆墙",
  sub: "拖 = 移动（磁吸对齐） · 快速松手 = 叠放 · 停留 800ms = 合并 · 旧便签自动折叠",
  buttons: [
    { label: "↺ 重置", fn: reset },
    { label: "➕ 新便签", fn: addNote },
    { label: "⏩ +2 天", fn: () => warp(2) },
    { label: "⏪ -2 天", fn: () => warp(-2) },
  ],
});

// 初始化
notes = defaultNotes();
initCards();
render({ dur: 0 });
