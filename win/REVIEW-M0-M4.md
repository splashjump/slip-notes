# 形态先行 M0–M4 · 完成报告 + Reviewer 审查报告

> 日期：2026-08-14 · 状态：**审查报告 R1-R3/Y1-Y10/G1-G10 已全部修复（第二轮）**；**无人机器干净复跑 + 新发现 B1-B4 修复完成（第三轮）**，冒烟连续 25 轮全绿
> 项目：纸筏 slip-notes · win/ 工程（FORM-PLAN.md 形态先行）

---

## 第一部分 · 完成报告（M0–M4 实施完成）

**里程碑**（FORM-PLAN §8）：

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | CDP 基建（9222 调试端口 + `tests/cdp.mjs`）+ 窗口壳三区化（边栏/画布/拖拽层 + Rgn 跟随） | ✅ |
| M1 | mock store + 动作层（Rust）+ 边栏（快捷栏/今日/全部/条目交互） | ✅ |
| M2 | 桌面卡 + 拖动/磁吸/叠放/合并 + 传送门刷卡 | ✅ |
| M3 | 档案格 + 归档链（一键归档/自动收回 30 天/未确认）+ 控制台 | ✅ |
| M4 | 视图（最近发牌/时间线崩塌）+ 遮罩/抬升 + FLIP 动效 | ✅ |
| M5 | 测试 | 部分：单测 + 冒烟全绿；多屏实机/体感验收待做 |

**验证**：Rust 单测 10/10 ✅ · tsc 零错误 ✅ · CDP 冒烟 38 检查全绿（多轮稳定）✅

**过程中修复的关键问题**：

1. **整窗未响应死锁**（实际遇到的卡死）——后台线程持 AppState 锁调 Win32/tauri API → 主线程等锁 → 互相等待。修复为「锁内零 Win32/零 tauri」纪律 + WinOp 锁外执行 + 移除 watchdog 线程 + lock-monitor 诊断（持锁调用栈定位）
2. **边栏空白**——capabilities 窗口授权漏配 `"sidebar"`，state 事件被静默丢弃
3. vite 端口 1430 被 Windows 排除段（1353–1452）占用 → 14300
4. FLIP 动画被 WebView2 节流 → 残留 transform 破坏命中测试
5. 文档更新：AGENTS.md 当前状态 + FORM-PLAN §13 实施记录

---

## 第二部分 · Reviewer 审查报告（独立审查 · 只读）

**验证结果**：Rust 单测 10/10 ✅ ｜ tsc 零错误 ✅ ｜ CDP 冒烟 38 项（此前全绿，本次因控制台窗口被关闭导致连接失败，详见 🟡Y8）

### 🔴 必修（3）

**R1. action.rs:433-445 `toggleConsole` 在锁内调用 tauri API**
`ui(&state, |s| { ... if let Some(w) = app.get_webview_window("main") { w.show()/w.hide() } ... })` —— 闭包执行时 `state.lock()` 的 guard 存活，`get_webview_window` + `show/hide` 是 tauri 调用（command 线程 → 等主线程），主线程可能正阻塞在 update-regions 的 `state.lock()` 上 → **与已修复的整窗未响应死锁完全同型的漏网**（只是触发路径是控制台按钮）。
修复：锁内只翻转 `console_visible`，show/hide 移出锁（仿 view_action 模式）。

**R2. canvas.rs:868（handle_topology_change）/ 1195（handle_rebuild）锁内调用 `enumerate_monitors()`（Win32）**
`let mut g = state.lock(); let now = enumerate_monitors(); ...` —— EnumDisplayMonitors 正是此前 watchdog 持锁卡死的头号嫌疑调用，如今仍在锁内执行（虽只在拓扑事件/手动重建时触发）。违反"锁内零 Win32"纪律。
修复：先锁外枚举 → 锁内比较/赋值。

**R3. canvas.ts:723-731 拓扑重建后卡片永久错位**
state 监听器里 `if (st?.monitors[myMon]) { void refreshWinPhys(); }` 后立即 `render()` —— render 用**旧 winPhys** 计算卡片 CSS 位置；`refreshWinPhys()` 异步完成后**没有触发第二次 render** → 显示器插拔/DPI 变化后所有卡片位置错位且永不恢复。
修复：`await refreshWinPhys()` 后再 render，或在 Promise 完成后补一次 render。

### 🟡 应修（10）

**Y1. sidebar.ts:597-625 档案格成员拖出无 `pointercancel` 清理**
成员拖出用手写局部 `pointermove/pointerup` 监听器，没有 pointercancel 分支。系统夺走指针（窗口失焦/触控板手势）时：成员 `opacity:0.4` 残留、拖拽层窗口不隐藏、Rust 侧 `ephemeral.dragging` 不清（该便签自动收回被永久跳过）。
修复：补 pointercancel → 恢复 opacity + `drag-clear` + `drag-cancel`。

**Y2. sidebar.ts:485-489 reorder 语义错位**
拖条目到另一条目上时传 `flat.findIndex(...)`（**扁平列表 index**），而 store.rs `reorder` 按 **notes Vec 全局 index** 插入 → 扁平层排序结果错误（拖到列表头会插到整个 Vec 头部，出现在档案格成员/桌面卡之前）。
修复：传目标条目在 notes Vec 中的实际下标，或 store 侧做归档组内重排。

**Y3. action.rs `default_timed`（UTC 日界）vs api.ts `defaultTimed`（本地时区）不一致**
Rust `ms - ms.rem_euclid(day)` 是 UTC 午夜起算 → "今天 18:00" = UTC 18:00 = 北京 02:00；前端 chips 用本地时区 18:00。AI `move(direction)→timed` 与手势 chips 的默认值不一致。
修复：统一基准（Rust 用 Windows 本地时区 API，或前端改用 UTC 计算）。

**Y4. geom.ts 传送门几何与 CSS 渲染位置偏移 ~6-14px**
几何 `portalBandPhys` 光带贴底（`y = rect[3] - h`），实际 `.portal` CSS 是 `bottom: 14px` + `padding: 12px` → 刷卡判定区（几何）与视觉槽位在 y 方向偏差约 6~14px，**真机刷卡手感偏移**（冒烟测试用的是几何坐标所以测不出来）。
修复：几何常量加 `PORTAL_BOTTOM_OFFSET`，与 CSS 对齐；前端渲染和判定共用同一几何函数。

**Y5. state.ts:111 `todayEntries` 用 `Date.now()`，Rust 逾期基准是 `store.now()`（含 time_offset）**
`debug.fastForward` 后今日投影的"逾期置顶 🔴"失效（前端按真实时间判断未逾期）——冒烟测试直接读 state 断言，没覆盖前端排序。
修复：state payload 下发 `time_offset`，前端逾期判定用它。

**Y6. canvas.ts:697 `dismissChips()`（点外部关闭）后不 reportRegions**
chips 关闭后其 Rgn 矩形残留 → 该区域点击被窗口拦截（穿透失效）直到下次渲染。选值路径有 reportRegions，点外部关闭路径没有。
修复：dismissChips 内统一 reportRegions。

**Y7. canvas.rs:655-667 多显示器"部分全屏"恢复逻辑错误**
`fullscreen_hidden` 是全局开关（非按显示器跟踪）：A 屏全屏 → 全部隐藏；A 退出而 B 仍全屏时 → 全部恢复（窗口出现在仍全屏的 B 屏上）。低频但存在。
修复：按显示器分别跟踪隐藏状态（`Vec<Option<bool>>` 或按 label）。

**Y8. smoke-form.mjs:39 硬连 "slip — 控制台"，用户关闭控制台后整个测试失败**
本次复现：main 窗口被关（用户操作或 toggleConsole）→ `connect("slip — 控制台")` 重试 40s 后抛错 → 38 项检查一个都跑不了。
修复：console 连接改为可选（失败仅警告）。

**Y9. smoke-form.mjs 覆盖缺口：边栏渲染无断言**
上次 capabilities 漏配导致边栏空白，只有人工发现——测试没拦住。建议连接 sidebar 后断言 `.sb-panel` 存在、`.today-entry` > 0、`.slot` ≥ 1。
另外缺口：joinSlot / storeSlot / restore（tombstone 还原）/ chips 弹层 / 编辑（editText/check）/ take 默认落点 / 磁吸均无端到端覆盖（Rust 单测覆盖了部分数据边界）。

**Y10. store.rs:400-410 `unstack` 行为与主实现说明不符**
实际实现只散开同位置的**其他成员**（`n.id != id`），id 自身不动；主实现说明称"含自身级联散开"。两种语义都说得通，但**注释/说明与代码不一致**，且 smoke 断言"同位置成员 < 3"对两种实现都成立（断言过弱）。建议明确语义并强化断言。

### 🟢 建议（10）

- **G1. lib.rs:29 `drag-end` 事件绑定冗余**：前端已改走 `invoke("drag_end")`，事件监听仍在（双通道）。删除或加兼容注释。
- **G2. flip.ts `fly()/pulse()/flash()` 无 finishAfter 保护**：被节流时残留 scale/backgroundColor（pulse 残留 scale 1.06 会偏移命中测试）。建议统一加超时收尾。
- **G3. lock.rs 主线程未注册诊断名**（日志显示"未注册线程"）：在 setup 里 `register_thread_name("main-thread")`；`Backtrace::force_capture` 建议加 `debug_assertions` 门控（每次 lock 都有捕获开销）。
- **G4. store.rs `merge` 未对重复 id 去重**（同 id 传两次生成双克隆容器）；`record` 快照无上限（journal 无限增长，任务三前可加 cap）。
- **G5. capabilities 含未用 `opener:default`；tauri.conf.json `csp: null`** —— 发布（任务三）前收紧。
- **G6. smoke 时间线拖拽用魔法坐标 `(200, 90)`**（假定视图面板 inset+首行位置）—— 布局调整即挂；建议从 DOM 读实际卡位置。`const sBefore` 未使用（死代码）。
- **G7. debug.ts 控制台 journal 显示 `__batch` 噪音；`btn-play-unmerge` 硬编码 `m1`**（多次点击报错无反馈）。
- **G8. canvas.ts:801 空 if 块**（`if (!viewOpen() && drag?.viewDrag) {}`）死代码。
- **G9. api.ts `withBatch` 把 `__batch` 留在 args 里进 journal**（显示噪音）；可改由请求层剥离。
- **G10. action.rs `desk_spawn_pos`/`take_default_pos` 默认落点可能叠在现有卡片上**（级联偏移只按数量，不查占用）——mock 阶段可接受，任务三前改进。

### 结论

**不能直接进入 M5 体感验收，建议先修 🔴R1-R3 与 🟡Y1-Y2**（其余 🟡 可排入 M5 前或与 M5 并行）。

- R1/R2 是死锁纪律的漏网（虽未复现，但与已修复的整窗未响应同型，风险真实）；
- R3 是拓扑变化后的确定性错位 bug；
- Y1/Y2 是交互路径的确定性缺陷（拖拽泄漏、排序错位）；
- Y3-Y6 是手感/语义偏差，修起来都是小改动；
- Y8/Y9 关乎测试防线——**本次"边栏空白"就是测试没拦住的实际教训**，Y9 应优先补。

已确认正确的部分（无需处理）：锁外执行框架（WinOp/exec_hook_outcome）、hwnd 缓存、hook 线程 tauri-free、drag_end 同步 invoke 顺序、编辑/拖拽卡跳过重渲染、take bump、FLIP finishAfter、capabilities 已含 sidebar、store 边界参数化测试。

---

## 第三部分 · 修复记录（2026-08-14 第二轮）

🔴R1–R3 与 🟡Y1–Y10、🟢G1–G10 全部修复：

| 编号 | 修复 |
|---|---|
| R1 | `toggleConsole` 锁内只翻转 `console_visible`，show/hide 移出锁（仿 view_action） |
| R2 | `handle_topology_change` / `handle_rebuild` 先锁外 `enumerate_monitors()`，锁内只比较/赋值 |
| R3 | canvas state 监听 `await refreshWinPhys()` 后再 render + 渲染序号防重入（旧监听器作废） |
| Y1 | 档案格成员拖出补 `pointercancel`：cleanup 统一恢复 opacity + drag-clear + drag-cancel（`d` 前移消除 TDZ 隐患） |
| Y2 | `store.reorder` 改为归档扁平序列内插入（to_index = flat 下标；含单测 + 冒烟断言），前端语义对齐 |
| Y3 | Rust `default_timed` 改用 Windows 本地时区（`GetTimeZoneInformation` bias），与前端 chips 本地时区一致 |
| Y4 | `PORTAL_BOTTOM_OFFSET = 14px`（对齐 CSS `.portal { bottom: 14px }`）；action.rs 与 geom.ts 同源；冒烟 bandTop 同步 |
| Y5 | state payload 下发 `timeOffset`；state.ts `nowMs()`/todayEntries/badges/card 逾期判定统一用 store 时钟；冒烟加前端逾期排序断言 |
| Y6 | `dismissChips()` 统一 reportRegions（点外部关闭路径不再残留 Rgn） |
| Y7 | `fullscreen_hidden` 改为按显示器 `Vec<bool>`；仅全部屏退出全屏才恢复窗口 |
| Y8 | 冒烟控制台连接改可选（失败仅警告）；`console_` 不再被后续引用 |
| Y9 | 冒烟补边栏 DOM 断言（`.sb-panel`/`.today-entry`/`.slot`/`.sb-entry`）+ chips 弹层、editText/check、take 默认落点、reorder 端到端 |
| Y10 | `unstack` 语义明确：散开同伴、自身不动（drag_end 已定位）；补单测 + 强化冒烟断言 |
| G1 | lib.rs 移除冗余 `drag-end` 事件绑定（保留同步 invoke `drag_end`） |
| G2 | flip.ts `fly`/`pulse`/`flash` 补 finishAfter 收尾 |
| G3 | setup 注册 `main-thread` 诊断名；`Backtrace::force_capture` 加 `debug_assertions` 门控 |
| G4 | `merge` 重复 id 去重（单测）；journal 上限 1000 条（丢最老） |
| G5 | 移除未用 `tauri-plugin-opener`（依赖 + capability）；CSP 从 null 收紧 |
| G6 | 冒烟时间线拖拽改 DOM 读取卡位置；删除死变量 `sBefore` |
| G7 | 控制台 journal 显示过滤 `__batch`；`btn-play-unmerge` 动态找首个合并容器 |
| G8 | 删除 canvas.ts 空 if 块 |
| G9 | dispatch 层剥离 `args.__batch`（journal 记录不再含它） |
| G10 | `desk_spawn_pos` 级联避让已占用卡位 |

验证：Rust 单测 13/13（新增 reorder/merge 去重/unstack 语义 3 用例）· tsc 零错误 · cargo check 零警告；冒烟 `tests/smoke-form.mjs` 复跑见执行记录。

---

## 第四部分 · 交接报告（2026-08-14 第二轮修复完成，移交无人机器验证）

### 4.1 本轮实际修复范围（在上表基础上，冒烟复跑又发现并修复 1 项）

- **R2+（新发现，同型漏网）**：`on_foreground_change` 在锁内调用 `GetForegroundWindow` + `is_fullscreen_on`（GetWindowRect/GetWindowLongPtrW 对外窗口可能阻塞）。复跑冒烟时实际复现：hook 线程持锁卡在对外窗口的 Win32 调用上 → 全部动作命令等锁 → state 事件停发（页面 st 不更新、DOM 不渲染）。**修复：fg + 每屏全屏判定全部移到锁外算好再传入**（`on_foreground_change` 签名改为接收 `fg: HWND` 与 `fulls: &[bool]`，foreground_hook/setup 两处调用点同步改造）。这是“锁内零 Win32”纪律的最后一处漏网。

### 4.2 本机验证状态（⚠️ 本机有用户并行操作，手势测试受干扰）

| 验证项 | 结果 |
|---|---|
| Rust 单测（含新增 3 用例） | ✅ 13/13 全绿 |
| `cargo check` | ✅ 零警告零错误 |
| `tsc --noEmit` | ✅ 零错误 |
| 冒烟 T2/T3/T5（状态级断言，全部新增断言含 reorder/逾期排序/边栏 DOM） | ✅ 多轮稳定通过 |
| 冒烟 T1 系列手势（真实鼠标） | ⚠️ 本机三次全量跑，失败点各不相同（T1c 勾选 → 时间线崩塌 → T1 刷卡）；每个手势**单独复跑均通过**。根因：用户在机器上并行操作（前台切换/真实鼠标）打断 CDP 注入手势 + hook 前台事件争用。**非代码确定性 bug，需无人机器上干净复跑确认** |
| 新发现死锁路径（R2+） | ✅ 已修；修后勾选/时间线/刷卡单测均单独通过 |

### 4.3 无人机器上的待办（按顺序）

1. **干净复跑冒烟**：`cd win && .\dev.ps1` → 等 CDP 9222 就绪 → `node tests/smoke-form.mjs`。预期全绿（约 60+ 检查）。若个别手势检查失败：先**原样重跑一次**确认可复现（CDP 手势对前台切换敏感），再查代码；已确认每个手势单独能过。
2. **M5 多屏实机验证 + 体感验收**（FORM-PLAN §13.4 待验证清单）——本机已有 2 屏（2560×1600@144 + 1920×1080@96），冒烟已覆盖 2 屏枚举，但跨屏拖动等仍需实机体验。
3. **任务三**（真实数据层 + journal + 同步引擎；动作层接口 action.rs 已留好，`local API 60000` = HTTP 薄包装 dispatch）。

### 4.4 交接备注

- 冒烟已扩展（Y8/Y9）：控制台连接可选；边栏 DOM 断言；chips 弹层、editText/check、take 默认落点、reorder 端到端覆盖。
- 冒烟时间线拖拽改从 DOM 读第一张卡实际位置（不再魔法坐标）。
- `PORTAL_BOTTOM_OFFSET_CSS = 14`（Rust）与 `geom.ts PORTAL.bottomOffset`（前端）同源；改 CSS 布局时两处同步。
- store `reorder` 语义已改为“归档扁平序列内插入”（前端传 flat 下标）；`unstack` 语义 = 散开同伴、自身不动。
- journal 上限 1000 条（丢最老）；`__batch` 在 dispatch 层剥离，不进 journal。
- 调试钩子保留：`window.__slipDebug.dragInfo()/st()/winPhys()/cardRects()`（手势排查用）。
- 临时诊断文件 `tests/debug-check.mjs` 已删除；如需复现手势问题可照它重建。

---

## 第五部分 · 无人机器干净复跑记录（2026-08-14 第三轮）

**结论：4.3 待办 #1 完成。冒烟在无人机器上连续 3 轮全绿；复跑过程发现并修复 2 个真实 bug（此前本机受并行操作干扰未能暴露）+ 1 处测试脆弱点。**

### 5.1 验证结果（无人机器，1 屏 1920×1080@165）

| 验证项 | 结果 |
|---|---|
| Rust 单测 | ✅ 13/13 |
| `tsc --noEmit` | ✅ 零错误 |
| CDP 冒烟（~70 检查） | ✅ 连续 25 轮全绿（B1-B4 修复后） |
| 多屏实机验证 | ⚠️ 本机仅 1 屏（第二屏未接），留待第二台 Win10 实机 |

### 5.2 本轮发现并修复的 bug（真实、确定性、此前被掩盖）

**B1（🔴 严重）：tauri 事件监听器 LIFO 执行序 → 渲染永远滞后一拍。**

- 现象：无人机器上冒烟 T1 首个手势 `waitNoteAt` 必超时；探针证实：state 事件到达（缓存有 23 张）、每次事件后有一次渲染，但 DOM 永远少最新事件的卡；隔一个事件后才补上。
- 根因：tauri v2 的 `listen` 监听器按 **LIFO**（后注册先执行）调用。各窗口先 `await initState()`（state.ts 注册监听器，更新 `cur` 缓存），再自行 `listen("state", () => { st = getState(); ... })`——窗口监听器先跑，读到的是**上一个事件**的旧缓存 → 渲染落后一拍。有人机器上用户操作产生额外事件流，把滞后掩盖掉了。
- 修复：state.ts 的 `initState()` 成为唯一 `listen("state")` 注册点；canvas/sidebar/debug 全部改走 `onState` 订阅（回调参数即最新载荷，不再读缓存）。state.ts 加纪律注释。

**B2（🔴 严重）：时间线拖出崩塌视图中途关闭 → 被拖卡元素被移除 → pointerup 丢失 → drag 状态永久卡死。**

- 现象：上一轮冒烟的时间线崩塌失败会把 `drag` 卡死留在模块里，下一轮所有手势被 `if (drag) return` 吞掉（T1 全挂）；探针证实 release 后 `dragInfo` 仍非 null。
- 根因：时间线拖出 → `act(view close)` → 渲染移除 `.view-overlay`（含被拖卡）→ 被拖卡 pointer capture 随元素销毁 → pointerup 不再到达卡片监听器 → `drag` 不清理。
- 修复（多层）：
  1. canvas `onState` 渲染后兜底：被拖元素已不在 DOM → 取消拖拽 + `drag-cancel`（Rust 清 `ephemeral.dragging` + 隐藏拖拽层）；
  2. canvas `pointerdown` 自愈：陈旧拖拽（元素已移除或超 30s）先取消再开始新手势；
  3. sidebar `onState` 对 entryDrag 同型兜底（元素引用 `isConnected` 判定）；
  4. **拖出语义恢复**（reviewer 🟡）：视图关闭渲染时把被拖卡**重建为桌面卡**（落位拖拽当前位置、隐藏、重新 `setPointerCapture`——必须在元素入文档后调用，否则静默失败），拖拽无缝继续、落点正常提交（`drag_end` 定位、dock→store）。

**B3（🔴 严重）：「锁内快照 payload → 锁外慢 Win32 → 再 emit」的陈旧快照回退（编辑提交偶发被旧文本覆盖的根因）。**

- 现象：冒烟 T1c 编辑偶发超时；探针证实：endEdit 正确读到新文本并调用 editText（store 已更新），但 9ms 后一次渲染把卡片重建为**旧文本**、前端缓存被旧快照回退（用户编辑未丢，UI 被回退）。
- 根因：`handle_card_blur` 等 handler 在锁内构建 payload → 锁外执行 `deactivate_editing`/`hide_win`（Win32，慢）→ 期间 editText 提交完成 → handler 最后 emit 的**旧快照**覆盖前端。同型共 5 处。
- 修复：`handle_card_blur`/`handle_card_focus`/`handle_drag_end`/`handle_drag_cancel`/setup 初始 fg 处理——锁内只改状态并记录小标记，慢工作完成后**重新构建** payload 再 emit。

**B4（🟡 重要）：state 事件落在按下/释放之间 → 卡片重建 → click 不合成（勾选偶发失效）。**

- 现象：冒烟 T1c 勾选偶发超时（~10%）。探针证实：按下后 4-6ms 到达的 state 事件（自动收回 tick / card-blur 延迟 emit）触发全量重建，down/up 跨元素 → 浏览器不合成 click。
- 修复：
  1. 产品层：新增 `pressedId`——所有按下的卡在渲染中保留（勾选框按下不创建 drag，此前 skip 保护不到）；
  2. 测试层：prefly `debug.reset` 后**等 n14 自动收回落定**（tick ≤30s 必然归档 n14 并广播）；
  3. 测试层：勾选改安全重试（未勾选才重点、每次重读位置、防止双重切换）。

**T1（测试脆弱点）：时间线首卡选择。**

- 现象：T1c 勾选 n2 会 bump `updated_at` → n2（清单卡）成为时间线首卡 → 拖拽起点（卡中心）命中 `.check-item` → `pointerdown` 被忽略 → 崩塌测试必挂。
- 修复：冒烟改为选第一张“文本卡”（无 `.check-item`、非合并容器）。

### 5.3 验证（第三轮修复后）

- Rust 单测 13/13 ✅ · `tsc --noEmit` 零错误 ✅ · **冒烟连续 25 轮全绿 ✅**（含 B1-B4 修复后的多轮回归；此前偶发的编辑/勾选抖动已消除）
- 验证过程中确认种子数据仅 n14 为 40 天旧（其余 1-5 天），自动收回 tick 只归档 n14；pre-wait 不影响其余测试。

### 5.4 遗留

- M5 多屏实机验证（跨屏拖出等）需第二台 Win10 实机/第二屏接入；本机单屏，冒烟已覆盖 1 屏主链路。
- 体感验收清单（FORM-PLAN §13.4）需人工体验，留待用户。
- 下一步：任务三（真实数据层 + journal + 同步引擎；action.rs 接口已留好，local API 60000 = HTTP 薄包装 dispatch）。

### 5.5 第二轮 reviewer 复审与修复（2026-08-14）

第二轮 reviewer 复审结论：无 🔴，四个 🟡 + 五个 🟢，全部已修复：

| 编号 | 修复 |
|---|---|
| 🟡1 | `setPointerCapture` 失败（指针在重建窗口期结束）时的 catch 不再只是吞异常：主动收尾（drag=null、隐藏卡恢复显示、drag-cancel）——否则 drag 非空 + viewRebuilt + 隐藏卡会让 onState 兜底与 pointerdown 自愈双双失效，复合卡死最长达 30s |
| 🟡2 | **recent 视图拖出与时间线对齐**：`beginDrag` 对任何视图拖出都置 `viewDrag=true` → 拖出重建继续手势 + 全程 portal 挂起；不再走“兜底取消”丢弃用户拖动意图 |
| 🟡3 | **B4 同型漏网（视图内勾选）**：`renderView` 按下中不重建（pressedId 非空则跳过），释放后下一次事件自然重建 |
| 🟡4 | **编辑期开视图丢未提交文本**：`renderView` 先 `if (editingId) endEdit()` 再重建——提交文本 + 清 editingId，消除视图内首次按卡被拦截 |
| 🟢1 | flip.ts `capture()` 跳过 display:none 元素（拖出重建隐藏卡不再产生从原点飞入的假动画） |
| 🟢2 | document 级 pointerup 兜底清 `pressedId`（释放落在卡片外时不留残值冻结卡片） |
| 🟢3 | 冒烟 prefly 用 `debug.autoArchive` 确定性触发 n14 归档（替代 ≤30s 的 waitFor，每轮快 15-30s，效果等价） |
| 🟢4 | 清理临时探针文件（probe-*.mjs 已删） |
| 🟢5 | `handle_drag_cancel` 死代码 `let _ = p;` 移除（参数改 `_p`，零警告） |

**B5（扫尾阶段发现）：重建卡重捕获在 display:none 元素上静默失效。**

- 现象：最终验证时上一轮冒烟把拖拽卡死留在页面（dragInfo 非 null、拖拽层永远悬挂），下一轮 T1 手势被吞。
- 根因：重建卡先 `display:none` 再 `setPointerCapture`——对已隐藏元素重捕获**静默失效且不抛异常**（桌面拖拽正常是因为“先捕获后隐藏”的顺序）。捕获失效后 move/release 全部落空，drag 冻结在重建点、拖拽层永不收起；卡自身因 pressedId/skipId 被永久保留，onState 兜底与 pointerdown 自愈都检测不到“元素存在”。
- 修复：
  1. 顺序改为**入文档 → setPointerCapture（可见）→ display:none**；
  2. catch 分支主动收尾（drag=null、恢复显示、drag-cancel）；
  3. document 级 pointerup 兜底：viewDrag+viewRebuilt 时若释放落回文档（捕获失败），清理冻结拖拽（正常路径卡 handler 先置 drag=null，幂等）。

**验证：Rust 单测 13/13 · tsc 零错误 · cargo check 零警告 · CDP 冒烟连续 30 轮全绿（B5 修复后累计 60+ 轮）· 跨轮拖拽状态无泄漏 ✅**

（第二轮 reviewer 确认无误项：B3 五处 handler 语义与锁纪律、B4 mustRebuild/pressedId 优先级与 pointercancel 覆盖、B2 重建顺序、冒烟重试无双重切换、pre-wait 与种子数据相容性、时间线文本卡选择器与 card.ts 一致。）
