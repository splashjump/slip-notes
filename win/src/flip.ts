// FLIP 动画工具（WAAPI；透明窗口下 transform/opacity 无重绘问题）
// 用法：render 前 capture() → 改 DOM → apply()（旧元素从原位飞入，新元素按 appear 出生）

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_DURATION = 300;

/** 强制收尾：动画被节流（WebView2 低优先渲染，实测 ~1/4 速）时可能停在半途，
 *  残留 transform 会破坏命中测试。超时预算按 4 倍时长给足视觉播放时间，
 *  到点后强制 finish 到终态（节流下恰好与自然播放结束时点一致）。 */
function finishAfter(el: HTMLElement, duration: number): void {
  setTimeout(() => {
    for (const a of el.getAnimations()) {
      if (a.playState === "running") {
        try {
          a.finish();
        } catch {
          a.cancel();
        }
      }
    }
  }, duration * 4 + 250);
}

/** 捕获当前所有 [data-flip] 元素的矩形（key = data-flip）；
 *  跳过 display:none 元素（其 rect 全零，会造成从原点飞入的假动画——拖出重建的隐藏卡） */
export function capture(root: ParentNode): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    if (el.style.display === "none") return;
    const key = el.dataset.flip!;
    map.set(key, el.getBoundingClientRect());
  });
  return map;
}

// ---------------------------------------------------------------------------
// 跳过动画集合（一次性）：松手落定的卡、拖出重建的卡不播放出生动画——
// 被拖卡在拖拽期间 display:none，capture 拿不到它的旧矩形，apply 会走
// appearFrom 分支，造成"松手后卡从边栏点飞入"的假动画（用户感知 = 卡弹走又飞回）。
// ---------------------------------------------------------------------------
const skipOnce = new Set<string>();

export function skipAnim(id: string): void {
  skipOnce.add(id);
}

/** render 后调用：旧元素从旧位置 FLIP；新元素从 appearFrom 出生（缺省 = 缩放淡入） */
export function apply(
  root: ParentNode,
  prev: Map<string, DOMRect>,
  opts: { duration?: number; appearFrom?: RectLike } = {},
): void {
  const duration = opts.duration ?? DEFAULT_DURATION;
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    const key = el.dataset.flip!;
    if (skipOnce.delete(key)) return; // 一次性跳过（落定卡不飞入）
    const now = el.getBoundingClientRect();
    const from = prev.get(key);
    if (from) {
      const dx = from.left - now.left;
      const dy = from.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }],
        { duration, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      finishAfter(el, duration);
    } else if (opts.appearFrom) {
      const sx = opts.appearFrom.left + opts.appearFrom.width / 2 - (now.left + now.width / 2);
      const sy = opts.appearFrom.top + opts.appearFrom.height / 2 - (now.top + now.height / 2);
      el.animate(
        [
          { transform: `translate(${sx}px, ${sy}px) scale(.6)`, opacity: 0 },
          { transform: "translate(0,0) scale(1)", opacity: 1 },
        ],
        { duration, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      finishAfter(el, duration);
    }
  });
}

/** 显式飞行动画（视图打开/关闭的出生点来自按钮等外部矩形） */
export function fly(el: HTMLElement, from: RectLike, duration = DEFAULT_DURATION): void {
  const now = el.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (now.left + now.width / 2);
  const dy = from.top + from.height / 2 - (now.top + now.height / 2);
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(.5)`, opacity: 0 },
      { transform: "translate(0,0) scale(1)", opacity: 1 },
    ],
    { duration, easing: "cubic-bezier(.2,.7,.3,1)" },
  );
  finishAfter(el, duration);
}

export function pulse(el: HTMLElement): void {
  el.animate(
    [
      { transform: "scale(1)", boxShadow: "0 4px 14px rgba(0,0,0,.18)" },
      { transform: "scale(1.06)", boxShadow: "0 0 0 3px rgba(255,180,60,.8)" },
      { transform: "scale(1)", boxShadow: "0 4px 14px rgba(0,0,0,.18)" },
    ],
    { duration: 700, easing: "ease-in-out" },
  );
  finishAfter(el, 700);
}

export function flash(el: HTMLElement, color = "rgba(255,255,255,.85)"): void {
  el.animate(
    [
      { backgroundColor: color, filter: "brightness(1.5)" },
      { backgroundColor: "", filter: "" },
    ],
    { duration: 400, easing: "ease-out" },
  );
  finishAfter(el, 400);
}
