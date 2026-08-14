/* ============================================================
   方案二 · 边缘收纳坞
   所有便签收纳为右缘紧凑条（占位最小）
   点条弹出 · 拖出钉墙 · 拖回收纳
   ============================================================ */
const S = window.Slip;
const {
  defaultNotes, COLORS, buildNote, popIn, shake,
  makeDraggable, stage, mountShell, clamp, rand, esc, relTime, stripTitle,
} = S;

const STAGE = stage();
const DOCK_W = 232;
const CARD_W = 210;

let notes = [];
let pinned = [];     // { noteId, x, y }
let popoutId = null;
let dockEl = null;

const noteById = () => { const m = {}; for (const n of notes) m[n.id] = n; return m; };
let byId = {};

/* ================= 渲染 ================= */
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
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    el.animate([
      { transform: "translate(" + dx + "px," + dy + "px)" },
      { transform: "none" },
    ], { duration: dur, easing: "cubic-bezier(.3,1.4,.4,1)", fill: "backwards" });
  }
}

function buildDOM() {
  byId = {};
  for (const n of notes) byId[n.id] = n;
  STAGE.innerHTML = "";
  if (dockEl) dockEl.remove();
  // 钉墙卡
  for (const p of pinned) {
    const el = buildNote(byId[p.noteId], "card");
    el.dataset.key = "n" + p.noteId;
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
    el.style.width = CARD_W + "px";
    const btn = document.createElement("span");
    btn.className = "unpin-btn";
    btn.textContent = "📥";
    btn.title = "收回坞里";
    el.appendChild(btn);
    bindPinned(el, p);
    STAGE.appendChild(el);
  }
  buildDock();
  buildPopout();
}

function buildDock() {
  dockEl = document.createElement("div");
  dockEl.id = "dock";
  const today = notes.filter((n) => n.urgent || (n.items && n.items.some((i) => i.urgent || i.time))).sort((a, b) => a.age - b.age);
  const rest = notes.filter((n) => !today.includes(n)).sort((a, b) => a.age - b.age);
  const head = (t, icon) => {
    const h = document.createElement("div");
    h.className = "dock-head";
    h.innerHTML = "<span>" + icon + "</span>" + t;
    return h;
  };
  const body = document.createElement("div");
  body.className = "dock-body";
  if (today.length) {
    body.appendChild(head("今日 · " + today.length, "🔥"));
    for (const n of today) body.appendChild(stripEl(n));
  }
  body.appendChild(head("全部 · " + rest.length, "🗂"));
  for (const n of rest) body.appendChild(stripEl(n));
  dockEl.appendChild(body);
  document.body.appendChild(dockEl);
}

function stripEl(n) {
  const el = buildNote(n, "strip");
  el.dataset.key = "d" + n.id;
  el.classList.add("dock-strip");
  makeDraggable(el, {
    onStart(e, st) {
      const r = el.getBoundingClientRect();
      st.grabX = e.clientX - r.left;
      st.grabY = e.clientY - r.top;
      ghostEl = ghostClone(el, r);
      el.classList.add("dim");
    },
    onMove(x, y, dx, dy, e, st) {
      ghostEl.style.left = x - st.grabX + "px";
      ghostEl.style.top = y - st.grabY + "px";
    },
    onEnd(x, y, dx, dy, e, st) {
      ghostEl.remove();
      el.classList.remove("dim");
      const dockRect = dockEl.getBoundingClientRect();
      if (x < dockRect.left - 70) {
        const note = byId[n.id];
        pinned = pinned.filter((p) => p.noteId !== n.id);
        pinned.push({ noteId: n.id, x: clamp(x - st.grabX, 8, dockRect.left - CARD_W - 12), y: clamp(y - st.grabY, 8, window.innerHeight - 120) });
        popoutId = null;
        render();
      }
    },
    onCancel() { if (ghostEl) ghostEl.remove(); el.classList.remove("dim"); },
    onClick() {
      popoutId = popoutId === n.id ? null : n.id;
      render();
    },
  });
  return el;
}

let ghostEl = null;
function ghostClone(src, r) {
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

function bindPinned(el, p) {
  makeDraggable(el, {
    onStart(e, st) {
      const r = el.getBoundingClientRect();
      st.grabX = e.clientX - r.left;
      st.grabY = e.clientY - r.top;
      ghostEl = ghostClone(el, r);
      el.classList.add("dim");
    },
    onMove(x, y, dx, dy, e, st) {
      ghostEl.style.left = x - st.grabX + "px";
      ghostEl.style.top = y - st.grabY + "px";
    },
    onEnd(x, y, dx, dy, e, st) {
      ghostEl.remove();
      el.classList.remove("dim");
      const dockRect = dockEl.getBoundingClientRect();
      if (x > dockRect.left - 20 && x < dockRect.right + 20) {
        pinned = pinned.filter((q) => q !== p);
        render();
      } else {
        p.x = clamp(x - st.grabX, 8, dockRect.left - CARD_W - 12);
        p.y = clamp(y - st.grabY, 8, window.innerHeight - 120);
      }
    },
    onCancel() { if (ghostEl) ghostEl.remove(); el.classList.remove("dim"); },
    onClick(e) {
      if (e.target.closest(".unpin-btn")) { pinned = pinned.filter((q) => q !== p); render(); return; }
      if (e.target.classList.contains("cb")) {
        const li = e.target.closest("li");
        const n = byId[p.noteId];
        const idx = Array.from(li.parentElement.children).indexOf(li);
        if (n.items && n.items[idx]) n.items[idx].done = !n.items[idx].done;
        li.classList.toggle("done", n.items[idx].done);
        return;
      }
      const body = el.querySelector(".body");
      if (body) { body.contentEditable = "true"; body.focus(); body.onblur = () => (body.contentEditable = "false"); }
    },
  });
}

/* ================= 弹卡 ================= */
function buildPopout() {
  if (!popoutId) return;
  const n = byId[popoutId];
  const dockRect = dockEl.getBoundingClientRect();
  const strip = dockEl.querySelector('[data-note="' + n.id + '"]');
  let top = 70;
  if (strip) top = strip.getBoundingClientRect().top;
  top = clamp(top, 70, window.innerHeight - 300);
  const el = buildNote(n, "card");
  el.className = "note popout";
  el.style.left = dockRect.left - 12 - 236 + "px";
  el.style.top = top + "px";
  el.style.width = "236px";
  const close = document.createElement("span");
  close.className = "popout-x";
  close.textContent = "✕";
  el.appendChild(close);
  el.onclick = (e) => {
    if (e.target.closest(".popout-x")) { popoutId = null; render(); }
    else if (e.target.classList.contains("cb")) {
      const li = e.target.closest("li");
      const idx = Array.from(li.parentElement.children).indexOf(li);
      if (n.items && n.items[idx]) n.items[idx].done = !n.items[idx].done;
      li.classList.toggle("done", n.items[idx].done);
    }
  };
  STAGE.appendChild(el);
  popIn(el);
}

/* ================= 控制 ================= */
function addNote() {
  notes.push(S.N({ title: "新便签", text: "刚记的，点击弹出预览", color: COLORS[Math.floor(rand(COLORS.length))], age: 0 }));
  render();
}
function reset() {
  notes = defaultNotes();
  pinned = [];
  popoutId = null;
  render({ dur: 300 });
}

mountShell({
  title: "方案二 · 边缘收纳坞",
  sub: "点条弹出预览 · 拖出钉墙 · 拖回（或 📥）收回",
  buttons: [
    { label: "↺ 重置", fn: reset },
    { label: "➕ 新便签", fn: addNote },
  ],
});

document.addEventListener("pointerdown", (e) => {
  if (popoutId && !e.target.closest(".popout") && !e.target.closest(".dock-strip")) {
    popoutId = null;
    render();
  }
});

// 初始化
notes = defaultNotes();
render({ dur: 0 });
