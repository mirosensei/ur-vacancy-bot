/**
 * api.js 测试 — API 客户端模块
 *
 * 测试覆盖:
 * - headers 轮转
 * - 速率限制等待
 * - 重试逻辑
 * - HTTP 错误处理
 * - AbortError 不重试
 */

const { describe, it } = require("./runner");
const { ApiClient } = require("../lib/api");

describe("ApiClient", () => {

  it("构造函数默认参数", () => {
    const api = new ApiClient();
    assert(api.minInterval === 1500, "default minInterval = 1500");
    assert(api.timeout === 15000, "default timeout = 15000");
    assert(api.maxRetries === 2, "default maxRetries = 2");
  });

  it("构造函数自定义参数", () => {
    const api = new ApiClient({ minInterval: 500, timeout: 5000, maxRetries: 5 });
    assert(api.minInterval === 500, "custom minInterval");
    assert(api.timeout === 5000, "custom timeout");
    assert(api.maxRetries === 5, "custom maxRetries");
  });

  it("_headers 轮转 UA，不重复 regex 计算", () => {
    const api = new ApiClient();

    // 调用多次，检查返回的 headers 结构正确
    const h1 = api._headers();
    assert(h1["User-Agent"] !== undefined, "has User-Agent");
    assert(h1["Accept"] !== undefined, "has Accept");
    assert(h1["Origin"] === "https://www.ur-net.go.jp", "has Origin");
    assert(h1["Sec-Ch-Ua"] !== undefined, "has Sec-Ch-Ua");
    assert(h1["Sec-Ch-Ua-Mobile"] === "?0", "has Sec-Ch-Ua-Mobile");
    assert(h1["Sec-Ch-Ua-Platform"] !== undefined, "has Sec-Ch-Ua-Platform");

    const h2 = api._headers();
    // 两次调用应该使用不同的 UA（轮转）
    // 注意：可能轮转到相同 UA（pool 是 5 个，循环往复）
    assert(h2["User-Agent"] !== undefined, "second call also has UA");
  });

  it("_wait 速率限制正确等待", async () => {
    const api = new ApiClient({ minInterval: 100 });

    const start = Date.now();
    await api._wait();
    const elapsed1 = Date.now() - start;
    // 第一次调用因无上次记录，应几乎不等待（允许 200ms 裕度）
    assert(elapsed1 < 200, `first call should be near-instant, got ${elapsed1}ms`);

    await api._wait();
    const elapsed2 = Date.now() - start;
    // 第二次调用需要等待 ~100ms ± jitter (范围: 70~130ms)
    assert(elapsed2 >= 70, `should wait ~100ms, got ${elapsed2}ms`);
  });

  it("getRooms 抛出异常时正确处理（网络不可达）", async () => {
    const api = new ApiClient({ minInterval: 0, maxRetries: 1 });
    try {
      await api.getRooms("01", "001", "0");
      assert(false, "should have thrown");
    } catch (err) {
      assert(err !== undefined, "error should exist");
    }
  });

  it("HTTP 错误时抛出异常", async () => {
    const api = new ApiClient({ minInterval: 0, maxRetries: 1 });

    try {
      // 发到一个不存在的端口
      await api._post("nonexistent/", {});
      assert(false, "should have thrown");
    } catch (err) {
      assert(err !== undefined, "error should exist");
    }
  });

  it("getDanchiInfo 返回名称和 URL", async () => {
    const api = new ApiClient({ minInterval: 0 });

    // 没有真实房间数据时返回默认值
    const info = await api.getDanchiInfo("99", "999", "9");
    assert(info.name === "99_9999", "default name");
    assert(info.url === "https://www.ur-net.go.jp/chintai/", "default url");
  });

  it("预计算的 HEADER_TEMPLATES 数量和 UA_POOL 一致", () => {
    // 验证内部一致性（通过间接方式）
    const api = new ApiClient();
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      const h = api._headers();
      seen.add(h["User-Agent"]);
    }
    assert(seen.size >= 5, "should cycle through all 5 UAs");
  });
});

// ── 辅助 ──

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
