#!/bin/sh
set -e

# 首次运行自动创建 state.json
if [ ! -f /app/state.json ]; then
  echo "{}" > /app/state.json
fi

exec node /app/index.js
