// 共享卡片渲染：画布窗口与拖拽层窗口复用同一套 DOM 结构/样式
export interface CheckItem {
  text: string;
  done: boolean;
}
export interface Note {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  kind: string; // "text" | "checklist"
  text: string;
  items: CheckItem[];
}

export interface CardCss {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function buildCard(
  n: Pick<Note, "color" | "kind" | "text" | "items">,
  css: CardCss,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "note-card";
  el.style.background = n.color;
  el.style.left = `${css.left}px`;
  el.style.top = `${css.top}px`;
  el.style.width = `${css.width}px`;
  el.style.minHeight = `${css.height}px`;

  if (n.kind === "checklist") {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = n.text;
    el.appendChild(title);
    for (const it of n.items) {
      const row = document.createElement("label");
      row.className = "check-item" + (it.done ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.done;
      // pointerdown 已 preventDefault，click 里手动切换视觉
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        row.classList.toggle("done", cb.checked);
      });
      const span = document.createElement("span");
      span.textContent = it.text;
      row.append(cb, span);
      el.appendChild(row);
    }
  } else {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = n.text.replace(/\\n/g, "\n");
    el.appendChild(text);
  }
  return el;
}
