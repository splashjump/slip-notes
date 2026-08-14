// 控制台（main 窗口）：状态总览 / 便签表 / 已删列表 / 动作日志 / 快捷动作（T2 演练）/ 调试指令

import { emit, listen } from "@tauri-apps/api/event";
import { actions, newBatch } from "./api";
import {
  onState,
  initState,
  relTime,
  deletedNotes,
  isDesk,
  type AppState,
  type Note,
} from "./state";

const root = document.getElementById("debug-root") as HTMLElement;

let st: AppState | null = null;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render() {
  if (!st) return;
  const s = st;
  const monitors = s.monitors
    .map((m, i) => `${i}${m.primary ? "★" : ""}[${m.rect.join(",")}] ${m.dpi}dpi`)
    .join("\n");
  const notesHtml = s.notes
    .map((n) => {
      const flags = [
        n.deleted ? "🗑" : "",
        n.mode === "desk" ? "桌" : "档",
        n.slot_id ? "格" : "",
        n.urgent ? "⚡" : "",
        n.timed ? "⏰" : "",
        s.ephemeral.unconfirmed.includes(n.id) ? "❓" : "",
      ].join("");
      return `<tr class="${n.deleted ? "deleted" : ""}">
        <td>${esc(n.id)}</td><td>${flags || "—"}</td>
        <td>${n.deleted ? "—" : `${Math.round(n.x)},${Math.round(n.y)}`}</td>
        <td>${relTime(n.updated_at)}</td>
        <td>${esc(title(n).slice(0, 16))}</td>
      </tr>`;
    })
    .join("");
  const deletedHtml = deletedNotes(s)
    .map((n) => `<div class="del-row"><span>${esc(n.id)} · ${esc(title(n).slice(0, 20))}</span><button data-restore="${esc(n.id)}">还原</button></div>`)
    .join("");
  const journalHtml = s.journal
    .slice(0, 15)
    .map(
      (j) =>
        `<div class="j-row"><span class="j-seq">#${j.seq}</span><span class="j-name">${esc(j.name)}</span><span class="j-args">${esc(JSON.stringify(j.args ?? {}, (k, v) => (k === "__batch" ? undefined : v)).slice(0, 60))}</span><span class="j-batch">${esc(j.batch)}</span><span class="j-author">${esc(j.author)}</span><button data-undo="${esc(j.batch)}">撤销批次</button></div>`,
    )
    .join("");

  root.innerHTML = `
    <h1>纸筏 — 控制台 <span class="hint-inline">形态先行 · mock 数据 · 离线</span></h1>
    <div class="toolbar">
      <button id="btn-rebuild">重建窗口</button>
      <button id="btn-reset">重置数据</button>
      <button id="btn-collapse">收起边栏</button>
      <button id="btn-console">隐藏本窗口</button>
      <button id="btn-recent">🕐 最近视图</button>
      <button id="btn-timeline">⏱ 时间线</button>
    </div>
    <div class="toolbar">
      <label>时间快进 <input id="ff-days" type="number" value="31" min="1" style="width:56px"> 天</label>
      <button id="btn-ff">快进 → 自动收回</button>
      <button id="btn-aa">立即自动收回</button>
      <span class="hint-inline">（自动收回：updated_at 距今 &gt; 30 天 → 归档 + 未确认）</span>
    </div>
    <div class="toolbar">
      <button id="btn-play-create">create</button>
      <button id="btn-play-store">move→right(store)</button>
      <button id="btn-play-tag">tag urgent</button>
      <button id="btn-play-timed">tag timed 明天10点</button>
      <button id="btn-play-take">take(n4)</button>
      <button id="btn-play-merge">merge(n1+n2)</button>
      <button id="btn-play-unmerge">unmerge(m1)</button>
      <button id="btn-play-stack">stack(n11,n12,n13)</button>
      <button id="btn-play-unstack">unstack(n11)</button>
      <button id="btn-play-undo">撤销最后批次</button>
    </div>
    <h2>状态</h2>
    <pre id="status">视图: ${s.view ? JSON.stringify(s.view) : "无"} · 全屏隐藏: ${s.fullscreenHidden.length ? s.fullscreenHidden.join(",") : "无"} · 编辑: ${s.editing ?? "无"}
边栏: ${s.sidebarCollapsed ? "收起" : "展开"} · rect: ${s.sidebarRect ? s.sidebarRect.join(",") : "—"}
monitors:\n${monitors}
virtual: ${s.virtualRect.join(",")}
ephemeral: unconfirmed=[${s.ephemeral.unconfirmed.join(",")}] borrowing=[${s.ephemeral.borrowing.length}] dragging=${s.ephemeral.dragging ?? "无"}</pre>
    <h2>便签（${s.notes.length}）</h2>
    <table class="notes-table">
      <tr><th>id</th><th>状态</th><th>位置</th><th>更新</th><th>内容</th></tr>
      ${notesHtml}
    </table>
    <h2>已删除（tombstone）</h2>
    ${deletedHtml || '<p class="hint-inline">无</p>'}
    <h2>动作日志（journal，批次可撤销）</h2>
    ${journalHtml || '<p class="hint-inline">空</p>'}
  `;
  bindButtons();
}

function title(n: Note): string {
  if (n.title) return n.title;
  return n.text.split("\n")[0].trim() || "（无标题）";
}

function bindButtons() {
  const on = (id: string, fn: () => void) => {
    root.querySelector(`#${id}`)?.addEventListener("pointerdown", fn);
  };
  on("btn-rebuild", () => void emit("rebuild-canvases", {}));
  on("btn-reset", () => void actions.reset());
  on("btn-collapse", () => {
    if (st?.sidebarCollapsed) void actions.expand();
    else void actions.collapse();
  });
  on("btn-console", () => void actions.toggleConsole());
  on("btn-recent", () => void actions.view("recent", !(st?.view?.name === "recent")));
  on("btn-timeline", () => void actions.view("timeline", !(st?.view?.name === "timeline")));
  on("btn-ff", () => {
    const days = Number((root.querySelector("#ff-days") as HTMLInputElement).value || 31);
    void actions.fastForward(days);
  });
  on("btn-aa", () => void actions.autoArchive());

  // T2 演练：动作层直接调用（AI 路径等价）
  const batch = () => newBatch();
  on("btn-play-create", () => {
    void actions.create("AI 新建的便签 🎉", "#caf0f8", 400, 200, batch());
  });
  on("btn-play-store", () => {
    const n = st?.notes.find((x) => isDesk(x));
    if (n) void actions.moveDir(n.id, "right", batch());
  });
  on("btn-play-tag", () => {
    const n = st?.notes.find((x) => isDesk(x));
    if (n) void actions.tag(n.id, "urgent", true, batch());
  });
  on("btn-play-timed", () => {
    const n = st?.notes.find((x) => isDesk(x));
    if (n) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      void actions.tag(n.id, "timed", d.getTime(), batch());
    }
  });
  on("btn-play-take", () => {
    void actions.take("n4", 260, 240, batch());
  });
  on("btn-play-merge", () => {
    const ids = st?.notes.filter((x) => isDesk(x) && !x.merge_tree).slice(0, 2).map((x) => x.id);
    if (ids && ids.length === 2) void actions.merge(ids, 700, 300, batch());
  });
  on("btn-play-unmerge", () => {
    const c = st?.notes.find((x) => x.merge_tree);
    if (c) void actions.unmerge(c.id, batch()); // G7：动态找首个合并容器（不再硬编码 m1）
  });
  on("btn-play-stack", () => {
    void actions.stack(["n11", "n12", "n13"], 1500, 320, batch());
  });
  on("btn-play-unstack", () => {
    void actions.unstack("n11", batch());
  });
  on("btn-play-undo", () => {
    const last = st?.journal[0];
    if (last) void actions.undoBatch(last.batch);
  });
  root.querySelectorAll<HTMLElement>("[data-restore]").forEach((b) => {
    b.addEventListener("pointerdown", () => void actions.restore(b.dataset.restore!, newBatch()));
  });
  root.querySelectorAll<HTMLElement>("[data-undo]").forEach((b) => {
    b.addEventListener("pointerdown", () => void actions.undoBatch(b.dataset.undo!));
  });
}

async function init() {
  await initState();
  // 事件序纪律：唯一 listen("state") 在 state.ts；窗口一律 onState 订阅拿最新载荷
  onState((s) => {
    st = s;
    render();
  });
  await listen("edit-end", () => render());
}

void init();
