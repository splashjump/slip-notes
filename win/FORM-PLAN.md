# 纸筏 Win 端 · 形态先行实现计划（Tauri 细化 grill 产出）

> 状态：**双审完成**（作者自查 + reviewer 两轮审查，修复整合完毕，可以开工）
> 来源：第二轮 grill-me 结论（2026-08-13）+ reviewer 审查修复 + 用户决策：**直接进 win/ 工程实现**（路径 B）
> 定位：GRILL-PLAN §7（Win 端）的形态级细化；替代 demos/forms/6-archive 的独立 demo 计划（已切掉）
> 技术基础：win/SPIKE.md（画布窗口五项验证 + 拖拽层 + 全屏检测 + 20 条踩坑记录）

---

## 1. 目标与范围

- **形态先行**：把"纸筏档案馆"形态直接实现在 win/ Tauri 工程里，数据层用内存 mock（Rust 侧），不接服务器
- 验证目标：边栏交互手感、档案格自适应排列、传送门刷卡、时间线崩塌、动作层接口设计，以及透明/置底/穿透真实手感下的动效
- 任务三既有内容（真实数据层 + journal + 同步引擎 + local API）不在本计划范围，只留衔接点（§6）
- 用户与 AI 是**同一输入抽象**：所有交互 = 语义动作（动作层），手势与 AI 指令同构

## 2. 总体架构

```
主屏（两个窗口，z-order 解耦）            副屏（每屏一个画布窗口）
┌─ 边栏窗口（独立，宽 270px）─┐            ┌─ 画布窗口 ──────────┐
│ 快捷栏/档案馆/今日/全部      │            │ 桌面卡区（自由摆放）    │
└─────────────────────────────┘            │ 传送门光带（底部）     │
┌─ 画布窗口 ──────────────────┐            └──────────────────────┘
│ 桌面卡区 + 传送门光带（底部）   │
└─────────────────────────────┘
+ 全局拖拽层窗口（跨窗口/跨屏拖动用，SPIKE 复用）

每个窗口 Rgn = 窗口内 UI 矩形并集（无 UI 处点击穿透桌面）

前端手势 → 动作解析 → invoke("action", {name, args, batch?})
                                        ↓
                             Rust: action_handler（唯一数据入口）
                              ├─ mock store：数据态 Vec<Note> + 数据影响型 UI 态（ephemeral）
                              └─ 任务三：SQLite + journal + 同步引擎（同接口）
                                        ↓
                 返回 {ok, notes?, error?, journal?} → 前端 FLIP 渲染
```

**关键架构决策**：
- **动作层落在 Rust**：数据入口唯一化；未来 local API(60000) = HTTP 包装同一 `action_handler`（手势与 AI 天然同构）
- 前端 = 纯渲染 + 手势解析 + 动作调用（无状态）；任务三换数据后端时动作签名/IPC/前端/测试全部不动
- **主屏边栏独立窗口**：点击边栏只抬升边栏窗口（窄条），桌面卡窗口保持置底——避免"边栏常规操作触发整窗抬升"（SPIKE #3/#19 的 z-order 原子性问题）
- **窗口结构**：主屏 = 边栏窗口 + 画布窗口；副屏 = 画布窗口；全局 = 拖拽层窗口（复用 SPIKE）

## 3. 形态设计（第二轮 grill 结论，决策全保留）

### 3.1 实体模型与存在方式

```
Note {
  id, title, text, items[], color,
  created_at, updated_at,               // 时间轴与自动收回基准
  tags: { urgent: bool, timed: {time} | null },   // 便签级标记（先行简化，§10 差异）
  mode: "desk" | "archive",             // 互斥存在方式
  pos: {x,y} | null, lastDeskPos,
  slotId: string | null,                // 所属档案格
  mergeTree: {dir, children[]} | null,  // 合并容器（四宫格产物，便签级简化）
  deleted                               // tombstone
}
ephemeral（Rust 侧，不持久化，影响数据行为的 UI 态）：
  { unconfirmed, borrowing(借用中), dragging(拖拽中) }
前端纯渲染态（不进 Rust）：expanded, seen
```

- 互斥：同一时刻只在一处（desk 桌面卡 / archive 边栏条目·格内）
- 今日 = 投影；视图（时间线/最近）= 借用（mode 不变，关闭/崩塌飞回）
- **自动收回**：`AUTO_ARCHIVE_DAYS = 30`（updated_at 距今 > 30 天未动），**宿主 = Rust 定时器**（ephemeral.dragging/borrowing 中的跳过；AI 路径同样生效）；未确认标记仅来自自动收回
- 索引只在"全部"扁平层（格 = 一个位置）；reorder 仅在扁平层
- **stack 数据语义**：成员 position 对齐同一位置 + order 记录（几何呈现层纯前端）；**merge 数据语义**：mergeTree 容器（上限 4）

### 3.2 边栏（档案馆，主屏独立窗口）
- 宽 270px，可收起（只剩快捷栏竖排按钮：⤢ ➕ 🗄 🕐 ⏱ ⚙；⤢ = 展开/收起切换）
- 展开态：头部（logo/同步灯[离线模式]/收起）→ 按钮行 → 🔥今日投影（常驻）→ 📋全部列表（常驻，含档案格）→ 底部（同步详情 + AI 日志 + 撤销批次）
- 今日：紧急⚡ + 定时⏰（预告/常驻）+ 逾期置顶红🔴；排序 逾期>紧急>定时>已看弱化；勾掉/删除自动移除；点击双态响应（档案→抽出 / 桌面→脉冲[跨窗口时通知画布窗口] / 借用中→先关视图再响应）
- 条目：统一尺寸（标题+5行高）；hover 抽屉露出（短卡全露）、移开落回；click 抽出=钉住（栏内浮层可滚动，再点/拖出收回）；拖出=桌面铺开；边栏内拖动排序；自动收回便签带琥珀"未确认"圆点（点击=确认+尾部弹出 🗑删除按钮 **3 秒后按钮消失（不自动删除）**、未确认态清除；拖出桌面=隐含确认）
- **dock 矩形定义**：主屏边栏窗口矩形（含收起态快捷栏宽度）；副屏无 dock 分支（resolveDropRegion 按"当前窗口是否有边栏"短路）

### 3.3 档案格（特殊纸堆）
- archive 态容器（成员 ≥2）；自动化排列：容量 = floor((格高−边距)/(成员最大内容高+间距))，按实际渲染测量；成员≤容量 → 全平铺，>容量 → 层层叠（顶卡+厚度+×N）
- 格高 320px（保证 ≥2 张平铺）；平铺/堆叠切换 ±1 张迟滞防抖
- 生命周期：成员=1 → 自动解散为扁平条目；创建 = 桌面纸堆整格拖入 / 扁平条目拖入格（joinSlot）；拖出一次一张
- 点击：平铺=抽出单张 / 堆叠=摊开

### 3.4 桌面
- 便签默认 = 标题 + 5 行（截断），点开全文；**展开态拖动瞬间自动收缩再拖**
- 叠放（快速松手，上限 9）/ 合并（停留 800ms，上限 4 四宫格）/ 磁吸（16px + 引导线 + 吸附弹性）
- 新建 = 桌面铺开空卡（发牌动效，聚焦可打字；落点避开光带）

### 3.5 传送门（标记刷卡）
- 底部光带三槽：⚡紧急(红)｜⏰定时(蓝)｜📄恢复(灰)；槽长 210px，总长 ~670px 居中；平时呼吸光效，拖起便签增亮
- 判定：**双条件**——便签 bbox 与槽位水平重叠 ≥ 槽宽 50%（"划过一半"手感）且指针 y 在光带高度带内；**前置：指针不在 dock 矩形内**（dock > portal 优先级，角落冲突消解）；触发即生效（无需松手）；光带闪光
- **视图打开时 portal 判定挂起**（避免与视图拖出语义冲突）
- 标记 set 语义：`tag(id,"urgent",bool)` / `tag(id,"timed",time|null)`；📄=清全部（两次 tag 调用）；⏰ 已标记再刷=改时间
- 动效：⚡颜料桶（颜料流下染红）/ ⏰笔刷（自上而下刷出）/ 📄逆动效（擦除/倒刷）
- ⏰ 松手后弹时间 chips（今天 18:00[默认] / 明天 10:00 / 自定义）；点外部关闭

### 3.6 聚合视图（画布窗口抬升模式）
- **视图打开**：画布窗口**抬升到顶（SWP_NOACTIVATE 不抢前台）+ Rgn = 全屏 + 窗口内全屏半透明遮罩 div（rgba 黑 45%）**——遮罩语义由"Rgn 全屏 + 窗口内遮罩"实现（压暗桌面 + 拦截点击 = 点遮罩关闭）；关闭后压回置底（SPIKE #15 机制）
- 抬升/关闭是低频操作，SPIKE #18 的"重绘间隙不透明帧"风险接受；若体感差 → 视图期间窗口整体不透明深色底兜底
- **最近**：发牌（从按钮向左飞出、错落网格，updated_at 倒序 Top 12）；卡片 hover 放大/点击脉冲/拖出=变桌面态+整个视图关闭；关闭=点遮罩/再点按钮/✕（倒放收回）
- **时间线**：抽卡（全部实体从各自位置 FLIP 汇入；格按块从格位起跳）；**拖动超 80px → 整线崩塌**（其余卡 FLIP 飞回原位；被拖卡经**拖拽层**接手，松手走 resolveDropRegion：dock→store / desk→move / portal→忽略）；点击=脉冲不崩塌；关闭=飞回

## 4. Win 工程化要点

| 项 | 方案 |
|---|---|
| 窗口结构 | 主屏：边栏窗口（270px，右缘锚定，独立置底）+ 画布窗口；副屏：画布窗口；全局：拖拽层窗口。**窗口常态 = 全屏透明**（三区 UI 覆盖整个显示器），Rgn 控制穿透；全屏检测排除自身（SPIKE bug #1 已修） |
| Rgn | 各窗口 = 自身 UI 矩形并集；**动画期间区域 = 起点∪终点矩形并集（几十帧一更）**，动画结束精确化；边栏收起 = 边栏窗口 Rgn 变快捷栏矩形 |
| 拖拽层 | **所有拖动统一走拖拽层**（边栏条目拖出、卡片移动、时间线拖出、跨窗口/跨屏）——动作响应返回后**不重渲染被拖卡**（增量更新其余部分），拖拽上下文不被打断；SPIKE 复用 |
| 遮罩 | 视图期间：画布窗口 Rgn 全屏 + 窗口内全屏半透明遮罩 div；遮罩拦截点击 = 关闭视图 |
| 全屏检测 | 沿用 WinEvent；全屏时**全部窗口隐藏**（含边栏），退出恢复 |
| 坐标 | 三层：CSS px → 物理 px → 虚拟屏；resolveDropRegion 在窗口内 CSS 空间解析（dock=边栏窗口矩形、portal=光带矩形，窗口锚定元素）；跨窗口/跨屏落点由 Rust 按中心归属分发（SPIKE 复用） |
| 多显示器 | 边栏只在主屏（独立窗口）；副屏画布窗口无边栏（dock 分支短路）；光带每屏一条 |
| 编辑/输入 | 桌面卡/边栏条目：contenteditable + 临时激活（SPIKE 已验证）；**文本编辑仅 DOM 层 + mock 的 editText 动作（§5），重渲染不丢** |
| 动效 | WAAPI（WebView2 = Chromium）；透明窗口下 transform/opacity 动画无重绘问题（SPIKE #18 已排除整窗重绘源）；抬升/关闭视图的低频闪现接受（有兜底） |

## 5. 动作层接口（数据/UI 分层）

**IPC**：`invoke("action", {name, args, batch?}) → {ok, notes?, error?, journal?}`；notes 数组承载多实体动作结果；batch 由调用方带标记（AI 批次）

**数据动作**（可同步，未来进 **local API** 契约——与 server API 不同构，见 GRILL-PLAN §15）：
`create` `editText(id, text)` `check(id,itemId,done)` `move(id,{x,y})` `move(id,direction)` `take(id,{x,y}?)` `store(id,index?)` `joinSlot(id,slotId)` `storeSlot(ids)` `archiveAll` `tag(id,"urgent"|"timed",v)` `stack` `unstack` `merge` `unmerge` `reorder` `delete` `restore` `undoBatch(batchId)`（快照式，覆盖数据态 + ephemeral）

- `move(direction)` = 目标区域计算（沿方向找最近区域反查落点，复用 resolveDropRegion）
- AI 精确 `move` 跳过磁吸/合并判定（手势路径另有交互判定层）
- `take` 落点：默认 lastDeskPos / 边栏左侧空白，可传显式坐标

**UI 动作**（纯本地）：`expand` `collapse` `view("recent"|"timeline",open|close)` `confirm`

**mock store**（Rust）：`Mutex<Vec<Note>>` + ephemeral 表 + 动作日志（journal 雏形）+ **自动收回 Rust 定时器**；任务三替换为 SQLite + 版本 + 同步，接口不变

## 6. 与任务三的衔接（本计划不做，留接口）

- 动作层 = local API(60000) 的处理器本体（HTTP 薄包装）
- mock store → SQLite（rusqlite）+ 双线 journal + 同步引擎 + 服务器契约（docs/protocol.md）
- 便签级 tags / updated_at / mode 同步语义 / mergeTree → 按 §10 差异清单决策后进 GRILL-PLAN 与协议

## 7. 测试计划（开发时同步）

| 编号 | 内容 | 手段 |
|---|---|---|
| T1 | 手势 → 动作等价（拖动/刷卡/点击 → 断言动作序列+状态） | **CDP 连 tauri dev**（WebView2 调试端口）——真实 Rust mock |
| T2 | 动作层直接调用（AI 路径） | 页面内 SlipAPI / Rust 单元测试 |
| T3 | 边界参数化：merge≤4、stack≤9、格容量/解散/迟滞、刷卡 50%+dock/portal 角落、崩塌 80px、自动收回 30 天+未确认（时间快进调试指令）、chips 默认今天 18:00 | CDP（同 T1 设施） |
| T4 | 方向语义：move("right")→store / portal→预览 / take 落点 | 动作层直接调用 |
| T5 | 窗口冒烟：Rgn 跟随、拖拽层、全屏隐藏、边栏收起 Rgn、视图抬升/压回 | tauri dev + CDP |
| T6 | 回归：SPIKE 五项能力不破 | tauri dev 手动清单 |
| T7 | 纯 DOM 手势解析单测（无 Tauri 环境） | puppeteer 连 vite 浏览器模式（mock 前端态） |

## 8. 里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M0 | **CDP 基建**（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` + 连接脚本）+ 窗口壳三区化（边栏窗口/画布窗口/光带 + Rgn 跟随 + 坐标适配层） | T5 过 |
| M1 | mock store + 动作层(Rust) + 边栏（快捷栏/今日/全部/条目交互） | T1/T2（边栏部分） |
| M2 | 桌面卡（5行/展开收缩/editText）+ 拖动/磁吸/叠放/合并(4) + 传送门 | T1/T3（手势部分） |
| M3 | 档案格 + 归档链（一键归档/自动收回 30 天/未确认）+ 控制台 | T3（归档部分） |
| M4 | 视图（最近发牌/时间线崩塌）+ 遮罩/抬升 + 动效打磨 | T1/T4 |
| M5 | 全量测试 + 多屏实机验证 + 体感验收（双机同步留给任务三） | T1-T7 全绿 |

## 9. 待验证清单（体感验收项）

- [ ] 边栏独立窗口的激活/回压体验（点击边栏不打扰桌面卡 z-order）
- [ ] 档案格容量算法手感（320px / 平铺 vs 堆叠 / 迟滞）
- [ ] 刷卡 50% 判定 + dock/portal 角落（窄屏 1366）
- [ ] 时间线崩塌（80px 阈值与动画）；视图抬升/遮罩的真实观感（含闪现兜底判定）
- [ ] 边栏 hover 露出量 / click 钉住抽出的阅读体验
- [ ] 光带位置/亮度；全屏时边栏一并隐藏是否可接受
- [ ] 合并上限 4 体感；方向语义（AI 移动）落点合理性
- [ ] 多显示器：边栏仅主屏的观感；跨屏拖出

## 10. 与 GRILL-PLAN 的差异清单（验证后进契约前需决策）

| 差异 | 现状（GRILL-PLAN） | 本计划 | 备注 |
|---|---|---|---|
| 标记粒度 | 提醒精确到清单项（Q6/Q7） | 便签级 tags（先行简化） | 决策是否保留便签级 |
| 时间字段 | 无 updated_at | 增加 updated_at（自动收回 30 天基准） | 与 §5 注意力机制对齐 |
| 同步语义 | position 同步（§7） | mode/archiveIndex/slotId/mergeTree 同步候选；unconfirmed/expanded/seen 纯本地 | 自动收回会重排对端墙 |
| 今日形态 | 虚拟卡片钉左上角（§7） | 边栏常驻投影（收起不可见） | 形态级变更 |
| 本地接口 | 数据层语义（§9） | 动作层（数据/UI 分层），action_handler = local API 本体 | 数据动作子集进 local API 契约 |
| 窗口结构 | 每显示器一画布窗口（包围盒） | 主屏 = 边栏窗口 + 画布窗口（常态全屏），视图期间抬升 + Rgn 全屏 | 与 SPIKE "包围盒"方案不同 |
| 实施顺序 | ③Win 客户端（数据层先行） | 形态先行（mock 数据），数据层后置 | 里程碑 M5 后接任务三 |

## 11. 明确不做（本阶段）

- 真实同步/服务器/多设备；真实 SQLite/journal 持久化（mock 内存）
- 时间线内编辑/收回（只读+拖出）；删除还原 UI（restore 动作 + mock 已删列表，控制台展示）
- 触屏/多点手势；通知/闹钟；卡片虚拟化（30 张内不必要）
- 安卓端（本计划纯 Win）

## 12. 审查记录

- **作者自查（第一轮）**：修 5 处——portal 前置"指针不在 dock 矩形内"；IPC 返回 notes 数组；mock store 限定数据态；T5 补 WebView2 调试端口；M5 双机改多屏
- **reviewer 审查（第二轮）**：4 🔴 + 12 🟡，全部整合——边栏独立窗口（z-order 解耦，🔴1）；视图 = 画布窗口抬升 + Rgn 全屏 + 窗口内遮罩（🔴2）；ephemeral 态进 Rust + 自动收回 Rust 定时器（🔴3）；T1-T3 统一 CDP 连 tauri dev + M0 补 CDP 基建（🔴4）；🟡：dock 矩形定义、mergeTree/stack 数据语义、30 天阈值补回、常态全屏窗口、动画 Rgn 预算、拖动统一拖拽层+不重渲染被拖卡、undoBatch 归数据动作、editText 动作、take 落点参数、3 秒按钮语义、chips 默认值、视图打开 portal 挂起、时间线拖出走拖拽层、local API 措辞、同步灯离线模式
- 未修复项（有意保留，进待验证清单）：视图抬升的低频闪现风险（有兜底）；边栏独立窗口的多窗口 Rgn 开销（实测后评估）

## 13. 实施记录（2026-08-14，M0–M4 完成）

> 本节记录实际实施与计划的偏差及关键工程决策，验证后回填 GRILL-PLAN 时以本节为准。

### 13.1 里程碑完成情况

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | CDP 基建（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，`tests/cdp.mjs` 零依赖连接脚本）+ 窗口壳三区化 | ✅ |
| M1 | mock store + 动作层(Rust) + 边栏 | ✅ |
| M2 | 桌面卡 + 拖动/磁吸/叠放/合并 + 传送门 | ✅ |
| M3 | 档案格 + 归档链 + 控制台 | ✅ |
| M4 | 视图（最近/时间线）+ 遮罩/抬升 + FLIP 动效 | ✅ |
| M5 | 全量测试 | ✅ 无人机器复跑完成：Rust 单测 13 + CDP 冒烟连续 3 轮全绿（~70 检查）；多屏实机/体感验收待第二屏与人工 |

### 13.2 验证资产

- `src-tauri/src/store.rs` 单元测试 10 用例：merge≤4、stack≤9、自动收回 30 天+跳过规则、store/take 往返、slot 操作、tag 清全部、undoBatch 快照、tombstone、时间快进驱动
- `win/tests/smoke-form.mjs`（CDP 连真实 tauri dev）：T1 真实鼠标手势（Input.dispatchMouseEvent 拖拽刷卡/拖入边栏）、T2 动作层往返、T3 边界（快进 31 天自动收回+未确认+confirm、逾期）、T4 视图开合+借用+portal 挂起、T5 窗口壳+边栏收起——38 检查全绿
- 跑法：`cd win && .\dev.ps1`（自动带 CDP 端口）→ `node tests/smoke-form.mjs`

### 13.3 工程决策与偏差

1. **vite 端口 1430 → 14300**：本机 Windows 排除端口段 1353–1452（Hyper-V/WinNAT 保留）包含 1430 → EACCES。dev.ps1/dev.sh/tauri.conf.json 同步改。
2. **锁纪律（重大修复）**：形态版一度整窗未响应——根因：hook/watchdog 后台线程持 AppState 锁调用 Win32（SetWindowPos/SetWindowRgn）或 tauri API（emit/get_webview_window），向主线程 SendMessage；主线程在事件监听器（update-regions）等同一把锁 → 互相等待。修复：
   - 锁内零 Win32/零 tauri 调用；窗口操作收集为 `WinOp` 列表锁外执行；edit-end 等 emit 延后到锁外
   - 窗口 hwnd 缓存（usize）供 hook 线程锁内只读比较；前台/全屏逻辑不再锁内调 tauri
   - **watchdog 线程整体移除**：拓扑检测改由 WinEvent hook 的 EVENT_DISPLAYCHANGE 触发，z-order 回压由前台切换 hook 负责
   - `lock.rs`：AppLock（持锁线程名 + 时长 + 调用栈记录）+ lock-monitor 线程（持锁超 10s 告警，曾成功定位 watchdog/hook 卡死点）
3. **拖拽结束改用同步 invoke `drag_end`**（事件改命令）：先落坐标再执行后续动作（store/stack/merge），顺序有保证。
4. **FLIP 动画节流**：WebView2 在重负载下 WAAPI 动画被节流到 ~1/4 速，卡在半途的 transform 会破坏命中测试（点击落空）。修复：动画超时强制 finish（`flip.ts finishAfter`）+ pointerdown 时取消残留动画；测试侧等待动画结算后再断言。
5. **`take` bump updated_at**：拖出 = 隐含确认 + 重置自动收回时钟（否则快进后取回的便签会被下一轮定时器立即收回）。
6. **undoBatch 经 `args.__batch` 传批次**（前端便捷包装）；smoke 用 `actRaw` 显式传 batch。
7. **重建窗口锁外执行**：`rebuild_windows` 为纯窗口操作（不持锁），WebView2 创建可能阻塞，锁内创建会饿死全部命令。
8. **编辑中卡片不重渲染**：card-focus 的状态事件会重建编辑卡（丢 .editing 与焦点），与拖拽卡同规则 skip。
9. 种子数据含 40 天旧便签（启动 3s 自动收回 → 未确认演示）、叠放 3 张、合并容器、档案格 3 张、定时/紧急便签。
10. **tauri 监听器 LIFO → 渲染滞后一拍（B1，无人机器发现）**：tauri v2 `listen` 后注册先执行；窗口先 `initState()` 再自行 `listen("state")` 读 `getState()` → 读到上一事件旧缓存 → DOM 永远落后一个事件（有人机器被额外事件流掩盖）。修复：唯一监听器留在 state.ts，窗口一律 `onState` 订阅拿载荷。见 REVIEW-M0-M4 §5.2。
11. **视图关闭移除被拖卡 → pointerup 丢失 → drag 永久卡死（B2，无人机器发现）**：时间线拖出崩塌/视图切换会移除被拖元素，pointer capture 随之销毁，`drag` 模块态不清理 → 后续手势全被 `if (drag) return` 吞掉。修复：onState 渲染后兜底取消 + pointerdown 陈腐自愈 + sidebar 同型兜底 + **拖出重建桌面卡继续手势**（重建卡落位拖拽当前位置、隐藏、入文档后重新 setPointerCapture——离树时调用会静默失败）。见 REVIEW-M0-M4 §5.2。
12. **锁内快照 payload → 锁外慢 Win32 → emit 陈旧快照回退（B3）**：`handle_card_blur`/`card_focus`/`drag_end`/`drag_cancel`/setup 在锁内构建 payload，锁外 `deactivate_editing`/`hide_win` 之后再 emit——期间到达的动作（如 editText 提交）被旧快照覆盖，UI 回退（store 正确）。修复：慢工作完成后重新构建 payload。见 REVIEW-M0-M4 §5.2。
13. **state 事件落在按下/释放之间吞 click（B4）**：全量重建使 down/up 跨元素，浏览器不合成 click（自动收回 tick / card-blur 延迟 emit 都会触发）。修复：`pressedId`（按下的卡渲染保留，勾选框按下不创建 drag 也覆盖）+ 冒烟 prefly 等 n14 收回落定 + 勾选安全重试。见 REVIEW-M0-M4 §5.2。

### 13.4 待验证清单（移交 M5/体感验收）

> 2026-08-14 无人机器复跑更新：单机验证完成（冒烟 3 连绿）；多屏/体感项仍需人工。

- [ ] 多显示器实机：边栏仅主屏观感、跨屏拖出（代码就绪；无人机器仅 1 屏，留待第二台 Win10 实机）
- [ ] 边栏独立窗口激活/回压体验、hover 抽屉/钉住阅读体验
- [ ] 刷卡 50% 判定 + dock/portal 角落（窄屏 1366）
- [x] 时间线崩塌 80px 阈值（冒烟已覆盖，含 B2 拖拽卡死修复后复验）；视图抬升/遮罩真实观感（闪现兜底判定）→ 观感部分待人工
- [ ] 档案格容量算法手感（320px/平铺 vs 堆叠/±1 迟滞）
- [ ] 全屏时边栏一并隐藏是否可接受
- [ ] 合并上限 4 体感；方向语义（AI 移动）落点合理性

## 14. 第二轮实施记录（2026-08-15：美化补全 + 拖动链路加固）

> 用户实测反馈三大问题：拖动卡消失/弹到左上角又飞回、视图按钮看不到动画、传送门与设计不符。
> 流程：reviewer 根因诊断（结论：不重写，拖动链路集中加固）→ 实施 → reviewer 复审（1🔴+2🟡+7🟢 已全修）→ 冒烟 5 连绿。

### 14.1 拖动恶性 bug 根因与修复（reviewer 诊断确认）

| 症状 | 根因 | 修复 |
|---|---|---|
| 拖过去不见了 | 叠放 ids 顺序导致被拖卡垫底被盖住；拖拽层渲染无 ack，原卡提前隐藏 | 被拖卡排最后（置顶）；drag-layer 渲染完成 ack（`drag-layer-rendered`→Rust 转发→源窗口再隐藏原卡，450ms 兜底）；归档后边栏条目滚入视野+闪光 + 扫入边栏幽灵动画 |
| 弹到左上角又飞回 | ①视图拖出 grab 用 offsetLeft（view-body 相对坐标，错位 ≈面板 inset）→ 重建卡落左上角；②松手后 capture 拿不到隐藏卡旧矩形 → apply 走 appearFrom 分支从边栏点飞入 | ①视图卡 grab 改 getBoundingClientRect，桌面卡保持 offsetLeft（layout 坐标）；②`skipAnim` 一次性集合：落定卡不播出生动画；③appearFromPoint 物理→CSS 换算修复（副屏返回 undefined）；④drag-move 去 rAF 改时间限频（16ms） |
| 视图按钮看不到动画 | ①WebView2 节流 WAAPI ~1/4 速，finishAfter 420ms 强制收尾＝只看到 1/3；②关闭视图先压回窗口再播动画（被遮挡）；③遮罩无过渡 | ①finishAfter 预算 4×duration+250；②关闭 = 前端先播收回动画（遮罩淡出+FLIP 飞回+幽灵）→ emit `view-anim-done` → Rust `defer_lower` 压回（3s 兜底+序列号仲裁+新视图保护）；③遮罩淡入淡出+面板入场 |

### 14.2 传送门补全（FORM-PLAN §3.5 逐条）

- 光带视觉：conic 彩虹光环旋转 + 顶部光带线 + 呼吸辉光（armed 增亮提速）；槽位主题色 + 底部内辉光 + 图标辉光
- **拖起便签增亮**（此前完全未实现）：drag-start/drag-feedback → `.portal.armed`
- **标记动效**（此前完全未实现）：⚡颜料桶流下染红（pour）/ ⏰笔刷自上而下刷出（brush）/ 📄擦除倒刷（erase）
- 几何对齐：box-sizing:border-box 全局化 + 带总宽 662→690（padX 14）+ 槽位 padding 19px 使带高精确 96（判定区与视觉槽位零偏差）

### 14.3 其它设计补全（对照 §3 差异项）

- 展开态拖动瞬间收缩再拖（drag-collapse 类，4px 阈值后触发——放 pointerdown 会弄坏展开/收起 toggle，reviewer 🔴）
- 新建卡聚焦可打字（focus-note 事件，元素已渲染则立即编辑）
- 磁吸引导线 + 首次吸附弹簧动效（§3.4"引导线+吸附弹性"）
- 叠放上限 9 超限轻晃拒绝；纸堆厚度视觉（成员逐层错开 2px/张）+ 顶卡 ×N 角标
- 合并容器：撕裂方向 dir（row/col，停靠点决定）+ 撕纸线分隔 + 容器标头 + ✂ 拆分按钮
- 时间线 = 全部实体（含归档，§3.6）；最近 = 桌面 Top 12；视图卡点击=脉冲不编辑
- 视图拖出：归档卡落桌走 take；尺寸用 store 原尺寸（时间线卡 560×120 不再污染桌面卡）
- 边栏 toggleView 互斥先关后开；一键归档/归档落点 → 扫入边栏幽灵 + 条目闪光

### 14.4 视觉重构（纸感）

- KaiTi 手写体（卡片正文/标题）、撕纸圆角、纸胶带、按 id 哈希稳定旋转、三层阴影
- 传送门/视图/边栏/chips 全套重做（styles.css 879→~1300 行；全局 box-sizing reset）

### 14.6 乱序事件根治（B3 传输层，复跑发现）

- 现象：冒烟间歇性失败（~25%），诊断为"create 响应返回新卡 id，但 state 缓存/journal 里没有"——state 事件乱序到达：seq 51（含新卡）先到、seq 50（陈旧载荷）后到，最后到达的旧载荷把缓存回退（B3"陈旧快照回退 UI"在事件传输层的同源变体，此前只在锁内快照层修过 5 处）。
- 修复：state payload 增加 Rust 侧全局单调 `stateSeq`；前端 state.ts 丢弃非递增载荷（`payload.stateSeq <= cur.stateSeq → drop`）。与铁律 1（版本号单调递增）同源：状态更新必须单调。
- 验证：修复后冒烟连续 32 轮全绿（修复前 ~25% 失败率）。诊断设施保留：`__slipEvLog`（最近 20 条事件序号）+ `stateSeq` 字段。

### 14.5 复审与验证

- reviewer 复审：1🔴（展开/收起 toggle 回归，已修+冒烟覆盖）+2🟡（unmerge 幽灵残留 pressedId 前置；stackOff 补偿语义错误——叠放路径位置由 stack 动作覆盖，减法纯负资产，已删除）已修；🟢：closingView 被无关 state 事件截断（保持到 timer 收尾）、陈旧 view-anim-done/defer_lower 压回新视图（Rust 检查 view.is_none）、focus-note 竞态、450ms 兜底跨轮误伤（捕获拖拽 id）、T1d 慢机合并阈值 flake（6 步）、portal 带高 96vs98（padding 19px）、set_merge_dir 单测、冒烟补展开/收起断言——全部修复
- 验证：Rust 单测 14/14 · tsc 零错误 · cargo check 零警告 · CDP 冒烟（新增叠放置顶/展开收起断言）连续 5 轮全绿
- 视觉验证：CDP 截图 + vision 模型评审（纸堆厚度/×3 角标/胶带/传送门光环/时间线遮罩均确认）
