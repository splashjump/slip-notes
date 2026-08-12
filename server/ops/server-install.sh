#!/usr/bin/env bash
# ============================================
# 服务器端安装脚本（在阿里云 VPS 上以 root 执行）
# 用法：ssh slip 'bash /opt/slip-src/ops/server-install.sh'
# 职责：初始化 /opt/slip（env/token/数据卷）→ 构建镜像 → systemd → cron 备份 → 健康检查
# 幂等：重复执行安全（已存在的 .env 与数据卷不动；token 只生成一次）
# ============================================
set -euo pipefail

ENV_FILE=/opt/slip/.env
SRC=/opt/slip-src
mkdir -p /opt/slip/data /opt/slip/data/backups

# ---------- 1. 凭证：首次生成 token（win1/win2/android/ai 各一个，含 AI 专用） ----------
if [ ! -f "$ENV_FILE" ]; then
  gen() { openssl rand -hex 24; }
  cat > "$ENV_FILE" <<EOF
SLIP_HOST=0.0.0.0
SLIP_PORT=50000
SLIP_DB_PATH=/app/data/slip.db
SLIP_BACKUP_DIR=/app/data/backups
SLIP_BACKUP_KEEP=14
SLIP_LOG_LEVEL=info
SLIP_TOKENS={"win1":"$(gen)","win2":"$(gen)","android":"$(gen)","ai":"$(gen)"}
EOF
  chmod 600 "$ENV_FILE"
  echo "SLIP_ENV_CREATED=1"
fi
# 回显 token 行（部署脚本抓取后回存本地 .env）
grep '^SLIP_TOKENS=' "$ENV_FILE"

# ---------- 2. 构建镜像 ----------
cd "$SRC"
echo "== docker build =="
docker build -t slip-sync:latest .

# ---------- 3. systemd 单元（托管容器，重启策略双保险） ----------
cp -f "$SRC/ops/slip-sync.service" /etc/systemd/system/slip-sync.service
systemctl daemon-reload
systemctl enable slip-sync >/dev/null 2>&1 || true

# ---------- 4. 重建容器（数据卷挂载 /opt/slip/data，内容保留） ----------
docker stop slip-sync >/dev/null 2>&1 || true
docker rm slip-sync >/dev/null 2>&1 || true
systemctl restart slip-sync

# ---------- 5. cron：每日 03:00 SQLite 在线快照备份（保留 14 份） ----------
CRON_LINE='0 3 * * * /usr/bin/docker exec slip-sync node dist/src/backup.js >> /var/log/slip-backup.log 2>&1'
( crontab -l 2>/dev/null | grep -v 'slip-sync.*backup' ; echo "$CRON_LINE" ) | crontab -
mkdir -p /var/log && touch /var/log/slip-backup.log

# ---------- 6. 健康检查 ----------
sleep 2
echo "== health =="
curl -sS --max-time 5 http://127.0.0.1:50000/api/health || echo "HEALTH_FAIL"
echo
echo "== 容器状态 =="
docker ps --filter name=slip-sync --format '{{.Names}} {{.Status}}'
