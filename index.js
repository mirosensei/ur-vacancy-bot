#!/usr/bin/env node
/**
 * UR 空房监控 Telegram Bot
 *
 * 功能:
 *   - 定时检查 UR 团地空房变动
 *   - 新房/消失自动通过 Telegram 通知
 *   - 支持指令: /add /remove /list /status /check
 *   - 抖动去重 (5分钟冷却)
 *
 * 用法:
 *   node index.js              启动监控 + Bot
 *   node index.js --once        单次检查
 *
 * 优化:
 *   - 并行检查物件（可配置并发数）
 *   - poll 与 checkAll 独立调度，不互相阻塞
 *   - 批量状态保存，减少磁盘 I/O
 *   - 房间过滤一次完成，消除重复遍历
 */

const fs = require("fs");
const path = require("path");

// 强制 IPv4
const { fetch4 } = require("./lib/fetch4");
globalThis.fetch = fetch4;

const { ApiClient } = require("./lib/api");
const StateManager = require("./lib/state");
const Telegram = require("./lib/telegram");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const LOG_PATH = path.join(__dirname, "logs", "bot.log");
const TELEGRAM_API = "https://api.telegram.org";

// ── 日志 tee：同时输出到 stdout 和文件 ──
(function setupLogging() {
  const logDir = path.dirname(LOG_PATH);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  const origLog = console.log;
  const origErr = console.error;

  const ts = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });

  console.log = (...args) => {
    origLog(...args);
    stream.write(`[${ts()}] ` + args.join(" ") + "\n");
  };
  console.error = (...args) => {
    origErr(...args);
    stream.write(`[${ts()}] ERROR ` + args.join(" ") + "\n");
  };

  origLog(`📄 日志文件: ${LOG_PATH}`);
})();

// ── 配置 ──

let configCache = null;

function loadConfig() {
  // 检查 config.json 是否被 Docker 误创建为目录（卷挂载时源文件不存在会这样）
  if (fs.existsSync(CONFIG_PATH) && fs.statSync(CONFIG_PATH).isDirectory()) {
    console.error("❌ config.json 是一个目录，请创建文件而非目录:");
    console.error("   cp config.example.json config.json");
    console.error("   然后编辑 config.json 填入你的 Telegram Bot Token 和 Chat ID");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ config.json 不存在，请先创建配置文件:");
    console.error("   cp config.example.json config.json");
    console.error("   然后编辑 config.json 填入你的 Telegram Bot Token 和 Chat ID");
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    configCache = JSON.parse(raw);
    return configCache;
  } catch (err) {
    console.error("❌ 配置文件读取失败:", err.message);
    process.exit(1);
  }
}

function getConfig() {
  return configCache || loadConfig();
}

function saveConfig(cfg) {
  configCache = cfg;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("配置保存失败:", err.message);
  }
}

// ── 工具 ──

function parseCode(raw) {
  const s = raw.trim();
  const m = s.match(/^(\d+)_(\d{4})$/);
  if (!m) return null;
  return {
    shisya: m[1],
    danchi: m[2].slice(0, 3),
    shikibetu: m[2].slice(3),
    code: m[0],
  };
}

/**
 * 带并发限制的异步任务执行器
 * @param {Array} items - 待处理数组
 * @param {Function} fn - 对每个 item 执行的异步函数
 * @param {number} concurrency - 并发上限
 * @returns {Promise<Array>} 结果数组（保持顺序）
 */
async function runWithConcurrency(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ── 主程序 ──

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");

  const config = loadConfig();

  // 确保 state.json 存在且为文件（Docker 卷挂载时源文件不存在会创建目录）
  if (fs.existsSync(STATE_PATH)) {
    if (fs.statSync(STATE_PATH).isDirectory()) {
      fs.rmdirSync(STATE_PATH);
      fs.writeFileSync(STATE_PATH, "{}", "utf-8");
      console.log("⚠ state.json 是目录，已替换为文件");
    }
  } else {
    fs.writeFileSync(STATE_PATH, "{}", "utf-8");
    console.log("✅ 已创建 state.json");
  }

  const api = new ApiClient({
    minInterval: config.minApiInterval || 1500,
    timeout: config.timeout || 15000,
    maxRetries: config.maxRetries || 2,
  });
  const state = new StateManager(STATE_PATH);
  const tg = new Telegram(config.telegram?.botToken, config.telegram?.chatId);
  const ownerChatId = config.telegram?.chatId;
  const concurrency = config.concurrency || 3;   // 可配置并发数

  if (!tg.enabled) {
    console.log("⚠ Telegram 未配置，仅输出到控制台。");
  }

  // ── 并发锁 ──
  let checking = false;

  // ── 检查单个物件（一次遍历 rooms，避免重复过滤） ──
  async function checkOne(p) {
    const rooms = await api.getRooms(p.shisya, p.danchi, p.shikibetu);

    // 一次提取所有 room ID（API 可能返回 null 而非 []，统一兜底）
    const roomIds = [];
    const roomMap = new Map();       // id → room object（供后续通知使用）
    if (rooms && Array.isArray(rooms)) {
      for (const r of rooms) {
        if (r.id) {
          roomIds.push(r.id);
          roomMap.set(r.id, r);
        }
      }
    }

    const change = state.update(p.shisya, p.danchi, p.shikibetu, roomIds, roomMap);

    if (change.isFirst) {
      console.log(`  初始化 ${p.name}: ${roomIds.length} 件空房`);
      return { notified: false, newCount: 0, goneCount: 0, suppressed: change.suppressedIds.length };
    }

    if (change.suppressedIds.length > 0) {
      console.log(`  抖动抑制 ${p.name}: ${change.suppressedIds.length} 件 (冷却中)`);
    }

    const hasChange = change.newIds.length > 0 || change.goneIds.length > 0;

    if (hasChange) {
      // 直接从 Map 取房详情，无需再过滤 rooms 数组
      const newRooms = change.newIds.map(id => roomMap.get(id)).filter(Boolean);
      const goneRooms = change.goneRooms;
      const allRooms = roomIds.map(id => roomMap.get(id)).filter(Boolean);

      const parts = [];
      if (change.newIds.length > 0) parts.push(`新增 ${change.newIds.length} 件`);
      if (change.goneIds.length > 0) parts.push(`${change.goneIds.length} 件已消失`);
      console.log(`  变动! ${p.name} ${parts.join(", ")}`);

      const msg = tg.formatChange(p, newRooms, goneRooms, allRooms);
      await tg.send(msg, { parse_mode: "HTML" });
      return {
        notified: true,
        newCount: change.newIds.length,
        goneCount: change.goneIds.length,
        suppressed: change.suppressedIds.length,
      };
    }

    if (roomIds.length > 0) {
      console.log(`  空房 ${roomIds.length}件 (无变化)  ${p.name}`);
    } else {
      console.log(`  无空房  ${p.name}`);
    }
    return { notified: false, newCount: 0, goneCount: 0, suppressed: change.suppressedIds.length };
  }

  // ── 检查所有物件（并行 + 批量保存状态） ──
  async function checkAll() {
    if (checking) {
      console.log("  上一轮检查尚未完成，跳过。");
      return null;
    }
    checking = true;

    const cfg = getConfig();
    const props = cfg.properties || [];
    if (props.length === 0) { checking = false; return null; }

    const now = new Date().toLocaleTimeString("zh-CN");
    console.log(`\n🔍 检查中... (${props.length}件, 并发${concurrency}) [${now}]`);

    // 批量模式 — 减少磁盘写入
    state.beginBatch();

    const results = await runWithConcurrency(props, checkOne, concurrency);

    state.endBatch();

    // 聚合结果
    let checked = 0, notified = 0, newTotal = 0, goneTotal = 0, suppressed = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.error) {
        console.error(`  出错: ${r.error}`);
        continue;
      }
      checked++;
      if (r.notified) notified++;
      newTotal += r.newCount;
      goneTotal += r.goneCount;
      suppressed += r.suppressed;
    }

    const parts = [`检查${checked}件, 通知${notified}件 (新增${newTotal}, 消失${goneTotal})`];
    if (suppressed > 0) parts.push(`抑制${suppressed}件`);
    console.log(`✅ 完成 — ${parts.join(", ")}`);
    checking = false;
    return { checked, notified, newTotal, goneTotal, suppressed };
  }

  // ── 单次模式 ──
  if (once) {
    await checkAll();
    state.flush();
    process.exit(0);
  }

  // ── Bot 指令处理 ──

  async function handleCommand(chatId, text) {
    // 鉴权：只响应主人的指令
    if (String(chatId) !== String(ownerChatId)) {
      console.log(`  拒绝未授权指令 [${chatId}]: ${text}`);
      return;
    }

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "/start":
        await tg.send(
          `🏠 <b>UR 空房监控 Bot</b>\n` +
          `\n` +
          `➕  /add &lt;编号&gt;  — 添加监控物件\n` +
          `🗑  /remove &lt;编号&gt;  — 删除监控物件\n` +
          `📋  /list  — 查看监控列表\n` +
          `🏠  /status  — 查看当前空房\n` +
          `🔍  /check  — 立即检查`,
          { chat_id: chatId, parse_mode: "HTML" }
        );
        break;

      case "/list": {
        const cfg = getConfig();
        const props = cfg.properties || [];
        if (props.length === 0) {
          await tg.send("暂无监控物件。用 /add 添加。", { chat_id: chatId });
          return;
        }
        const lines = [`📋 监控列表 (${props.length}件)`, ""];
        props.forEach((p, i) => {
          const code = `${p.shisya}_${p.danchi}${p.shikibetu || "0"}`;
          lines.push(`${i + 1}. ${Telegram.propNameHtml(p)}  [${code}]`);
        });
        lines.push("");
        lines.push("删除: /remove &lt;编号&gt;");
        await tg.send(lines.join("\n"), { chat_id: chatId, parse_mode: "HTML" });
        break;
      }

      case "/add": {
        if (args.length < 1) {
          await tg.send("用法: /add <编号>", { chat_id: chatId });
          return;
        }

        const parsed = parseCode(args[0]);
        if (!parsed) {
          await tg.send("编号格式错误。格式: 支社_団地識別", { chat_id: chatId });
          return;
        }

        const cfg = getConfig();
        const props = cfg.properties || [];

        // findIndex 一次定位，避免 find + findIndex 两次遍历
        const existsIdx = props.findIndex(p =>
          p.shisya === parsed.shisya && p.danchi === parsed.danchi && (p.shikibetu || "0") === parsed.shikibetu
        );
        if (existsIdx !== -1) {
          const existCode = `${props[existsIdx].shisya}_${props[existsIdx].danchi}${props[existsIdx].shikibetu || "0"}`;
          await tg.send(`已存在: ${Telegram.propNameHtml(props[existsIdx])}  [${existCode}]`, { chat_id: chatId, parse_mode: "HTML" });
          return;
        }

        let name = parsed.code;
        let url = "https://www.ur-net.go.jp/chintai/";
        let initRooms = null;   // 保存初始化时的房间列表，用于回复消息

        // 获取团地名称、URL
        const roomIds = [];
        try {
          const info = await api.getDanchiInfo(parsed.shisya, parsed.danchi, parsed.shikibetu);
          name = info.name || name;
          url = info.url || url;

          const rooms = info.rooms;
          if (rooms && Array.isArray(rooms)) {
            initRooms = rooms;
            for (const r of rooms) {
              if (r.id) roomIds.push(r.id);
            }
          }
        } catch (err) {
          console.error("获取团地信息失败:", err.message);
        }

        // 无论 API 调用成功与否都初始化状态，避免 /status 显示「尚无检查记录」
        const addRoomMap = new Map();
        if (initRooms) {
          for (const r of initRooms) {
            if (r.id) addRoomMap.set(r.id, r);
          }
        }
        state.update(parsed.shisya, parsed.danchi, parsed.shikibetu, roomIds, addRoomMap);

        props.push({
          name,
          shisya: parsed.shisya,
          danchi: parsed.danchi,
          shikibetu: parsed.shikibetu,
          url,
        });
        saveConfig(cfg);

        // 构建回复消息，包含当前空房信息
        let respMsg = `✅ 已添加\n📌 ${Telegram.propNameHtml({ name, url })}\n🔢 ${parsed.code}`;

        if (initRooms && initRooms.length > 0) {
          const show = initRooms.slice(0, 5);
          const more = initRooms.length > 5 ? `\n  ... 还有 ${initRooms.length - 5} 件` : "";
          const roomLines = show.map(r =>
            `  ${Telegram.fmtRoomHtml(r, Telegram.roomUrl({ url }, r))}`
          ).join("\n");
          respMsg += `\n\n🏠 当前空房 ${initRooms.length} 件\n${roomLines}${more}`;
        } else {
          respMsg += `\n\n📭 当前无空房`;
        }

        await tg.send(respMsg, { chat_id: chatId, parse_mode: "HTML" });
        break;
      }

      case "/remove":
      case "/rm": {
        if (args.length < 1) {
          await tg.send("用法: /remove <编号>", { chat_id: chatId });
          return;
        }

        const parsed = parseCode(args[0]);
        if (!parsed) {
          await tg.send("编号格式错误。格式: 支社_団地識別", { chat_id: chatId });
          return;
        }

        const cfg = getConfig();
        const props = cfg.properties || [];
        const idx = props.findIndex(p =>
          p.shisya === parsed.shisya && p.danchi === parsed.danchi && (p.shikibetu || "0") === parsed.shikibetu
        );

        if (idx === -1) {
          await tg.send(`未找到: ${parsed.code}`, { chat_id: chatId });
          return;
        }

        const removed = props[idx];
        props.splice(idx, 1);
        saveConfig(cfg);
        state.reset(removed.shisya, removed.danchi, removed.shikibetu);

        const code = `${removed.shisya}_${removed.danchi}${removed.shikibetu || "0"}`;
        await tg.send(`🗑 已删除 ${Telegram.propNameHtml(removed)}  [${code}]`, { chat_id: chatId, parse_mode: "HTML" });
        break;
      }

      case "/status": {
        const cfg = getConfig();
        const props = cfg.properties || [];
        if (props.length === 0) {
          await tg.send("暂无监控物件。", { chat_id: chatId });
          return;
        }

        // 先检查是否所有物件都有缓存（无缓存时需要调 API）
        const misses = props.filter(p =>
          !state.getRooms(p.shisya, p.danchi, p.shikibetu)
        );

        const msgIds = misses.length > 0
          ? await tg.send("⏳ 查询中...", { chat_id: chatId })
          : [];
        const placeholderId = msgIds[0];

        let total = 0;

        // 找全局最新检查时间
        let latestCheck = null;
        for (const p of props) {
          const lastCheck = state.getLastCheck(p.shisya, p.danchi, p.shikibetu);
          if (lastCheck && (!latestCheck || lastCheck > latestCheck)) {
            latestCheck = lastCheck;
          }
        }

        // 优先读缓存；缓存未命中时并发调 API
        const results = await runWithConcurrency(props, async (p) => {
          const code = `${p.shisya}_${p.danchi}${p.shikibetu || "0"}`;
          try {
            let rooms = state.getRooms(p.shisya, p.danchi, p.shikibetu);

            // 缓存未命中 → 回退到 API 查询
            if (!rooms) {
              rooms = await api.getRooms(p.shisya, p.danchi, p.shikibetu);
            }

            const propNameHtml = Telegram.propNameHtml(p);

            if (rooms && Array.isArray(rooms) && rooms.length > 0) {
              const show = rooms.slice(0, 5);
              const more = rooms.length > 5 ? `\n  ... 还有 ${rooms.length - 5} 件` : "";
              const roomLines = show.map(r =>
                `  ${Telegram.fmtRoomHtml(r, Telegram.roomUrl(p, r))}`
              ).join("\n");
              return { text: `${propNameHtml}  [${code}]\n  空房 ${rooms.length} 件\n${roomLines}${more}`, count: rooms.length };
            } else {
              return { text: `${propNameHtml}  [${code}]\n  无空房`, count: 0 };
            }
          } catch (err) {
            return { text: `${Telegram.propNameHtml(p)}  [${code}]\n  查询失败: ${Telegram.esc(err.message)}`, count: 0 };
          }
        }, concurrency);

        const blocks = results.map(r => (r && !r.error) ? r.text : `查询出错`);
        for (const r of results) {
          if (r && !r.error) total += r.count;
        }

        const desc = total > 0 ? `合计 ${total} 件空房` : "全部无空房";
        const footer = latestCheck
          ? `上次更新: ${new Date(latestCheck).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo" })}`
          : "尚无检查记录";
        const result = `📊 空房状态\n\n${blocks.join("\n\n")}\n\n${desc}\n${footer}`;

        if (placeholderId) {
          await tg.edit(chatId, placeholderId, result, { parse_mode: "HTML" });
        } else {
          await tg.send(result, { chat_id: chatId, parse_mode: "HTML" });
        }
        break;
      }

      case "/check": {
        const msgIds = await tg.send("⏳ 检查中...", { chat_id: chatId });
        const placeholderId = msgIds[0];

        try {
          const r = await checkAll();
          let result;
          if (r) {
            const totalRooms = (getConfig().properties || []).reduce((sum, p) => {
              const rooms = state.getRooms(p.shisya, p.danchi, p.shikibetu);
              return sum + (rooms ? rooms.length : 0);
            }, 0);
            result = `✅ ${r.checked}物件 · ${totalRooms}件空房\n${new Date().toLocaleString("zh-CN")}`;
          } else {
            result = "⏭ 上一轮检查尚未完成，已跳过。";
          }

          if (placeholderId) {
            await tg.edit(chatId, placeholderId, result);
          } else {
            await tg.send(result, { chat_id: chatId });
          }
        } catch (err) {
          const errMsg = `❌ 检查出错: ${err.message}`;
          if (placeholderId) {
            await tg.edit(chatId, placeholderId, errMsg);
          } else {
            await tg.send(errMsg, { chat_id: chatId });
          }
        }
        break;
      }

      default:
        if (cmd.startsWith("/")) {
          await tg.send(`未知指令: ${cmd}\n输入 /start 查看可用指令。`, { chat_id: chatId });
        }
    }
  }

  // ── Telegram Polling（独立于定时检查） ──

  let offset = 0;

  async function poll() {
    if (!tg.enabled) return;

    try {
      const url = `${TELEGRAM_API}/bot${tg.token}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
      const data = await res.json();

      if (data.ok && data.result) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          const msg = upd.message || upd.edited_message;
          if (!msg || !msg.text) continue;

          const chatId = msg.chat.id;
          const msgId = msg.message_id;
          console.log(`  > [${chatId}] ${msg.text}`);

          handleCommand(chatId, msg.text).catch(err => {
            console.error("指令处理异常:", err.message);
          });
        }
      }
    } catch (err) {
      if (err.name !== "AbortError" && err.name !== "TimeoutError") {
        console.error("Polling错误:", err.message);
      }
      // 网络错误时短暂等待，避免 tight loop
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ── 启动 ──

  const intervalMs = (config.checkIntervalMinutes || 10) * 60 * 1000;

  console.log("🏠 UR 空房监控 Bot 已启动");
  console.log(`📋 物件: ${(config.properties || []).length} 件`);
  console.log(`⏱  间隔: ${config.checkIntervalMinutes || 10} 分钟`);
  console.log(`⚡ 并发: ${concurrency} 路`);
  console.log(`🤖 Bot: ${tg.enabled ? "已配置" : "未配置"}`);
  console.log("📝 指令: /list /add /remove /status /check");

  // 设置 Telegram 命令菜单
  if (tg.enabled) {
    await tg.setCommands();
  }
  console.log();

  // 启动时静默初始化状态（checkOne 内部处理 isFirst，不会通知）
  await checkAll();

  // ── Graceful shutdown ──
  let running = true;

  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  // ── 双循环：poll 和 checkAll 独立调度，互不阻塞 ──
  let lastCheck = Date.now();

  // poll 在后台持续运行（接收指令），未配置则不启动
  const pollLoop = tg.enabled ? (async () => {
    while (running) {
      await poll();
    }
  })() : Promise.resolve();

  // 定时检查循环（精确按间隔调度，不受 poll 影响）
  const checkLoop = (async () => {
    while (running) {
      const elapsed = Date.now() - lastCheck;
      const waitMs = Math.max(0, intervalMs - elapsed);
      await new Promise(r => setTimeout(r, waitMs));

      if (!running) break;
      lastCheck = Date.now();
      await checkAll().catch(err => {
        console.error("定时检查异常:", err.message);
      });
    }
  })();

  await Promise.all([pollLoop, checkLoop]);

  // 等待正在执行中的 checkAll 完成（/check 指令或定时触发）
  if (checking) {
    console.log("⏳ 等待检查完成...");
    for (let i = 0; i < 30 && checking; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (checking) {
      console.log("⚠ 检查超时，强制保存状态");
    }
  }

  console.log("\n👋 正在退出...");
  state.flush();
  console.log("💾 已保存状态。");
  process.exit(0);
}

main().catch(err => {
  console.error("启动失败:", err);
  process.exit(1);
});
