/**
 * telegram.js 测试 — Telegram 通知模块
 *
 * 测试覆盖:
 * - enabled 检测
 * - 消息拆分逻辑
 * - 消息格式化
 * - 未配置时的降级行为
 */

const { describe, it } = require("./runner");
const Telegram = require("../lib/telegram");

describe("Telegram", () => {

  it("未配置时 enabled=false", () => {
    const tg = new Telegram(null, null);
    assert(tg.enabled === false, "no token → disabled");
  });

  it("占位符 token 视为未配置", () => {
    const tg = new Telegram("YOUR_BOT_TOKEN", "YOUR_CHAT_ID");
    assert(tg.enabled === false, "placeholder token → disabled");
  });

  it("有效 token 时 enabled=true", () => {
    const tg = new Telegram("123456:ABCdef", "123456789");
    assert(tg.enabled === true, "valid token → enabled");
  });

  it("未配置时 send 返回空数组", async () => {
    const tg = new Telegram(null, null);
    const ids = await tg.send("测试消息");
    assert(ids.length === 0, "disabled → empty result");
  });

  it("_split 短消息不拆分", () => {
    const tg = new Telegram("token", "chat");
    const chunks = tg._split("短消息");
    assert(chunks.length === 1, "short message should not split");
    assert(chunks[0] === "短消息", "content unchanged");
  });

  it("_split 长消息按行拆分", () => {
    const tg = new Telegram("token", "chat");
    // 构造一个超过 4000 字节的消息
    const longLine = "A".repeat(100);
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(longLine);
    }
    const text = lines.join("\n");

    const chunks = tg._split(text);
    assert(chunks.length > 1, `long message should split, got ${chunks.length} chunks`);

    // 每个 chunk 不超过 MAX_LEN
    for (const c of chunks) {
      const len = Buffer.byteLength(c, "utf-8");
      assert(len <= 4000, `chunk too long: ${len} bytes`);
    }
  });

  it("_split 精确边界不浪费空间", () => {
    const tg = new Telegram("token", "chat");
    // 构造一个接近 4000 字节的单行
    const line = "B".repeat(3990);
    const chunks = tg._split(line);
    assert(chunks.length === 1, "fits in one chunk");
    const len = Buffer.byteLength(chunks[0], "utf-8");
    assert(len === 3990, `exact length: ${len}`);
  });

  it("fmtFloorSpace 替换 HTML 实体", () => {
    assert(Telegram.fmtFloorSpace("60&#13217;") === "60㎡", "replaces &#13217;");
    assert(Telegram.fmtFloorSpace("") === "", "empty string");
    assert(Telegram.fmtFloorSpace(undefined) === "", "undefined");
  });

  const r1 = { id: "r1", name: "101号室", rent: "85000円", type: "2DK", floorspace: "50㎡", floor: "3" };
  const r2 = { id: "r2", name: "205号室", rent: "92000円", type: "3DK", floorspace: "65㎡", floor: "1" };
  const r3 = { id: "r3", name: "310号室", rent: "78000円", type: "1LDK", floorspace: "40㎡", floor: "5" };

  it("formatChange 单间新房通知", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };

    const msg = tg.formatChange(prop, [r1], [], [r1]);
    assert(msg.includes("新房上线"), "single new room shows 新房上线");
    assert(msg.includes("テスト団地"), "includes property name");
    assert(msg.includes("101号室"), "includes room name");
    assert(msg.includes("当前空房 1 件"), "shows current room count");
  });

  it("formatChange 新房和当前房间有超链接", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };
    const r1l = { ...r1, roomDetailLink: "/detail/r1.html" };
    const r2l = { ...r2, roomDetailLink: "/detail/r2.html" };

    const msg = tg.formatChange(prop, [r1l], [], [r1l, r2l]);
    assert(msg.includes('<a href="https://www.ur-net.go.jp/detail/r1.html">101号室</a>'), "new room has detail link");
    assert(msg.includes('<a href="https://www.ur-net.go.jp/detail/r2.html">205号室</a>'), "current room has detail link");
    // 两行排版：第一行 房间号 · 租 XX円，第二行 - 詳細
    assert(msg.includes("205号室</a> · 租 92000円\n  - 3DK · 65㎡ · 1"), "detail line with price on same line");
    const lines = msg.split("\n");
    assert(lines.find(l => l === "https://example.com") === undefined, "no standalone property URL");
  });

  it("fmtRoomHtml 两行排版", () => {
    const r = { id: "01", name: "1016号室", rent: "82,000円", type: "1LDK", floorspace: "43&#13217;", floor: "10階" };
    const html = Telegram.fmtRoomHtml(r, "https://example.com/room");
    assert(html.includes('<a href="https://example.com/room">1016号室</a>'), "first line has linked name");
    assert(html.includes("租 82,000円\n  - 1LDK · 43㎡ · 10階"), "second line has type/area/floor");
  });

  it("formatChange 有新增也有现有空房", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };

    const msg = tg.formatChange(prop, [r1], [], [r1, r2, r3]);
    assert(msg.includes("空房变动"), "shows change indicator");
    assert(msg.includes("新增 1 件"), "shows new count");
    assert(msg.includes("当前空房 3 件"), "shows all current rooms");
    assert(msg.includes("205号室"), "includes existing room");
    assert(msg.includes("310号室"), "includes existing room");
  });

  it("formatChange 仅消失时列出消失房间和剩余空房", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };

    const msg = tg.formatChange(prop, [], [r1, r2], [r3]);
    assert(msg.includes("空房变动"), "shows change indicator");
    assert(msg.includes("已消失 2 件"), "shows gone count");
    // 消失房间用删除线，无链接（<s> 跨两行）
    assert(msg.includes("<s>101号室"), "gone room has strikethrough");
    assert(msg.includes("<s>205号室"), "gone room has strikethrough");
    assert(msg.includes("</s>"), "strikethrough closing tag");
    // 当前房间有链接
    assert(msg.includes('<a href="https://example.com#room-r3">310号室</a>'), "remaining room has link");
  });

  it("formatChange 新增+消失都列出详情", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };

    const msg = tg.formatChange(prop, [r1], [r3], [r1, r2]);
    assert(msg.includes("空房变动"), "shows change indicator");
    assert(msg.includes("新增 1 件"), "shows new count");
    assert(msg.includes("已消失 1 件"), "shows gone count");
    assert(msg.includes("<s>310号室"), "gone room has strikethrough");
    assert(msg.includes("当前空房 2 件"), "shows all current rooms");
  });

  it("formatChange 全部消失时显示无空房", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地", url: "https://example.com" };

    const msg = tg.formatChange(prop, [], [r1, r2], []);
    assert(msg.includes("空房变动"), "shows change indicator");
    assert(msg.includes("已消失 2 件"), "shows gone count");
    assert(msg.includes("当前无空房"), "shows empty state");
  });

  it("formatChange HTML 转义", () => {
    const tg = new Telegram("token", "chat");
    const prop = { name: "テスト団地" };

    const r = { id: "x", name: "A & B <C>", rent: null, type: null, floorspace: "", floor: null };
    const msg = tg.formatChange(prop, [r], [], [r]);
    // & < > 被转义
    assert(msg.includes("A &amp; B &lt;C&gt;"), "HTML chars escaped in room name");
    // 无链接标签内的 & 被转义两次... 等等
  });

  it("setCommands 未配置时返回 false", async () => {
    const tg = new Telegram(null, null);
    const ok = await tg.setCommands();
    assert(ok === false, "disabled → false");
  });
});

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
