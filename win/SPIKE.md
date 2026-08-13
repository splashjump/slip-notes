# Win 画布窗口 spike — 五项验证实测记录

> 2026-08-13 · 机器：Win10（admin 用户）1920×1080 @ 96dpi 单显示器 · 栈：Tauri v2.11 + Rust + vanilla TS
> 结论：**五项验证 4 项实测通过，1 项（多显示器）代码路径就绪、待第二台显示器物理验证 → 保留画布方案，进入任务三**

---

## 运行方式

```powershell
cd win && .\dev.ps1        # PowerShell 一键重启：精准清理旧进程 → tauri dev（vite 端口 1430）
Get-Content -Wait $env:TEMP\tauri_dev.log   # Rust 侧日志
```

- （有 git bash 的机器仍可用 `bash dev.sh`，日志在 `/tmp/tauri_dev.log`）
- 手动停止：`taskkill /F /IM win.exe`；重启前不必手动停，脚本会自动清理

- 画布窗口：每显示器一个（label `canvas-N`），透明/无边框/置底/无任务栏图标
- 调试台（`main` 窗口）：显示显示器拓扑、便签物理坐标、运行状态；按钮：重建画布 / 重置便签 / 隐藏调试台
- spike 数据：4 张假便签写死在 Rust（`default_notes`），重启即重置，不接服务器/数据层

## 五项验证实测记录

| # | 验证 | 验收标准 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | **透明** | 无边框窗口；便签卡片外完全不可见（真透明，无黑/白底） | ✅ **通过** | 截图：卡片浮在壁纸/桌面图标上，卡片外区域壁纸图标完全正常，无任何色块 |
| 2 | **置底** | 稳定压在桌面图标上方、所有普通窗口下方；点击便签编辑时临时激活，失焦回压 | ✅ **通过** | 记事本窗口遮挡便签（便签在下）；点击卡片 → `card-focus` → 窗口激活可编辑；点击卡片外/桌面 → WinEvent 前台变化 → `card-blur` → 回压底部 |
| 3 | **区域穿透** | 窗口区域 = 便签矩形并集（`SetWindowRgn`）；无便签处点击落到桌面 | ✅ **通过** | 便签外 (1000,800) 右键 → 桌面右键菜单弹出；`WindowFromPoint` 证实：便签内点=WebView2 窗口、便签外点=SHELLDLL_DefView（桌面） |
| 4 | **多显示器** | 每显示器一个画布窗口；位置数据跨屏正常；DPI 缩放坐标不错位 | ⏳ **代码就绪待物理验证**（本机单屏） | 显示器枚举 + 每屏建窗 + 拓扑签名变化自动重建 + 物理坐标（虚拟屏系）全链路已实现；拖动跨屏 = 按中心点归属自动分发到对应显示器窗口。**待两台 Win10 实机各测一遍（含 125%/150% DPI）** |
| 5 | **全屏检测** | 任一程序全屏 → 画布隐藏；退出恢复；不靠轮询 | ✅ **通过** | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND + EVENT_OBJECT_LOCATIONCHANGE)` 事件驱动。实测：调试台窗口全屏化 → `LOCATIONCHANGE(0,0,1920,1080)` → 画布隐藏；恢复尺寸 → 画布显示。前台窗口 rect ⊇ 显示器 rect 判定全屏（排除 Progman/WorkerW 桌面窗口） |

**补充实测（通过）**：
- 拖动便签：`drag-end` 坐标精确（(1080,140)→(1260,260)）；拖拽期间被拖便签显示在**拖拽层窗口**（全局一个隐藏的顶层小窗，`drag-layer` label）——画布窗口全程不动、区域不变，其他便签保持在桌面层，只有被拖便签浮在所有普通窗口之上；拖完拖拽层隐藏 + 原卡片在新位置重渲染
- 编辑 + 键盘输入：点击卡片 → 窗口临时激活（`set_always_on_bottom(false)` + `set_focus`）→ contenteditable 输入 "ABC123" 成功上屏（注入点击实测；真实用户操作体验留人工复核）
- 编辑失焦：点击卡片外 → 前台变化 → 自动回压 + 恢复 always_on_bottom

## 演示步骤（给用户验收用）

1. `cd win && bash dev.sh`，等桌面出现 4 张便签卡片
2. **透明**：观察卡片外区域——壁纸、桌面图标完全正常
3. **穿透**：右键点便签外的桌面空白 → 正常弹出桌面菜单；右键点卡片 → 无桌面菜单
4. **置底**：开任意程序窗口拖到便签上 → 便签被遮住；Win+D 显示桌面后便签仍在桌面图标上方
5. **编辑**：单击卡片 → 蓝色 outline + 可打字；点卡片外任意处 → 边框消失、回到底层
6. **拖动**：按住卡片拖动 → 卡片跟随；松手后 Rgn 更新（新位置可点、旧位置穿透）
7. **全屏**：打开 Chrome 全屏视频（F11 或全屏按钮）→ 便签全部消失；退出全屏 → 恢复
8. **多显示器**（第二台机器/外接屏）：接上第二显示器 → 自动出现第二个画布窗口；把卡片拖向屏幕边缘（拖拽中窗口自动扩到虚拟屏）→ 松手后卡片归属新屏；两屏 DPI 不同时位置不错位
9. 调试台点"重建画布窗口"→ 画布窗口全量重建；"重置便签位置"→ 假数据复位

## 开发中踩过的坑（已解决，任务三注意）

0. **禁止每便签一窗口（设计约束，GRILL-PLAN §15 否决记录）**：每窗口 = 一个 WebView2 渲染实例，30 张便签 = 30 个渲染进程，内存爆炸 → 必须单画布窗口 + `SetWindowRgn`（spike 已按此实现）。

1. **Tauri v2 事件监听必须持有 `EventId`**：`app.listen()` 返回的 EventId 被 drop 即注销监听器。必须存进 state（`Inner.event_ids`），否则前端 emit 全部静默丢失。
2. **Tauri v2 capability 默认只授权 `main` 窗口**：动态创建的窗口（`canvas-*`）需要把 `capabilities/default.json` 的 `windows` 改为 `["main", "canvas-*"]`，否则 `event.emit` 等全部被权限拒绝（报 `event.emit not allowed on window "canvas-0"`）。
3. **WebView2 在 `WS_EX_NOACTIVATE` 窗口上不处理鼠标输入**：DOM 收不到 pointerdown。方案：不加 NOACTIVATE；窗口在底部本就不抢焦点，点击卡片时正常激活 = 编辑模式，失焦后 WinEvent 检测回压。
4. **`always_on_bottom` 窗口不能用裸 `SetWindowPos(HWND_TOP)` 抬升**：tao 内部检测到 z-order 不在底部会强制压回，前台被系统切给别的窗口。编辑激活必须走 Tauri API `set_always_on_bottom(false)` + `set_focus()`。
5. **`set_focus()` 是异步消息**：编辑开始后前台切换有延迟，失焦检测要加 ~1.5s 宽容期（`editing_since`），否则点击瞬间的 FOREGROUND 事件会误杀编辑态。
6. **`SetWinEventHook` out-of-context 回调在 tao 主线程消息泵里不触发**：必须开专用线程跑独立消息泵（`GetMessageW` 循环），hook 在专用线程注册。
7. **全屏检测不能只靠 `EVENT_SYSTEM_FOREGROUND`**：窗口全屏化（resize）时前台不变，无事件。要组合 `EVENT_OBJECT_LOCATIONCHANGE`（只处理前台窗口的，过滤噪音），且排除桌面窗口（Progman/WorkerW/SHELLDLL_DefView，它们 rect 也是全屏）。
8. **`SetWindowRgn` 空区域 ≠ 恢复区域**：窗口创建后先设空 Rgn（页面加载完成前不拦截任何鼠标），加载完成前端上报卡片矩形后才设真实 Rgn。
9. **tao 窗口标题被截断为单字符**（GetWindowText 返回 's'）：无边框窗口的标题设置行为，不影响功能，别依赖窗口标题。
10. **Win+D 会隐藏置底窗口**（Windows 行为，Sticky Notes 桌贴模式同样如此）：spike 接受此行为；若任务三要抵抗，需监听 `WM_SHOWWINDOW`/shell hook，暂不做。
11. **Rust 环境**：static.rust-lang.org 被墙 → rustup/cargo 走 USTC 镜像（`~/.cargo/config.toml` 已配好）；TOML inline table 不支持多行数组（cargo 会报 unclosed inline table）。
12. **windows crate 0.61 API 差异**：BOOL 在 `windows_core`；`SetWindowRgn`/`EnumDisplayMonitors`/`MONITORINFOEXW` 在 Gdi；`SetWindowRgn(hwnd, Option<HRGN>, bool)`；`GetWindowRect` 返回 Result；`GetDpiForMonitor` 4 参数；tauri 2.11 的 `hwnd()` 直接返回 windows 0.61 的 `HWND`（共享依赖，无转换）。

## 架构备忘（任务三直接沿用）

- **窗口**：`canvas-N` 每显示器一个 + **`drag-layer` 全局一个**（拖动时显示被拖便签副本的顶层小窗，平时隐藏）；画布窗口创建 = `WebviewWindowBuilder`（transparent/decorations(false)/shadow(false)/always_on_bottom/skip_taskbar/resizable(false)/focused(false)）+ `WS_EX_TOOLWINDOW` + 初始空 Rgn；拖拽层 = 普通窗口（不置底），尺寸 = 卡片 + 30px 阴影边距（前端按自身 DPR 动态 setSize）
- **坐标**：全链路物理像素、虚拟屏坐标系；前端 CSS px ↔ 物理 px 用 `devicePixelRatio` 换算；显示器归属 = 便签中心点落在哪个 rcMonitor
- **线程**：主线程（tauri）+ watchdog 线程（拓扑检测/回压，800ms）+ WinEvent 消息泵线程（前台/全屏事件）
- **状态**：`Arc<Mutex<Inner>>` 挂 tauri state；编辑宽容期 `editing_since`；拖拽层就绪/显示/DPR 状态
- **IPC**：前端 emit（canvas-init/update-regions/drag-start/drag-move/drag-end/drag-cancel/card-focus/card-blur/drag-layer-ready）→ Rust listen（EventId 必须持有）；Rust → 前端 emit（notes-for-canvas/edit-end/drag-layer-show/drag-layer-shown）
- **拖动流程**：pointerdown 记抓取偏移 → 移动超 4px → drag-start（便签物理位置）→ Rust 显示拖拽层（注入内容 + HWND_TOP + SHOWNOACTIVATE）→ 回执 drag-layer-shown → 前端隐藏原卡片 → 每帧 drag-move（rAF 节流）→ Rust 移动拖拽层（clamp 虚拟屏）→ 松手 drag-end（坐标更新 + 便签排末尾 + 隐藏拖拽层 + 全量重发）
- **假数据**：`default_notes()`，重启重置

## 待办 / 遗留

- [ ] 编辑/勾选不持久化（spike 已知限制）：文本编辑、checklist 勾选只改本窗口 DOM，重渲染（拖动/重建）即丢失、重启重置——任务三接数据层后统一处理（journal 追加 + 同步）
- [ ] 多显示器实机验证（两台 Win10 各一遍 + DPI 125%/150% 差异）
- [ ] 编辑蓝色 outline 在注入点击下未观察到，真实用户操作人工复核（代码路径已通：class 添加 + CSS outline）
- [ ] 游戏/视频真实全屏场景验收（spike 用窗口全屏化模拟验证了事件链路）
- [ ] 任务三：真实数据层 + journal + 同步引擎，用 `.env` 的 `SLIP_TOKEN_WIN1/WIN2` 接服务器；local API(60000) 语义与 server API **不同**（本地序号 + `pending_sync` + 显式 `POST /sync`），不要同构（GRILL-PLAN §15 否决记录）；本地 journal 只追加、永不被 sync 覆盖（铁律 3）；AI 写 `author="ai"` + batch 分组撤销

## 已修 bug（2026-08-13 用户反馈）

1. **拖动时画布被隐藏**：拖动画布窗口会放大到虚拟屏包围盒（单屏=全屏尺寸），而全屏检测把"前台窗口 rect ⊇ 显示器 rect"判为全屏 → 画布窗口自己成了前台被误判隐藏。修复：全屏检测前排除画布窗口自身（`fg_is_canvas` 直接跳过）。
2. **便签越拖越大**：`getBoundingClientRect` 返回含 padding 的 border-box 尺寸，而 `.note-card` 默认 content-box，每次拖动都把 padding 重新计入 → 尺寸循环累积。修复：`.note-card { box-sizing: border-box; }`。
3. **拖出窗口边缘便签消失**：单屏下窗口"放大到虚拟屏"= 原尺寸（无实际放大），卡片拖出窗口边界被 WebView2 裁剪。修复：拖动时把卡片位置 clamp 在窗口内（单屏=显示器、多屏=放大后的虚拟屏）。
4. **拖其他窗口时便签闪烁**（两个叠加原因）：
   - 带标题栏的普通窗口（最大化/拖到屏幕边缘）矩形覆盖显示器被误判全屏 → 画布反复 hide/show。修复：全屏判定要求窗口**无标题栏**（`WS_CAPTION` 未设置），有标题栏的窗口即使矩形覆盖显示器也不算全屏。
   - `EVENT_OBJECT_LOCATIONCHANGE`（窗口拖动时密集触发）里也执行了置底回压，频繁 `SetWindowPos` 引发 z-order 抖动。修复：LOCATIONCHANGE 事件只做全屏检测，回压与编辑失焦只在 `EVENT_SYSTEM_FOREGROUND` 里做。
5. **点击便签进入编辑后被立即误杀**：`on_foreground_change` 的"非编辑画布回压"无条件 `push_bottom`，在画布**刚被点击激活**（前台=画布）时把它压回底部 → Windows 把前台切走 → 编辑失焦检测误杀编辑态。修复：回压跳过前台画布窗口（与 watchdog 一致）。
6. **窗口创建用 logical 像素传物理坐标（DPI 炸弹）**：`WebviewWindowBuilder::position/inner_size` 的 f64 版本按 logical 解释，而 rect 是物理像素。100% DPI 下两者相等（本机实测没暴露），**125%/150% 缩放下窗口会错位/超屏**——这正是"多显示器 DPI 待验证"里埋的雷。修复：build 后用 `set_position(PhysicalPosition)` + `set_size(PhysicalSize)` 物理 API 强制修正。
7. **拔掉显示器后旧画布窗口残留**：`rebuild_canvases` 按 `monitors.len()` 关闭旧窗口，显示器数量减少时旧索引窗口（如 `canvas-1`）永远不会被关闭，成幽灵窗口。修复：遍历关闭所有 `canvas-*` label 窗口。
8. **跨画布切换编辑时旧窗口不回压**：在 A 屏编辑中点 B 屏卡片，`card-focus` 只把 `editing` 指向 B，A 窗口保持激活态（`always_on_bottom(false)`）永远置顶；失焦逻辑只清理 editing 指向的窗口，管不到 A。修复：`card-focus` 时先 `deactivate_editing` 旧编辑窗口。
9. **多屏拖拽后卡片错位**：前端 `drag-end` 时 `refreshWinPhys` 拿到的是拖拽放大状态（虚拟屏原点）的位置，而 Rust 端收到 drag-end 后先 `shrink_back` 再重发 notes——渲染时 `winPhys` 已过期。单屏（虚拟屏原点=显示器原点）无差异，多屏必错位。修复：`renderNotes` 开头重新 `refreshWinPhys`。
10. **编辑宽容期跳过全屏检测**：编辑开始 1.5s 宽容期内 FOREGROUND 事件直接 `return`，期间进入全屏画布不会隐藏。修复：宽容期只跳过失焦判定，全屏检测照常。
11. **`.gitignore` 的 `*.png` 误伤 `src-tauri/icons/`**：14 个 png 图标全被忽略，clone 后 `tauri build` 缺图标失败。修复：加 `!src-tauri/icons/*.png` 例外。
12. **checklist 卡片点击闪激活窗口**：无 `.text` 可编辑内容也进编辑态（勾选 checkbox 时窗口反复激活置顶）。修复：无可编辑正文不进编辑态。
13. **调试台"隐藏"后无法恢复**：隐藏后没有任何入口能找回调试台。修复：改为最小化（任务栏可恢复）。
14. **健壮性**：7 处 `inner.lock().unwrap()` 与 2 处 `HOOK_APP` 锁 unwrap 全部改为 `if let Ok`（毒锁不 panic）；移除 Cargo.toml 未用 feature；删除前端 `document.title` 调试残留。
15. **拖动时便签被普通窗口遮挡**：画布窗口始终置底（`always_on_bottom` + watchdog 回压），拖动时窗口虽放大但 z-order 不动 → 便签拖到浏览器/资源管理器等窗口下方被遮住。修复：`drag-start` 时窗口抬升到最顶（先 `set_always_on_bottom(false)` 再 `SetWindowPos(HWND_TOP)`，否则 tao 会把非底部的置底窗口强制压回，见踩坑 #4；`SWP_NOACTIVATE` 不抢前台），`drag-end` 时恢复置底 + 回压。拖动期间窗口是前台，watchdog 不会误压。
16. **拖动中断卡死状态**：`pointercancel`（系统夺走指针）时窗口停在"放大+抬升+无区域"状态，整屏透明窗口在最顶挡住鼠标。修复：前端 `pointercancel` → emit `drag-cancel` → Rust 缩回本屏 + 恢复置底 + 重发便签重算 Rgn。
17. **拖动层级持久化**：拖完的便签移到 `notes` 数组末尾 → 重渲染时 DOM 顺序最后 = 同窗口内层级最高（"刚拖的置顶"），被它压住的便签解除遮挡。
18. **拖动时全屏窗口闪现**（抬升生效后新引入）：`drag-start` 的 `clear_region` 把窗口区域全开（全矩形），而 tao 的 `set_always_on_bottom(false)` 内部会调用 `InvalidateRgn(整个窗口)` 强制整窗重绘（`window_state.rs`：flag 变化 → `SetWindowPos(HWND_NOTOPMOST)` + `InvalidateRgn(None)`，主线程内同步执行）——WM_PAINT 处理时窗口已抬到最顶、区域已清 → 整窗重绘。tao 透明实现 = `DwmEnableBlurBehindWindow`（空区域 blur 技巧），重绘间隙 DWM 合成未就绪时窗口以**不透明帧**显示 → 全屏闪现（偶发 = 合成器状态不定）。**治本：拖动期间区域永不全开**——删掉 `clear_region`，新增 `drag-move` 事件每帧上报所有卡片矩形（rAF 节流，Rust 侧 24px 膨胀容差 IPC 延迟）→ 区域随时跟随便签，任何重绘（InvalidateRgn/区域变化/resize）都被窗口区域裁剪在卡片矩形内 → 透明间隙最多闪卡片本身（不透明，无感）。另：`drag-end`/`drag-cancel` 改为**先压底再缩回**（restore 的 InvalidateRgn 重绘时区域仍是卡片并集；shrink 的 resize 合成间隙在底部被其他窗口遮住）。
19. **拖动把所有便签提到最高**（抬升画布窗口的副作用）：窗口 z-order 是原子操作，同屏便签共享一个画布窗口，抬升 = 全部浮顶。**治本：拖拽层窗口方案**——新增全局 `drag-layer` 窗口（普通窗口、平时隐藏），拖动时把**被拖便签副本**注入拖拽层并 `HWND_TOP` 抬升，画布窗口全程不动（其他便签保持在桌面层）；拖动中每帧 `drag-move` 移动拖拽层（clamp 虚拟屏），松手 `drag-end` 隐藏拖拽层 + 坐标更新 + 重渲染。拖拽层是普通窗口（无 always_on_bottom flag）→ 无 tao 的 InvalidateRgn 问题，全屏闪现根源（#18）随之消失，`expand_for_drag`/`shrink_back`/`raise_for_drag`/`restore_after_drag` 整套删除。附带修复：`drag-layer-show` 内容注入按自身 DPR 换算尺寸；未就绪时降级（不隐藏原卡片、clamp 窗口内拖动）。
20. **拖拽层方案审查修复**（reviewer 全链路审查）：① 落点不 clamp → 便签可被拖出虚拟屏外永久消失（drag-move 只 clamp 层视觉位置，drag-end 上报原始值直写坐标）→ drag-end 写入前同规则 clamp；② 拖动中拓扑重建（拔显示器）→ 画布销毁 → pointer 事件终止 → 拖拽层残留屏幕 + 卡片永久隐藏 → `rebuild_canvases` 先 `dismiss_drag_layer`；③ drag-layer DPR 只就绪时上报一次，跨 DPI 屏过期 → drag-start/drag-move 改 `GetDpiForWindow` 实时重查；④ 拖拽会话无 id，迟到回执可误伤新拖拽 → drag-end/cancel 时前端复位 `dragLayerShown`（概率极低，未做完整 session id）；⑤ 降级时每帧发 drag-move 浪费 IPC → 未显示时跳过。
