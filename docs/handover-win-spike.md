# 交接：任务一收尾 → 任务二（Win 画布窗口 spike）

> 交接时间：2026-08-13。本文件供下一个工作会话快速接手。

## 一、任务一（服务器 + 协议）已完成的交付

- **上线**：阿里云 VPS `ssh slip`，systemd 单元 `slip-sync`（Docker 容器），公网 `101.37.160.131:50000`，安全组已放行。
- **验证**：契约测试 `cd server && npm test`（30/30 绿）；生产冒烟 `npx tsx test/smoke.ts`（全链路）。
- **凭证**：本地 `.env`（gitignore）已有 `SLIP_TOKENS` 与各端 `SLIP_TOKEN_WIN1/WIN2/ANDROID/AI`；服务器 `/opt/slip/.env` 为权威副本。改凭证：改两边 `.env` + 重启容器。
- **运维**：重新部署 `bash server/ops/deploy.sh`；每日 03:00 cron 在线备份 `/opt/slip/data/backups`（保留 14 份）；日志 `journalctl -u slip-sync`。
- **契约文档**：[docs/protocol.md](protocol.md)（REST+WS 逐字段）；设计权威：[GRILL-PLAN.md](../GRILL-PLAN.md)。
- **生产库现状**：有 1 条 tombstone 冒烟便签（4 个版本，正常现象——铁律 5/6，历史保留）。

## 二、任务二：Win 画布窗口 spike

按 GRILL-PLAN §7/§13：Tauri v2，**先做画布窗口 spike，五项验证是门禁**。失败则降级网格排列（画布保留、去掉自由拖动与位置同步），不影响其他组件。

### 五项验证与验收标准（逐项可演示）

| # | 验证 | 验收标准 |
|---|---|---|
| 1 | **透明** | 无边框窗口，无标题栏/任务栏图标；便签卡片外的窗口区域完全不可见（真透明，不是黑色/白色底） |
| 2 | **置底** | 窗口稳定压在桌面图标上方、所有普通窗口下方（`WS_EX_NOACTIVATE` + 失焦后回压 z-order）；点击便签编辑时允许临时激活，失焦回压 |
| 3 | **区域穿透** | 窗口区域 = 便签矩形并集（`SetWindowRgn`），无便签处点击天然落到桌面（壁纸图标可点）；卡片区域内正常交互 |
| 4 | **多显示器** | 每个显示器一个画布窗口；拖动便签跨屏或位置数据跨屏均正常；DPI 缩放（Win10 常见 125%/150%）下坐标不错位 |
| 5 | **全屏检测** | 任一程序进入全屏（含视频/游戏/远程桌面）→ 画布隐藏；退出恢复。不能靠轮询前台窗口（延迟大），用 `SetWinEventHook` 监听 `EVENT_SYSTEM_FOREGROUND` 或 WinEvent 组合 |

### 已知坑（来自 GRILL-PLAN §15 否决记录与设计约束）

- **禁止每便签一窗口**（每窗口 = 一个 WebView2 渲染实例，30 张便签 = 30 个渲染进程，内存爆炸）→ 必须单窗口 + `SetWindowRgn`。
- 透明窗口常见坑：`transparent: true` 后 WebView2 背景必须真透明（CSS `background: transparent` + Tauri 窗口配置）；`SetWindowRgn` 与圆角/阴影的配合要实测。
- 置底与 `alwaysOnBottom`：Win 无原生"永远最底"，需 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` + 监听 z-order 变化回压；置底后窗口无法正常获得焦点，编辑交互要临时切换窗口态（如点击时提升、失焦回压）。
- 全屏检测：无边框全屏（游戏、视频播放器）检测是难点，验收时至少覆盖 Chrome 全屏视频 + 一个游戏/远程桌面场景。

### 建议交付物（spike 目录）

- `win/`（或 `win/spike/`）Tauri v2 工程：Rust 侧窗口管理 + 前端 2~3 张假便签卡片（可拖动）。
- `win/SPIKE.md`：五项验证的**演示步骤 + 实测记录**（每项 通过/失败 + 截图或现象描述）。
- 结论写入 GRILL-PLAN §13 对应条目（通过 → 保留画布方案；任一失败 → 记录失败原因，降级网格排列，代码尽量复用）。

### 环境准备（两台 Win10 之一开发）

- 依赖：Rust（rustup + MSVC build tools，注意 Tauri v2 对 MSVC 版本要求）、Node 18+（本机已有 node 26）、WebView2（Win10 已内置）。
- spike 阶段**不接服务器、不接数据层**：假数据直接写死在 UI，专注窗口能力验证。position 同步是任务三的事，契约已就绪（`content.position` 字段，服务器不解释仅存储）。
- 运行验证建议在**两台 Win10 上各做一遍**（不同显卡/DPI 环境差异大）。

### 任务三（Win 客户端）衔接提示

- 用 `.env` 的 `SLIP_TOKEN_WIN1/WIN2` 接服务器；同步引擎在 Rust 核心（数据层 + journal + localhost 接口），UI 走 IPC。
- local API（60000 端口，AI 用）语义与服务器不同（本地序号 + `pending_sync` + 显式 `POST /sync`），不要与 server API 同构（GRILL-PLAN §15 否决记录）。
- 本地 journal 只追加、永不被 sync 覆盖（铁律 3）；AI 写 `author="ai"` + batch 分组撤销。
