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
- **下一步：Win 画布窗口 spike**（五项验证：透明/置底/区域穿透/多显示器/全屏检测；失败则降级网格排列）
  - 交接文档：[docs/handover-win-spike.md](docs/handover-win-spike.md)（五项验收标准、已知坑、环境准备、衔接提示）

## 阿里云服务器（同步中枢）与端口

**连接**（AI 可读：需要时直接读取根目录 `.env`，已 gitignore 绝不提交）

- **一键登录：`ssh slip`**（别名在 `~/.ssh/config`；密钥 `~/.ssh/id_slip`，公钥已装服务器，免密；密码仅备用）
- `.env` 含：`SSH_HOST` / `SSH_PORT` / `SSH_USER` / `SSH_PASSWORD` / `SSH_KEY_PATH`（服务器连接）、`SLIP_SERVER_PORT` / `SLIP_LOCAL_PORT`（端口约定）
- 端口（高位）：同步服务器 **50000**（公网；服务器防火墙已放行，**阿里云安全组待放行**）、Win 本地便签服务 **60000**（仅 127.0.0.1，AI 用 local API）
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
├── win/        # Tauri 客户端（spike 先行）
├── android/    # Kotlin 客户端
├── skill/      # pi skill
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
