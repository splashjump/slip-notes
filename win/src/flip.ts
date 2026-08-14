// FLIP 动画工具（WAAPI；透明窗口下 transform/opacity 无重绘问题）
// 用法：render 前 capture() → 改 DOM → apply()（旧元素从原位飞入，新元素按 appear 出生）

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_DURATION = 300;

/** 强制收尾：动画被节流（WebView2 低优先渲染）时可能停在半途，
 *  残留 transform 会破坏命中测试——超时后强制 finish 到终态 */
function finishAfter(el: HTMLElement, ms: number): void {
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
  }, ms);
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

/** render 后调用：旧元素从旧位置 FLIP；新元素从 appearFrom 出生（缺省 = 缩放淡入） */
export function apply(
  root: ParentNode,
  prev: Map<string, DOMRect>,
  opts: { duration?: number; appearFrom?: RectLike } = {},
): void {
  const duration = opts.duration ?? DEFAULT_DURATION;
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    const key = el.dataset.flip!;
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
      finishAfter(el, duration + 120);
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
      finishAfter(el, duration + 120);
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
  finishAfter(el, duration + 120); // G2：节流残留收尾
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
  finishAfter(el, 700 + 120); // G2：残留 scale 会偏移命中测试
}

export function flash(el: HTMLElement, color = "rgba(255,255,255,.85)"): void {
  el.animate(
    [
      { backgroundColor: color, filter: "brightness(1.5)" },
      { backgroundColor: "", filter: "" },
    ],
    { duration: 400, easing: "ease-out" },
  );
  finishAfter(el, 400 + 120); // G2：残留 backgroundColor 收尾
}
