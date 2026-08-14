/* ============================================================
   方案五 · 纸堆桌面
   桌面只剩堆：便签按颜色归堆，显示堆顶
   悬停扇形展开 · 点击摊开 · 拖出成新堆 · 拖入归堆
   ============================================================ */
const S = window.Slip;
const {
  defaultNotes, COLORS, PALETTE, buildNote, popIn, shake,
  makeDraggable, dropAt, todayItems, stage, mountShell,
  clamp, rand, esc,
} = S;

const STAGE = stage();
const MAX_DECK = 9;

let notes = [];
let byId = {};
let uid = 0;
let decks = [];      // {id, color, members:[noteId], x, y, spread}
let hoverDeck = null;
let ghostEl = null;
let dragSource = null;

/* ================= 初始化 ================= */
function initDecks() {
  uid = 0;
  decks = [];
  byId = {};
  for (const n of notes) byId[n.id] = n;
  const groups = {};
  for (const n of notes) {
    if (n.urgent || (n.items && n.items.some((i) => (i.urgent || i.time) && !i.done))) continue; // 紧急/定时进今日堆，不占桌面
    (groups[n.color] = groups[n.color] || []).push(n.id);
  }
  const colors = Object.keys(groups);
  const cols = Math.min(3, colors.length);
  colors.forEach((color, i) => {
    const members = groups[color].sort((a, b) => byId[a].age - byId[b].age);
    decks.push({
      id: "d" + (++uid),
      color,
      members,
      x: 330 + (i % cols) * 275,
      y: 240 + Math.floor(i / cols) * 210,
      spread: false,
    });
  });
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
    ], { duration: dur, easing: "cubic-bezier(.22,1.2,.36,1)", fill: "backwards" });
  }
}

function buildDOM() {
  byId = {};
  for (const n of notes) byId[n.id] = n;
  STAGE.innerHTML = "";
  buildTodayDeck();
  for (const deck of decks) {
    const wrap = document.createElement("div");
    wrap.className = "deck";
    wrap.style.left = deck.x + "px";
    wrap.style.top = deck.y + "px";
    const spread = deck.spread || hoverDeck === deck.id;
    deck.members.forEach((noteId, i) => {
      const n = byId[noteId];
      const el = buildNote(n, "card");
      el.dataset.key = "n" + noteId;
      el.dataset.drop = "member";
      el.dataset.deck = deck.id;
      el.style.width = "220px";
      const o = spread ? fanOff(deck, i) : { dx: 0, dy: 0, rot: 0 };
      el.style.left = o.dx + "px";
      el.style.top = o.dy + "px";
      el.style.zIndex = 10 + i;
      if (o.rot) el.style.transform = "rotate(" + o.rot + "deg)";
      if (!spread && i < deck.members.length - 1) el.style.pointerEvents = "none";
      if (i === deck.members.length - 1 && !spread && deck.members.length > 1) {
        const edge = PALETTE[n.color].edge;
        let sh = "";
        for (let k = 1; k <= Math.min(deck.members.length - 1, 8); k++) sh += "0 " + k + "px 0 " + edge + ",";
        el.style.boxShadow = sh + "0 10px 20px rgba(92,72,18,.28)";
        const b = document.createElement("span");
        b.className = "s-badge";
        b.textContent = "×" + deck.members.length;
        el.appendChild(b);
      }
      bindMember(el, deck, noteId, i);
      wrap.appendChild(el);
    });
    // 堆标签
    const label = document.createElement("div");
    label.className = "deck-label";
    label.textContent = PALETTE[deck.color].name + "纸堆 · " + deck.members.length + " 张";
    wrap.appendChild(label);
    STAGE.appendChild(wrap);
  }
}

function fanOff(deck, i) {
  const right = deck.x + 460 > window.innerWidth - 30;
  const bottom = deck.y + 200 * deck.members.length > window.innerHeight - 70;
  const dx = right ? -i * 28 : i * 28;
  const dy = bottom ? -i * 10 : i * 10;
  const rot = right ? -i * 2.2 : i * 2.2;
  return { dx, dy, rot };
}

/* ================= 今日堆 ================= */
function buildTodayDeck() {
  const items = todayItems(notes);
  const t = document.createElement("div");
  t.className = "today-card deck-today";
  t.style.left = "40px";
  t.style.top = "40px";
  const head = document.createElement("div");
  head.className = "t-title";
  head.innerHTML = '<span class="dot"></span>今日堆 · ' + items.length + " 项（永远摊开）";
  t.appendChild(head);
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "t-empty";
    e.textContent = "没有紧急 / 定时项";
    t.appendChild(e);
  }
  for (const it of items.slice(0, 9)) {
    const row = document.createElement("div");
    row.className = "t-item" + (it.overdue ? " ov" : "");
    row.innerHTML = '<span class="ic">' + it.icon + "</span><span>" + esc(it.label) + "</span>";
    row.onclick = () => jumpTo(it.note);
    t.appendChild(row);
  }
  if (items.length > 9) {
    const more = document.createElement("div");
    more.className = "t-empty";
    more.textContent = "…还有 " + (items.length - 9) + " 项";
    t.appendChild(more);
  }
  STAGE.appendChild(t);
}
function jumpTo(note) {
  const deck = decks.find((d) => d.members.includes(note.id));
  if (deck) { deck.spread = true; }
  render();
  if (deck) {
    const el = STAGE.querySelector('[data-key="n' + note.id + '"]');
    if (el) { el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 3000); }
  }
}

/* ================= 交互 ================= */
function bindMember(el, deck, noteId, i) {
  el.addEventListener("mouseenter", () => {
    if (!deck.spread && deck.members.length > 1 && !dragSource && hoverDeck !== deck.id) { hoverDeck = deck.id; render(); }
  });
  el.addEventListener("mouseleave", (e) => {
    if (hoverDeck === deck.id && !pointerInEls(e, el.closest(".deck").querySelectorAll(".note"))) {
      hoverDeck = null;
      render();
    }
  });
  makeDraggable(el, {
    onStart(e, st) {
      const r = el.getBoundingClientRect();
      st.grabX = e.clientX - r.left;
      st.grabY = e.clientY - r.top;
      ghostEl = cloneGhost(el, r);
      el.classList.add("dim");
      if (deck.spread || hoverDeck === deck.id) {
        // 拖出 = 成新堆
        const nd = { id: "d" + (++uid), color: byId[noteId].color, members: [noteId], x: 0, y: 0, spread: false };
        decks.push(nd);
        deck.members = deck.members.filter((id) => id !== noteId);
        if (!deck.members.length) decks = decks.filter((d) => d !== deck);
        dragSource = { deck: nd, noteId };
      } else {
        dragSource = { deck, noteId };
      }
    },
    onMove(x, y, dx, dy, e, st) {
      ghostEl.style.left = x - st.grabX + "px";
      ghostEl.style.top = y - st.grabY + "px";
      document.querySelectorAll(".drop-stack").forEach((q) => q.classList.remove("drop-stack"));
      const over = dropAt(x, y, el);
      const targetEl = over && over.closest("[data-drop='member']");
      if (targetEl) targetEl.classList.add("drop-stack");
    },
    onEnd(x, y, dx, dy, e, st) {
      ghostEl.remove();
      ghostEl = null;
      el.classList.remove("dim");
      document.querySelectorAll(".drop-stack").forEach((q) => q.classList.remove("drop-stack"));
      const src = dragSource;
      dragSource = null;
      if (!src) { render(); return; }
      const over = dropAt(x, y, el);
      const memberEl = over && over.closest("[data-drop='member']");
      if (memberEl) {
        const tdeck = decks.find((d) => d.id === memberEl.dataset.deck);
        if (tdeck && tdeck !== src.deck) {
          if (tdeck.members.length >= MAX_DECK) { shake(memberEl); render(); return; }
          tdeck.members.push(src.noteId);
          src.deck.members = src.deck.members.filter((id) => id !== src.noteId);
          if (!src.deck.members.length) decks = decks.filter((d) => d !== src.deck);
        }
      } else {
        src.deck.x = clamp(x - st.grabX, 8, window.innerWidth - 250);
        src.deck.y = clamp(y - st.grabY, 8, window.innerHeight - 160);
      }
      render();
    },
    onCancel() {
      if (ghostEl) ghostEl.remove();
      ghostEl = null;
      el.classList.remove("dim");
    },
    onClick(e) {
      if (e.target.classList.contains("cb")) {
        const n = byId[noteId];
        const li = e.target.closest("li");
        const idx = Array.from(li.parentElement.children).indexOf(li);
        if (n.items && n.items[idx]) n.items[idx].done = !n.items[idx].done;
        li.classList.toggle("done", n.items[idx].done);
        return;
      }
      if (!deck.spread) { deck.spread = true; render(); return; }
      const body = el.querySelector(".body");
      if (body) { body.contentEditable = "true"; body.focus(); body.onblur = () => (body.contentEditable = "false"); }
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
  g.querySelectorAll(".s-badge").forEach((b) => b.remove());
  document.body.appendChild(g);
  return g;
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".deck") && !e.target.closest(".today-card")) {
    let changed = false;
    for (const d of decks) if (d.spread) { d.spread = false; changed = true; }
    if (changed) render();
  }
});

/* ================= 控制 ================= */
function pointerInEls(e, els) {
  for (const m of els) {
    const r = m.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
  }
  return false;
}
function addNote() {
  const color = COLORS[Math.floor(rand(COLORS.length))];
  notes.push(S.N({ title: "新便签", text: "新纸堆 · 拖到别的堆上归堆", color, age: 0 }));
  decks.push({ id: "d" + (++uid), color, members: [notes[notes.length - 1].id], x: 60 + rand(500), y: 300 + rand(300), spread: false });
  render();
}
function reset() {
  notes = defaultNotes();
  initDecks();
  render({ dur: 300 });
}

mountShell({
  title: "方案五 · 纸堆桌面",
  sub: "按颜色归堆 · 悬停展开 · 点击摊开 · 拖出成新堆 · 拖入归堆 · 今日堆常驻",
  buttons: [
    { label: "↺ 重置", fn: reset },
    { label: "➕ 新便签", fn: addNote },
  ],
});

reset();
