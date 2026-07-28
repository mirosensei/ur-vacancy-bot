#!/bin/sh
set -e

# 处理 config.json — 如果是目录（首次运行 Docker 挂载创建的），报错
if [ -d /app/config.json ]; then
  echo "❌ config.json 是一个目录，请创建 config.json 文件后重新运行"
  echo "   cp config.example.json config.json"
  echo "   然后编辑 config.json 填入你的 Telegram Bot Token 和 Chat ID"
  exit 1
fi

# 如果 config.json 不存在，从示例配置复制
if [ ! -f /app/config.json ]; then
  echo "⚠  config.json 不存在，请复制 config.example.json 并填入配置:"
  echo "   cp config.example.json config.json"
  exit 1
fi

# 首次运行自动创建 state.json
if [ ! -f /app/state.json ]; then
  echo "{}" > /app/state.json
  echo "✅ 已创建 state.json"
fi

exec node /app/index.js
