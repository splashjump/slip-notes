# 便签风格 Demo（纯前端）

6 套便签视觉风格预览。**纯 HTML/CSS/JS，无构建、无依赖**，与 `win/` 工程完全隔离，不参与打包。

## 打开方式

直接双击 `index.html`（或任意静态服务器）即可，推荐 Chrome / Edge。

## 操作

| 操作 | 说明 |
|---|---|
| 点击顶部按钮 / `←` `→` | 切换 6 套风格 |
| `🌙 / ☀️` | 切换壁纸明暗（毛玻璃、霓虹在暗色下效果最佳） |
| `▶` | 自动轮播 |
| 点击清单项 | 勾选/取消（每套风格的 checkbox 都做了定制） |

## 6 套风格一览

| # | 风格 | 特点 | 对应实现要点（供任务三参考） |
|---|---|---|---|
| ① | 经典黄 | 纸胶带 + 右下卷角 + 手写体（楷体） | `::before` 胶带、`::after` 卷角三角形、`KaiTi` 字体栈 |
| ② | 毛玻璃 | `backdrop-filter: blur` + 半透明白 + 顶部渐变 accent 条 | 需要窗口真透明/壁纸可见，Win10 WebView2 支持 `backdrop-filter` |
| ③ | 新拟态 | 同色系双向浮雕阴影、大圆角 | 双 `box-shadow`（亮 + 暗）、check 用 inset 阴影 |
| ④ | 霓虹 | 深色底 + accent 发光描边，每张便签独立 accent 色 | CSS 变量 `--accent` 按便签着色，hover 增强辉光 |
| ⑤ | 手账纸 | 横线底纹 + 左侧红装订线 + 回形针 + 撕纸边 | `repeating` 线性渐变 + `clip-path` 锯齿底边 |
| ⑥ | 极简 Fluent | 白卡片 + 细边框 + hover 上浮 + accent 勾选 | 最接近当前实现，改动成本最低 |

## 与现有实现（win/src/styles.css）的差距

当前 `.note-card` 是纯色块 + 单层阴影。若任务三要接入任意风格，需要把样式抽成
`data-style` 属性驱动的类名（如 `.note-card.style-classic`），并在 `card.ts` 的
`buildCard()` 里补上 `meta`（时间戳）与可点击 checkbox 的 DOM。

## 注意事项

- 回形针、胶带等装饰元素会超出卡片边界，若画布窗口启用了 `overflow: hidden` 或裁剪，需给卡片留出 `padding-top` 或改用卡片内部装饰。
- `clip-path`（撕纸边）会裁掉 box-shadow，手账纸风格实际使用时阴影会弱化。
