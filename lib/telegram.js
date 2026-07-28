/**
 * Telegram 通知模块 — 发送、编辑、拆分长消息、重试
 *
 * 优化:
 * - body 预序列化，重试时复用
 * - 格式化逻辑提取为静态方法，消除重复
 * - send 批量发送时共享 opts 序列化
 */
const TELEGRAM_API = "https://api.telegram.org";
const MAX_LEN = 4000;

// 预计算 floorspace 替换（避免每次 fmtRoom/formatChange 做 replace）
const FS_REPLACE = /&#13217;/g;
const FS_REPLACEMENT = "㎡";

class Telegram {
  constructor(botToken, chatId) {
    this.token = botToken;
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId &&
      botToken !== "YOUR_BOT_TOKEN" &&
      chatId !== "YOUR_CHAT_ID");
  }

  /**
   * 发送消息（自动拆分过长内容）
   * @returns {Promise<number[]>} 发送成功的 message_id 列表
   */
  async send(text, opts = {}) {
    if (!this.enabled) {
      console.log("[Telegram未配置]", text.slice(0, 80));
      return [];
    }

    const chunks = this._split(text);
    const ids = [];

    for (const chunk of chunks) {
      const id = await this._sendOne(chunk, opts);
      if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * 编辑消息（原地替换内容）
   */
  async edit(chatId, messageId, text, opts = {}) {
    if (!this.enabled) return false;

    try {
      const res = await fetch(
        `${TELEGRAM_API}/bot${this.token}/editMessageText`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: text.slice(0, MAX_LEN),
            disable_web_page_preview: true,
            ...opts,
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) {
        if (res.status === 400) return true; // 内容未变也算成功
        console.error("编辑消息失败:", await res.text());
        return false;
      }
      return true;
    } catch (err) {
      console.error("编辑消息错误:", err.message);
      return false;
    }
  }

  /** 长消息自动按行拆分 — 单次遍历，累加字节数 */
  _split(text) {
    const totalLen = Buffer.byteLength(text, "utf-8");
    if (totalLen <= MAX_LEN) return [text];

    const chunks = [];
    const lines = text.split("\n");
    let cur = "";
    let curLen = 0;

    for (const line of lines) {
      const lineLen = Buffer.byteLength(line, "utf-8");
      const sepLen = cur ? 1 : 0; // "\n" 分隔符

      if (curLen + sepLen + lineLen > MAX_LEN) {
        if (cur) chunks.push(cur);
        cur = line;
        curLen = lineLen;
      } else {
        cur = cur ? cur + "\n" + line : line;
        curLen += sepLen + lineLen;
      }
    }
    if (cur) chunks.push(cur);
    return chunks.length > 0 ? chunks : [text];
  }

  /** 发送单条消息 — body 预序列化，重试时复用 */
  async _sendOne(text, opts = {}, retries = 2) {
    // 预序列化 body（重试时无需重复 JSON.stringify）
    const bodyStr = JSON.stringify({
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      ...opts,
    });

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(
          `${TELEGRAM_API}/bot${this.token}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyStr,
            signal: AbortSignal.timeout(10000),
          }
        );
        if (res.ok) {
          const data = await res.json();
          return data.result?.message_id || 0;
        }

        const errText = await res.text();
        if (res.status === 429 && attempt < retries) {
          const retryAfter = parseInt(res.headers?.get?.("Retry-After") || "5");
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        console.error("Telegram发送失败:", res.status, errText);
        return 0;
      } catch (err) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        console.error("Telegram错误:", err.message);
        return 0;
      }
    }
    return 0;
  }

  /**
   * 设置 Bot 命令菜单（出现在 Telegram 输入框的 / 菜单中）
   */
  async setCommands() {
    if (!this.enabled) return false;

    const commands = [
      { command: "add",    description: "添加监控物件" },
      { command: "remove", description: "删除监控物件" },
      { command: "list",   description: "查看监控列表" },
      { command: "status", description: "查看当前空房" },
      { command: "check",  description: "立即检查" },
    ];

    try {
      const res = await fetch(
        `${TELEGRAM_API}/bot${this.token}/setMyCommands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (res.ok) {
        console.log("✅ Bot 命令菜单已更新");
        return true;
      }
      console.error("setMyCommands 失败:", await res.text());
      return false;
    } catch (err) {
      console.error("setMyCommands 错误:", err.message);
      return false;
    }
  }

  // ── 消息格式化（静态方法，可复用） ──

  /** 构建房间详情页链接 */
  static roomUrl(prop, r) {
    if (r.roomDetailLink) return `https://www.ur-net.go.jp${r.roomDetailLink}`;
    if (prop.url && r.id) return `${prop.url}#room-${r.id}`;
    return null;
  }

  /** 格式化 floorspace 字段 */
  static fmtFloorSpace(fs) {
    return (fs || "").replace(FS_REPLACE, FS_REPLACEMENT);
  }

  /** 物件名 HTML（带超链接） */
  static propNameHtml(prop) {
    const name = Telegram.esc(prop.name);
    return prop.url ? `<a href="${prop.url}">${name}</a>` : name;
  }

  /** HTML 转义 */
  static esc(s) {
    return String(s || "—")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * 格式化一间房为 HTML 行（两行排版：名称 + 详情）
   * @param {object} r 房间对象
   * @param {string} [roomUrl] 房间链接（不传则无链接）
   * @returns {string}
   */
  static fmtRoomHtml(r, roomUrl) {
    const name = Telegram.esc(r.name || "—");
    const price = Telegram.esc(r.rent || r.rent_normal || "—");
    const type = Telegram.esc(r.type || "—");
    const fs = Telegram.esc(Telegram.fmtFloorSpace(r.floorspace));
    const floor = Telegram.esc(r.floor || "—");
    const label = roomUrl
      ? `<a href="${roomUrl}">${name}</a>`
      : name;
    return `${label}\n  - ${price} · ${type} · ${fs} · ${floor}`;
  }

  /** 变动通知消息（HTML 格式，发送时需 parse_mode: "HTML"） */
  formatChange(prop, newRooms, goneRooms, allRooms) {
    const lines = [];
    const code = `${prop.shisya}_${prop.danchi}${prop.shikibetu || "0"}`;
    const isNewListing = newRooms.length === 1 && goneRooms.length === 0 && allRooms.length === 1;
    const propNameHtml = Telegram.propNameHtml(prop);

    if (isNewListing) {
      lines.push(`🏠 新房上线 — ${propNameHtml}  [${code}]`);
    } else {
      lines.push(`📢 空房变动 — ${propNameHtml}  [${code}]`);
    }
    lines.push("");

    if (newRooms.length > 0) {
      lines.push(`✨ 新增 ${newRooms.length} 件:`);
      for (const r of newRooms) {
        lines.push(`  ${Telegram.fmtRoomHtml(r, Telegram.roomUrl(prop, r))}`);
      }
      lines.push("");
    }

    if (goneRooms.length > 0) {
      lines.push(`🔻 已消失 ${goneRooms.length} 件:`);
      for (const r of goneRooms) {
        lines.push(`  <s>${Telegram.fmtRoomHtml(r)}</s>`);
      }
      lines.push("");
    }

    if (allRooms.length > 0) {
      lines.push(`🏠 当前空房 ${allRooms.length} 件:`);
      for (const r of allRooms) {
        lines.push(`  ${Telegram.fmtRoomHtml(r, Telegram.roomUrl(prop, r))}`);
      }
    } else {
      lines.push(`📭 当前无空房`);
    }

    lines.push("");
    lines.push(new Date().toLocaleString("zh-CN"));
    return lines.join("\n");
  }
}

module.exports = Telegram;
