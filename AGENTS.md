# AGENTS.md — 纸筏 (slip-notes)

## 项目一句话

**纸筏传纸条**：一个跨设备强同步的便签/todo 工具——2×Win10 + 1×Android，自建阿里云 VPS 做同步中枢，AI（pi + skill）像第二个用户一样操作便签。名字寓意：纸筏（AI 化身）把你的纸条（便签）送到每一台设备。

## 当前状态

- **设计契约**：[GRILL-PLAN.md](GRILL-PLAN.md)（唯一权威；决策日志 Q1–Q29 + 否决记录）
- **✅ 第一步已完成并上线：服务器 + 协议（含契约测试）**
  - 服务器 API 逐字段契约：[docs/protocol.md](docs/protocol.md)；契约测试 `server/test/contract.test.ts`（30 用例全绿）
  - 已部署阿里云 VPS（Docker node:24，systemd 托管 `slip-sync`，公网 50000 已放行，每日 03:00 在线备份保留 14 份）
  - 生产冒烟已通过（`server/test/smoke.ts`，用真实 token 全链路验证）
  - 一键重新部署：`bash server/ops/deploy.sh`（改凭证/换机只改 `.env`）
- **✅ 第二步已完成：Win 画布窗口 spike，门禁通过 → 保留画布方案**
  - 透明/置底/区域穿透/全屏检测四项实测通过；多显示器代码就绪，待第二台 Win10 实机验证（作为任务三验收项）
  - 实测记录 + 演示步骤 + 踩坑清单：[win/SPIKE.md](win/SPIKE.md)；工程 `win/`（Tauri v2，运行 `cd win && .\dev.ps1`）
- **✅ 第三步（形态决策）已定稿：档案馆形态**（2026-08-13 第二轮 grill + 双审）
  - 形态：右缘边栏（档案馆）+ 桌面共存 + 传送门标记 + 聚合视图；互斥存在方式；动作层 = 用户/AI 统一输入抽象
  - **权威计划：[win/FORM-PLAN.md](win/FORM-PLAN.md)**（GRILL-PLAN §7 的 Tauri 细化；决策日志 Q30）
  - 对照 demo：`demos/forms/`（5 个形态 demo，纯前端；形态已定稿，仅供参考对照）
- **✅ 形态先行 M0–M4 已完成**（2026-08-14，见 FORM-PLAN §8 里程碑 + §13 实施记录）
  - M0 CDP 基建 + 窗口壳三区化（边栏窗口/画布窗口/拖拽层 + Rgn 跟随）
  - M1 mock store + 动作层（Rust，手势与 AI 同构）+ 边栏（快捷栏/今日/全部/档案格）
  - M2 桌面卡 + 拖动/磁吸/叠放/合并 + 传送门刷卡（⚡/⏰/📄）
  - M3 档案格 + 一键归档/自动收回 30 天/未确认 + 控制台
  - M4 视图（最近发牌/时间线崩塌）+ 遮罩/抬升 + FLIP 动效
  - **验证**：Rust 单元测试 13 用例（含第二轮新增 reorder/merge 去重/unstack 语义）+ CDP 冒烟 `win/tests/smoke-form.mjs`（真实鼠标手势）
  - 关键修复：vite 端口 1430→14300（Windows 排除端口段 1353–1452）；后台线程持锁调 Win32/tauri API 导致的整窗未响应死锁（lock 纪律：锁内零 Win32/零 tauri 调用，WinOp 锁外执行；lock-monitor 诊断线程）；capabilities 漏配 sidebar 导致边栏空白
  - **✅ 首轮 reviewer 报告 [win/REVIEW-M0-M4.md](win/REVIEW-M0-M4.md) 已全部修复**（🔴R1-R3 + 🟡Y1-Y10 + 🟢G1-G10，另发现并修复同型漏网：hook 锁内全屏 Win32 调用；见报告第三/四部分）
  - **✅ 无人机器干净复跑已完成（2026-08-14 第三轮）**：冒烟连续 30 轮全绿（含两轮 reviewer 审查与修复）；发现并修复 4 个被掩盖的真实 bug（详见 win/REVIEW-M0-M4.md 第五部分）：B1 tauri 监听器 LIFO → 渲染滞后一拍（窗口改走 onState 订阅拿载荷）；B2 时间线崩塌移除被拖卡 → pointerup 丢失 → drag 永久卡死（兜底取消 + 拖出重建桌面卡继续手势，recent/时间线对称）；B3 锁内快照 payload + 锁外慢 Win32 后 emit → 陈旧快照回退 UI（payload 改为慢工作后重建，5 处）；B4 state 事件落在按下/释放之间吞 click（pressedId 保留按下的卡，视图内同型已修）
  - **✅ 第二轮（2026-08-15）美化补全 + 拖动链路加固已完成**：用户实测三大问题（拖动消失/弹左上角又飞回、视图按钮看不到动画、传送门与设计不符）全部修复——reviewer 根因诊断（叠放置顶、视图拖出坐标系、FLIP 节流+压回时序）+ 拖动不变量重构 + 传送门光带/标记动效（颜料桶/笔刷/擦除）+ 纸感视觉（KaiTi/胶带/旋转/纸堆厚度×N）+ 设计差异补全（磁吸引导线/展开收缩/新建聚焦/时间线全实体等）；冒烟新增叠放置顶与展开收起断言连续 5 轮全绿；复跑又发现并根治 state 事件乱序回退（B3 传输层，stateSeq 单调保护），修复后冒烟 32 连绿；详见 FORM-PLAN §14
  - 多屏实机验证待第二屏接入；体感验收（FORM-PLAN §13.4）留待用户人工体验
  - **✅ Q31 重构已完成（2026-08-17，见 FORM-PLAN §15）**：废除 SetWindowRgn 显示裁剪 → WM_NCHITTEST 命中穿透（显示层永不裁剪，胶带/动画/位置全量合成，消失/缺块/被裁 bug 结构性消失）；侧栏 🕳 收起全部 + 托盘图标恢复（保底，无自动安全阀）；顺带修复三个真实 bug（hwnds 未记录致编辑误判全屏隐藏、hide 需走 tauri API 否则 WebView2 渲染窗口残留、dismiss 改走 action 通道）
  - 验证：OS 层 SendMessage 打点（卡片 HTCLIENT/空白穿透）+ 真实光标 WindowFromPoint + 真实右键不挡桌面 + 收起→隐藏→托盘恢复全链路 + 冒烟 32 项全绿
  - 下一步：任务三（真实数据层 + journal + 同步引擎 + local API 60000；动作层接口 action.rs 已留好）

## 阿里云服务器（同步中枢）与端口

**连接**（AI 可读：需要时直接读取根目录 `.env`，已 gitignore 绝不提交）

- **一键登录：`ssh slip`**（别名在 `~/.ssh/config`；密钥 `~/.ssh/id_slip`，公钥已装服务器，免密；密码仅备用）
- `.env` 含：`SSH_HOST` / `SSH_PORT` / `SSH_USER` / `SSH_PASSWORD` / `SSH_KEY_PATH`（服务器连接）、`SLIP_SERVER_PORT` / `SLIP_LOCAL_PORT`（端口约定）
- 端口（高位）：同步服务器 **50000**（公网；服务器防火墙已放行，**阿里云安全组已放行**——2026-08-13 实测公网 `GET /api/v1/health` 可达）、Win 本地便签服务 **60000**（仅 127.0.0.1，AI 用 local API）
- 环境：CentOS 7（glibc 2.17 过老，Node 无法直跑）→ 同步服务跑 **Docker 容器 node:24**（见 GRILL-PLAN §10）
- 改凭据/换机只改 `.env`，本文件不再重复任何细节

## 技术栈

| 组件 | 栈 |
|---|---|
| server | Node.js + TypeScript + better-sqlite3 + ws |
| win | Tauri v2（Rust 核心 + TS 前端，WebView2） |
| android | Kotlin + Jetpack Compose + Glance（widget） |
| skill | pi skill（SKILL.md + 调用脚本） |

## 规划结构（monorepo）

```
slip-notes/
├── server/     # Node+TS 同步服务（先做）
├── win/        # Tauri 客户端（spike 先行；形态先行见 FORM-PLAN.md）
├── android/    # Kotlin 客户端
├── skill/      # pi skill
├── demos/forms/  # 形态对照 demo（5 套，纯前端，与 win/ 隔离）
└── docs/
```
（目录随开发建立，npm 包作用域 `@slip/*`）

## 铁律（详见 GRILL-PLAN.md §4，不可违背）

1. 版本号只由服务器签发（单调递增全局序号）
2. 服务器拒绝陈旧写入
3. local journal 只追加、永不被 sync 覆盖
4. 还原 = 写一个新版本，绝不回拨版本号
5. 删除 = tombstone（历史保留，可跨设备还原）
6. 服务器保留完整版本历史

## 工作约定

- 实施顺序：① 服务器+协议 → ② Win 画布 spike → ③ Win → ④ 安卓 → ⑤ skill
- **Win 画布窗口五项验证是门禁**（透明/置底/区域穿透/多显示器/全屏检测；失败则降级网格排列，不影响其他组件）
- **改动任何设计前，先改 GRILL-PLAN.md**，再改代码
- 契约测试先行（服务器 API 是权威契约，AI 可接管测试）
- 不引入第三方云服务/推送（无 FCM、无厂商推送、无外部同步服务）
- 用户用中文交流，文档用中文

## 术语表

纸筏=产品名 · slip=英文代号 · note=便签（唯一实体） · item=清单项 · Today=今日视图（定时/紧急项聚合） · journal=本地只追加账本 · workspace=工作区 · local API=Win 客户端 localhost 接口（AI 用） · server API=服务器权威契约接口 · sync cursor=增量同步游标 · tombstone=软删除 · batch=journal 分组标记（一键撤销 AI 修改）
