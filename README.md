# UR 空房监控 Telegram Bot

定时监控 [UR 都市機構](https://www.ur-net.go.jp/chintai/) 团地空房变动，通过 Telegram 发送通知

## 功能

- 定时检查空房，新增/消失自动通知
- 5 分钟抖动去重，避免同一房间反复通知
- Telegram 指令控制：添加、删除、查看、手动检查
- 支持 Docker 部署

## 环境要求

只需安装 Docker

## 快速开始

### 1. 获取 Telegram 凭证

- 通过 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
- 给 [@userinfobot](https://t.me/userinfobot) 发消息，获取 Chat ID

### 2. 配置

将 `config.example.json` 复制为 `config.json`，编辑填入 Token 和 Chat ID：

```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  },
  "checkIntervalMinutes": 10,
  "properties": []
}
```

### 3. 运行

```bash
docker compose up -d
```

## 测试

```bash
node test/run_all.js
```

## Telegram 指令

| 指令 | 说明 |
|------|------|
| `/add <编号>` | 添加监控物件，如 `/add 80_0420` |
| `/remove <编号>` | 删除监控物件 |
| `/list` | 查看监控列表（物件名可点击） |
| `/status` | 查看当前空房状态（房间名可点击） |
| `/check` | 立即手动检查 |

## 编号格式

在 [UR 网站](https://www.ur-net.go.jp/chintai/) 找到目标团地，URL 中的编号即为 `支社_団地識別`

例如 `https://www.ur-net.go.jp/chintai/kansai/osaka/80_0420.html` → `/add 80_0420`

| 部分 | 含义 | 示例 |
|------|------|------|
| 支社 | 地区支社编号 | `80` |
| 団地 | 团地编号 | `042` |
| 識別 | 区分符（通常为 `0`） | `0` |

## 配置参考

`config.json` 完整字段：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `telegram.botToken` | Bot Token | — |
| `telegram.chatId` | 接收通知的 Chat ID | — |
| `checkIntervalMinutes` | 检查间隔（分钟） | `10` |
| `minApiInterval` | API 最小间隔（毫秒） | `1500` |
| `timeout` | API 超时（毫秒） | `15000` |
| `maxRetries` | API 重试次数 | `2` |
| `concurrency` | 并行检查数 | `3` |
| `properties` | 监控物件列表 | `[]` |

## 项目结构

```
ur-vacancy-bot/
├── index.js              主入口 — 调度、指令处理
├── config.example.json   配置文件模板
├── config.json           配置文件（需自行创建）
├── state.json            状态持久化（自动生成）
├── Dockerfile
├── docker-compose.yml
├── lib/
│   ├── api.js            UR API 客户端 — 速率限制、UA 轮换、重试
│   ├── fetch4.js         强制 IPv4 的 fetch 实现
│   ├── state.js          状态管理 — 变动检测、抖动抑制
│   └── telegram.js       Telegram 发送 — 消息格式化、HTML 渲染
└── test/
    └── *.test.js         测试
```

## 通知示例

```
🏠 新房上线 — 西長堀  [80_0420]

✨ 新增 1 件:
  1016号室 · 租 82,000円
  - 管 6,100円 · 1LDK · 43㎡ · 10階

🏠 当前空房 1 件:
  1016号室 · 租 82,000円
  - 管 6,100円 · 1LDK · 43㎡ · 10階

2026/7/28 18:58:00
```

- 物件名可点击跳转物件首页
- 房间名可点击跳转房间详情页
- 消失房间加删除线标记
- 两行排版，移动端不折行
