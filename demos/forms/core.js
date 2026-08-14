/* ============================================================
   纸筏 · 形态实验室 — 共享核心
   纯前端无依赖；被 demos/forms 下的 main.js 以 script 标签引用
   ============================================================ */
window.Slip = (function () {
  "use strict";

  /* ---------------- 调色板 ---------------- */
  const PALETTE = {
    yellow: { name: "黄", ink: "#5a4a1e", edge: "#d9b64d", bg: "linear-gradient(172deg,#fef9c7 0%,#fdef96 58%,#fadd65 100%)" },
    pink:   { name: "粉", ink: "#7a3555", edge: "#d98fb6", bg: "linear-gradient(172deg,#fde8f0 0%,#fbd3e4 60%,#f6b8d4 100%)" },
    blue:   { name: "蓝", ink: "#2b4a7a", edge: "#7fa5dc", bg: "linear-gradient(172deg,#e3effd 0%,#cddffb 60%,#b3cdf7 100%)" },
    green:  { name: "绿", ink: "#2f6b3c", edge: "#7cc088", bg: "linear-gradient(172deg,#e4f9e6 0%,#d0f2d4 60%,#b4e8bc 100%)" },
    purple: { name: "紫", ink: "#4d3a7a", edge: "#9d84d6", bg: "linear-gradient(172deg,#efe9fc 0%,#e0d6f7 60%,#cbbcf0 100%)" },
    orange: { name: "橙", ink: "#7a4a1e", edge: "#e39b52", bg: "linear-gradient(172deg,#fef0dd 0%,#fde0bf 60%,#f9c98f 100%)" },
  };
  const COLORS = Object.keys(PALETTE);
  const ROTS = ["", "rot-a", "rot-b", "rot-c"];

  let _nid = 0;
  const N = (p) => Object.assign({ id: "n" + (++_nid), title: "", text: "", items: null, color: "yellow", age: 0.5, urgent: false }, p);
  const T = (t, done, urgent, time, overdue) => ({ t, done: !!done, urgent: !!urgent, time: time || null, overdue: !!overdue });

  /* ---------------- 默认数据集（28 条，贴合项目真实内容） ---------------- */
  function defaultNotes() {
    _nid = 0;
    return [
      N({ title: "服务器", text: "契约测试 30 用例全绿 ✅\nserver/test/contract.test.ts", color: "blue", age: 0.2 }),
      N({ title: "今日清单", items: [T("部署 smoke 测试", 1), T("position 持久化", 0, 1, "今天 18:00"), T("第二台 Win 验证多显示器"), T("审阅 GRILL-PLAN 下一阶段")], color: "yellow", age: 0.3, urgent: 1 }),
      N({ title: "纸筏", text: "纸筏传纸条：把便签送到每一台设备。\n跨设备强同步，AI 像第二个用户一样替你打理纸条。", color: "purple", age: 1.2 }),
      N({ title: "VPS 备份", text: "每日 03:00 在线备份，保留 14 份\n改凭证只改 .env，不碰代码", color: "green", age: 2 }),
      N({ title: "任务三", items: [T("数据层 + journal", 1), T("同步引擎接服务器", 0, 0, "明天 10:00"), T("local API(60000)"), T("position 持久化")], color: "yellow", age: 0.8, urgent: 1 }),
      N({ title: "端口", text: "同步服务器 50000（公网）\n本地便签服务 60000（仅 127.0.0.1）", color: "blue", age: 6 }),
      N({ title: "SSH", text: "ssh slip 免密登录\n密钥 ~/.ssh/id_slip", color: "green", age: 4 }),
      N({ title: "Docker", text: "CentOS 7 glibc 2.17 过老\nNode 24 必须跑容器 node:24", color: "orange", age: 8 }),
      N({ title: "全屏检测", text: "WinEvent 事件驱动，不靠轮询\n排除 Progman / WorkerW", color: "purple", age: 9 }),
      N({ title: "SetWindowRgn", text: "窗口区域 = 便签矩形并集\n无便签处点击穿透到桌面", color: "blue", age: 10 }),
      N({ title: "拖拽层方案", text: "画布窗口全程不动\n被拖便签浮在拖拽层窗口", color: "orange", age: 11 }),
      N({ title: "DPI 炸弹", text: "窗口创建用 logical 像素传物理坐标\n125%/150% 缩放下错位", color: "pink", age: 12 }),
      N({ title: "WebView2 坑", text: "WS_EX_NOACTIVATE 收不到鼠标\n点击便签 = 临时激活编辑", color: "blue", age: 13 }),
      N({ title: "capability", text: "Tauri v2 默认只授权 main 窗口\ncanvas-* 要加进 capabilities", color: "green", age: 14 }),
      N({ title: "EventId", text: "app.listen 返回的 EventId 被 drop 即注销\n必须存进 state", color: "purple", age: 15 }),
      N({ title: "安卓", items: [T("AlarmManager 精确闹钟", 1), T("澎湃白名单一次性设置"), T("Glance widget")], color: "pink", age: 5 }),
      N({ title: "铁律", text: "1 版本号只由服务器签发\n2 服务器拒绝陈旧写入\n3 journal 只追加永不被覆盖\n4 还原 = 写新版本\n5 删除 = tombstone\n6 服务器保留完整历史", color: "yellow", age: 7 }),
      N({ title: "今日聚合", text: "定时/紧急项自动进 Today\n勾掉/删除自动移除\n逾期未完成自动置顶红色", color: "orange", age: 0.5, urgent: 1 }),
      N({ title: "形态实验室", items: [T("方案一 纸堆墙", 1), T("方案二 收纳坞", 1), T("方案三 展板", 1), T("方案四 时间流", 1), T("方案五 纸堆桌面", 1)], color: "purple", age: 0.1 }),
      N({ title: "九宫格上限", text: "合并容器最多 9 个 pane\n纸堆最多 9 张\n超出 = 轻晃拒绝", color: "yellow", age: 0.4 }),
      N({ title: "撕纸线", text: "合并容器的分隔线做成锯齿虚线\n两个便签拼在一起的感觉", color: "pink", age: 0.6 }),
      N({ title: "磁吸阈值", text: "边缘距离 < 16px 吸附\n显示对齐引导线", color: "blue", age: 0.9 }),
      N({ title: "折叠阈值", text: "超过 3 天未动 → 缩成标题条\n紧急/定时项永不折叠", color: "green", age: 1.5 }),
      N({ title: "ALIAS", text: "~/.ssh/config 配好 slip 别名", color: "green", age: 16 }),
      N({ title: "防火墙", text: "50000 已放行 + 安全组\nsmoke 测试验证过", color: "orange", age: 17 }),
      N({ title: "令牌", text: "SLIP_TOKEN_WIN1 / WIN2 / AI\n.gitignore 绝不提交", color: "purple", age: 18 }),
      N({ title: "验收清单", items: [T("透明", 1), T("置底", 1), T("区域穿透", 1), T("多显示器", 0, 0, "昨天", 1), T("全屏检测", 1)], color: "blue", age: 19 }),
      N({ title: "灵感", text: "纸堆的厚度 = 数量感\n撕纸线 = 合并的边界说明", color: "pink", age: 0.2 }),
    ];
  }

  /* ---------------- 小工具 ---------------- */
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const rand = (n) => Math.random() * n;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function relTime(age) {
    if (age < 1 / 24) return "刚刚";
    if (age < 1) return Math.round(age * 24) + " 小时前";
    if (age < 2) return "昨天";
    if (age < 30) return Math.round(age) + " 天前";
    return Math.round(age / 30) + " 个月前";
  }

  function stripTitle(n) {
    if (n.title) return n.title;
    if (n.items && n.items.length) return n.items[0].t;
    return (n.text || "便签").split("\n")[0];
  }
  function previewText(n, len) {
    if (n.items) return n.items.map((i) => (i.done ? "☑" : "☐") + " " + i.t).join(" · ");
    return (n.text || "").replace(/\n/g, " ").slice(0, len);
  }

  /* ---------------- 便签 DOM ---------------- */
  function paintNote(el, note) {
    const p = PALETTE[note.color] || PALETTE.yellow;
    el.style.setProperty("--ink", p.ink);
    el.style.setProperty("--edge", p.edge);
    el.style.background = p.bg;
  }

  function buildNote(note, mode) {
    const el = document.createElement("div");
    el.className = "note" + (mode === "strip" ? " strip" : mode === "board" ? " board" : "");
    el.dataset.note = note.id;
    paintNote(el, note);

    if (mode === "strip") {
      el.innerHTML = '<span class="s-dot"></span><span class="s-title"></span><span class="s-meta"></span>';
      el.querySelector(".s-dot").style.background = PALETTE[note.color].edge;
      el.querySelector(".s-title").textContent = stripTitle(note);
      const meta = el.querySelector(".s-meta");
      meta.textContent = relTime(note.age);
      if (note.urgent) meta.textContent = "⚡ " + meta.textContent;
      return el;
    }
    if (mode === "board") {
      el.innerHTML = '<div class="b-title"></div><div class="b-prev"></div><div class="b-meta"></div>';
      el.querySelector(".b-title").textContent = (note.urgent ? "⚡ " : "") + stripTitle(note);
      el.querySelector(".b-prev").textContent = previewText(note, 34);
      el.querySelector(".b-meta").textContent = relTime(note.age) + (note.urgent ? " · 紧急" : "");
      return el;
    }

    // card / pane
    if (note.title) {
      const t = document.createElement("div");
      t.className = "title";
      t.textContent = note.title;
      el.appendChild(t);
    }
    if (note.items) {
      const ul = document.createElement("ul");
      ul.className = "items";
      for (const it of note.items) {
        const li = document.createElement("li");
        li.className = it.done ? "done" : "";
        const cb = document.createElement("i");
        cb.className = "cb";
        cb.textContent = "✓";
        const sp = document.createElement("span");
        sp.textContent = it.t;
        if (it.urgent) { const u = document.createElement("em"); u.className = "urg"; u.textContent = " ⚡"; sp.appendChild(u); }
        if (it.time) { const tm = document.createElement("em"); tm.className = "urg"; tm.textContent = " ⏰" + it.time + (it.overdue ? " 已逾期" : ""); sp.appendChild(tm); }
        li.append(cb, sp);
        ul.appendChild(li);
      }
      el.appendChild(ul);
    } else {
      const b = document.createElement("div");
      b.className = "body";
      b.textContent = note.text;
      el.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "🕐 " + relTime(note.age) + (note.urgent ? " · ⚡紧急" : "");
    el.appendChild(meta);
    return el;
  }

  /* ---------------- FLIP 动效 ---------------- */
  function flip(sel, mutate, opt) {
    const dur = (opt && opt.dur) || 420;
    const ease = (opt && opt.ease) || "cubic-bezier(.25,.8,.35,1)";
    const els = Array.from(document.querySelectorAll(sel));
    const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    const anims = [];
    for (const el of els) {
      if (!el.isConnected) continue;
      const f = first.get(el);
      if (!f) continue;
      const l = el.getBoundingClientRect();
      const dx = f.left - l.left, dy = f.top - l.top;
      const sx = f.width / l.width, sy = f.height / l.height;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .02 && Math.abs(sy - 1) < .02) continue;
      anims.push(el.animate([
        { transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")", transformOrigin: "0 0" },
        { transform: "translate(0,0) scale(1,1)", transformOrigin: "0 0" },
      ], { duration: dur, easing: ease, fill: "backwards" }));
    }
    return anims;
  }

  function popIn(el, delay) {
    el.animate([
      { opacity: 0, transform: "scale(.82) translateY(12px)" },
      { opacity: 1, transform: "none" },
    ], { duration: 380, easing: "cubic-bezier(.22,1.2,.36,1)", delay: delay || 0, fill: "backwards" });
  }

  function shake(el) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    setTimeout(() => el.classList.remove("shake"), 400);
  }

  /* ---------------- 拖拽 ---------------- */
  // h: { threshold, onStart(e), onMove(x,y,dx,dy,e,st), onEnd(x,y,dx,dy,e,st), onCancel(), onClick(e) }
  // st 为会话对象（demo 可挂 holdTarget/holdAt 等字段）
  function makeDraggable(el, h) {
    const th = h.threshold || 5;
    let st = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      st = { sx: e.clientX, sy: e.clientY, moved: false, id: e.pointerId };
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
      if (!st.moved && Math.hypot(dx, dy) > th) { st.moved = true; if (h.onStart) h.onStart(e, st); }
      if (st.moved && h.onMove) h.onMove(e.clientX, e.clientY, dx, dy, e, st);
    });
    const finish = (e) => {
      if (!st) return;
      const s = st; st = null;
      if (s.moved) { if (h.onEnd) h.onEnd(e.clientX, e.clientY, e.clientX - s.sx, e.clientY - s.sy, e, s); }
      else if (h.onClick) h.onClick(e);
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", () => {
      if (!st) return;
      if (st.moved && h.onCancel) h.onCancel();
      st = null;
    });
  }

  // 命中检测：从指针下找最近的 [data-drop]（排除 exclude 及其子树）
  function dropAt(x, y, exclude) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (exclude && (el === exclude || exclude.contains(el))) continue;
      const t = el.closest("[data-drop]");
      if (t) return t;
    }
    return null;
  }

  // 磁吸：rect 靠近 others（边/中心对齐），返回吸附修正量 + 引导线
  function magnet(rect, others, t) {
    const th = t || 16;
    let dx = 0, dy = 0, vline = null, hline = null;
    for (const o of others) {
      const cands = [
        { d: o.left - rect.right, v: o.left },
        { d: rect.left - o.right, v: o.right },
        { d: o.left - rect.left, v: o.left },
        { d: o.right - rect.right, v: o.right },
        { d: (o.left + o.right) / 2 - (rect.left + rect.right) / 2, v: (o.left + o.right) / 2 },
      ];
      for (const c of cands) {
        if (Math.abs(c.d) <= th && Math.abs(c.d) <= Math.abs(dx)) { dx = c.d; vline = c.v; }
      }
      const candys = [
        { d: o.top - rect.bottom, v: o.top },
        { d: rect.top - o.bottom, v: o.bottom },
        { d: o.top - rect.top, v: o.top },
        { d: o.bottom - rect.bottom, v: o.bottom },
        { d: (o.top + o.bottom) / 2 - (rect.top + rect.bottom) / 2, v: (o.top + o.bottom) / 2 },
      ];
      for (const c of candys) {
        if (Math.abs(c.d) <= th && Math.abs(c.d) <= Math.abs(dy)) { dy = c.d; hline = c.v; }
      }
    }
    if (!dx && !dy) return null;
    return { dx, dy, vline, hline };
  }

  /* ---------------- 今日聚合 ---------------- */
  function todayItems(notes) {
    const out = [];
    for (const n of notes) {
      if (n.items) {
        for (const it of n.items) {
          if (it.urgent && !it.done) out.push({ note: n, item: it, icon: "⚡", label: (n.title ? n.title + " · " : "") + it.t });
          if (it.time && !it.done) out.push({ note: n, item: it, icon: it.overdue ? "⏰逾期" : "⏰", label: (n.title ? n.title + " · " : "") + it.t + " (" + it.time + ")", overdue: it.overdue });
        }
      } else if (n.urgent) {
        out.push({ note: n, item: null, icon: "⚡", label: n.title || stripTitle(n) });
      }
    }
    return out;
  }

  /* ---------------- 外壳（壁纸 + 任务栏 + 控制面板） ---------------- */
  function stage() {
    let s = document.getElementById("stage");
    if (!s) {
      s = document.createElement("div");
      s.id = "stage";
      document.body.appendChild(s);
    }
    return s;
  }

  function mountShell(o) {
    const wp = document.createElement("div");
    wp.id = "wallpaper";
    const desk = document.createElement("div");
    desk.id = "deskbar";
    desk.innerHTML = '<div class="desk-dot"></div><div class="desk-dot"></div><div class="desk-dot"></div><div class="spacer"></div><div class="desk-clock"></div>';
    const panel = document.createElement("div");
    panel.id = "panel";
    const info = document.createElement("div");
    info.innerHTML = '<div class="p-title">' + esc(o.title) + "</div><div class='p-sub'>" + esc(o.sub || "") + "</div>";
    panel.appendChild(info);
    const btns = document.createElement("div");
    btns.className = "btns";
    for (const b of (o.buttons || [])) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.onclick = b.fn;
      btns.appendChild(btn);
    }
    panel.appendChild(btns);
    document.body.append(wp, desk, panel);
    const clock = desk.querySelector(".desk-clock");
    const tick = () => {
      clock.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    };
    setInterval(tick, 10000);
    tick();
  }

  return {
    PALETTE, COLORS, ROTS, N, T, defaultNotes,
    clamp, rand, esc, relTime, stripTitle, previewText,
    buildNote, flip, popIn, shake,
    makeDraggable, dropAt, magnet,
    todayItems, stage, mountShell,
  };
})();
