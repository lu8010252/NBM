#!/bin/sh
# NBM 探针安装脚本(无 Docker 的机器):装 Node.js(如果没有)+ 下载探针 + 注册 systemd 开机自启
# 用法: curl -fsSL http://主面板IP:8060/install.sh | TOKEN=你的密钥 sh
set -e
[ "$(id -u)" = 0 ] || { echo "请用 root 运行(前面加 sudo)"; exit 1; }
[ -n "$TOKEN" ] || { echo "缺少 TOKEN,例如: curl -fsSL __PANEL__/install.sh | TOKEN=你的密钥 sh"; exit 1; }
case "$TOKEN" in *[!A-Za-z0-9_-]*) echo "TOKEN 只能是字母数字、下划线或短横线"; exit 1;; esac
PORT="${PORT:-8060}"
command -v systemctl >/dev/null 2>&1 || { echo "没有 systemd,请手动运行: TOKEN=... node /opt/nbm-agent/agent.js"; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo ">> 未检测到 Node.js,正在安装 Node 20 ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
  else
    echo "无法自动安装,请先手动安装 Node.js 18 或更高版本"; exit 1
  fi
fi

mkdir -p /opt/nbm-agent
curl -fsSL __PANEL__/agent.js -o /opt/nbm-agent/agent.js
printf 'TOKEN=%s\nPORT=%s\nDISK_PATH=/\n' "$TOKEN" "$PORT" > /etc/nbm-agent.env
chmod 600 /etc/nbm-agent.env

cat > /etc/systemd/system/nbm-agent.service <<UNIT
[Unit]
Description=NBM agent
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/nbm-agent.env
ExecStart=$(command -v node) /opt/nbm-agent/agent.js
Restart=always
RestartSec=3
MemoryMax=96M
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable nbm-agent >/dev/null 2>&1
systemctl restart nbm-agent
sleep 1
if systemctl is-active nbm-agent >/dev/null 2>&1; then
  echo "✅ 探针已运行在 :$PORT (node $(node -v))。请放行该端口,然后回主面板添加服务器。"
else
  echo "❌ 启动失败,查看: journalctl -u nbm-agent -n 30"; exit 1
fi
# 卸载: systemctl disable --now nbm-agent; rm -rf /opt/nbm-agent /etc/nbm-agent.env /etc/systemd/system/nbm-agent.service
