#!/bin/zsh
# 从用户目录读取模型配置（不进 Git），缺失时直接报错，不回退到本机 Codex。
cd "$(dirname "$0")" || exit 1
ENV_FILE="$HOME/.xhs-workbench.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE（需包含 XHS_API_KEY / XHS_BASE_URL / XHS_MODEL），已停止启动。" >&2
  exit 1
fi
set -a; source "$ENV_FILE"; set +a
exec /opt/homebrew/bin/node server.mjs
