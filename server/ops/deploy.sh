#!/usr/bin/env bash
# ============================================
# 一键部署（本地 Windows 执行）：
#   打包 server/ 源码 → scp 上传 → 服务器端安装（server-install.sh）→ token 回存本地 .env
# 依赖：ssh 免密别名 slip（见 ~/.ssh/config），本地有 node
# 用法：bash server/ops/deploy.sh
# ============================================
set -euo pipefail
cd "$(dirname "$0")/.."   # 进入 server/

echo "== 1/4 打包源码（排除 node_modules/dist/data）"
tar --exclude=node_modules --exclude=dist --exclude=data -czf /tmp/slip-server-src.tar.gz .

echo "== 2/4 上传 /opt/slip-src"
scp -q /tmp/slip-server-src.tar.gz slip:/tmp/slip-server-src.tar.gz
ssh slip 'rm -rf /opt/slip-src && mkdir -p /opt/slip-src && tar -xzf /tmp/slip-server-src.tar.gz -C /opt/slip-src && rm /tmp/slip-server-src.tar.gz'
rm -f /tmp/slip-server-src.tar.gz

echo "== 3/4 服务器端安装（构建镜像 + systemd + cron + 健康检查）"
INSTALL_OUT=$(ssh slip 'bash /opt/slip-src/ops/server-install.sh')
echo "$INSTALL_OUT"

echo "== 4/4 token 回存本地 .env"
TOKENS_LINE=$(echo "$INSTALL_OUT" | grep '^SLIP_TOKENS=' || true)
if [ -n "$TOKENS_LINE" ]; then
  ROOT_ENV="$(cd ../ && pwd)/.env"
  node - "$ROOT_ENV" "$TOKENS_LINE" <<'NODE'
const fs = require("fs");
const [envPath, tokensLine] = [process.argv[2], process.argv[3]];
let env = fs.readFileSync(envPath, "utf8");
const tokens = JSON.parse(tokensLine.slice("SLIP_TOKENS=".length));
const lines = [
  "",
  "# ----- 同步服务器 token（部署时自动生成并回存；服务器 /opt/slip/.env 为权威副本）-----",
  tokensLine,
  "# 各端单独取用（Win 客户端 / 安卓 / AI skill）",
  ...Object.entries(tokens).map(([k, v]) => `SLIP_TOKEN_${k.toUpperCase()}=${v}`),
  "",
].join("\n");
if (/^SLIP_TOKENS=/m.test(env)) {
  env = env.replace(/\n# ----- 同步服务器 token.*(?=\n#|\n[^#\n]|\n$)[\s\S]*?(?=\n# ----- 端口约定|\n$)/, lines);
} else {
  env = env.replace(/\n# ----- 端口约定/, lines + "\n# ----- 端口约定");
}
fs.writeFileSync(envPath, env);
console.log("已更新本地 .env：" + Object.keys(tokens).map((k) => `${k}=<已回存>`).join(" "));
NODE
else
  echo "未发现 SLIP_TOKENS 输出（可能已存在旧 env 且未回显？检查服务器 /opt/slip/.env）"
fi

echo "== 完成 =="
echo "本机验证：curl http://<服务器公网IP>:50000/api/health  （通 = 安全组已放行）"
