// CDP 测试助手（M0 基建；T1/T3 共用）—— 连接 tauri dev 的 WebView2 调试端口 9222
// Node ≥22（原生 WebSocket）。用法：
//   import { connect, evalIn, act, state, drag } from "./cdp.mjs";
// 无依赖；按窗口 title 选择 target（slip-canvas / slip-sidebar / slip — 控制台）。

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

export async function targets() {
  const r = await fetch(`${BASE}/json/list`);
  return r.json();
}

export async function connect(titleMatch) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      const t = list.find(
        (x) => x.type === "page" && (!titleMatch || x.title.includes(titleMatch)),
      );
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        };
        const send = (method, params = {}) =>
          new Promise((res) => {
            id += 1;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params }));
          });
        return {
          ws,
          target: t,
          send,
          close: () => ws.close(),
          async eval(expression) {
            const r = await send("Runtime.evaluate", {
              expression,
              returnByValue: true,
              awaitPromise: true,
            });
            if (r.result?.exceptionDetails) {
              return undefined; // 页面侧异常（如 __slip 未就绪）→ 返回 undefined，由 waitFor 重试
            }
            return r.result?.result?.value;
          },
          async act(name, args = {}, batch) {
            return this.eval(
              `window.__slip.act(${JSON.stringify(name)}, ${JSON.stringify(args)}${batch ? `, ${JSON.stringify(batch)}` : ""}).then(r => JSON.stringify(r))`,
            ).then((s) => JSON.parse(s));
          },
          async actRaw(req) {
            return this.eval(
              `window.__slip.actRaw(${JSON.stringify(req)}).then(r => JSON.stringify(r))`,
            ).then((s) => JSON.parse(s));
          },
          state() {
            return this.eval(`JSON.stringify(window.__slip.state())`).then((s) => JSON.parse(s));
          },
          async mouse(type, x, y, opts = {}) {
            await send("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: opts.button ?? "left",
              buttons: opts.buttons ?? (type === "mouseMoved" ? 1 : 0),
              clickCount: opts.clickCount ?? 1,
              ...opts,
            });
          },
          async drag(x1, y1, x2, y2, steps = 12) {
            await this.mouse("mousePressed", x1, y1, { buttons: 1 });
            for (let i = 1; i <= steps; i++) {
              await this.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, {
                buttons: 1,
              });
              await sleep(16);
            }
            await this.mouse("mouseReleased", x2, y2, { buttons: 0 });
          },
          async click(x, y) {
            // 按下与释放之间留足间隔：本机（远程/高负载）偶发 renderer 忙时丢事件，
            // 30ms 窗口内若发生重渲染，down/up 落在不同元素上 → click 不触发
            await this.mouse("mousePressed", x, y, { buttons: 1 });
            await sleep(30);
            await this.mouse("mouseReleased", x, y, { buttons: 0 });
          },
        };
      }
    } catch {
      // 服务未就绪，重试
    }
    await sleep(1000);
  }
  throw new Error(`CDP 连接失败（${BASE}；请确认已设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT}）`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs = 8000, interval = 120) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await sleep(interval);
  }
}

/** 断言辅助（T1/T3 脚本用） */
export function check(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}
