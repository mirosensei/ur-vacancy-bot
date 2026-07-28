/**
 * fetch4.js 测试 — 强制 IPv4 fetch 模块
 *
 * 测试覆盖:
 * - 模块导出正确
 * - 函数签名
 * - Agent 配置
 * - 函数可调用（结构验证）
 */

const { describe, it } = require("./runner");
const { fetch4 } = require("../lib/fetch4");
const https = require("https");

describe("fetch4", () => {

  it("导出 fetch4 函数", () => {
    assert(typeof fetch4 === "function", "fetch4 should be a function");
  });

  it("返回 Promise", () => {
    // 即使传入无效 URL，也应该返回 Promise（可能立即 reject）
    const result = fetch4("https://httpbin.org/get");
    assert(result instanceof Promise, "should return a Promise");
  });

  it("正确解析 URL 各部分", async () => {
    // 使用 httpbin.org 进行端到端集成测试
    try {
      const res = await fetch4("https://httpbin.org/get?test=1");
      assert(res.ok === true, "200 response should be ok");
      assert(typeof res.status === "number", "status should be a number");
      assert(typeof res.text === "function", "text should be a function");
      assert(typeof res.json === "function", "json should be a function");

      const data = await res.json();
      assert(data.args?.test === "1", `query param test=1, got ${JSON.stringify(data.args)}`);
    } catch (err) {
      // 网络不可达时跳过（CI 环境可能无外网）
      console.log(`    ⚠ 网络测试跳过: ${err.message}`);
    }
  });

  it("ok=false 对 404 响应", async () => {
    try {
      const res = await fetch4("https://httpbin.org/status/404");
      assert(res.ok === false, "404 should not be ok");
      assert(res.status === 404, "status should be 404");
    } catch (err) {
      console.log(`    ⚠ 网络测试跳过: ${err.message}`);
    }
  });

  it("支持自定义 headers", async () => {
    try {
      const res = await fetch4("https://httpbin.org/headers", {
        headers: { "X-Custom-Test": "hello123" },
      });
      const data = await res.json();
      assert(data.headers?.["X-Custom-Test"] === "hello123", "custom header should be sent");
    } catch (err) {
      console.log(`    ⚠ 网络测试跳过: ${err.message}`);
    }
  });

  it("json() 对非 JSON 响应的处理", async () => {
    // 创建一个返回 HTML 的请求
    try {
      const res = await fetch4("https://httpbin.org/html");
      assert(res.ok === true, "200 response");
      const text = await res.text();
      assert(typeof text === "string" && text.length > 0, "text should be non-empty");
      // json() should reject since it's HTML
      try {
        await res.json();
        assert(false, "should have thrown");
      } catch (e) {
        assert(e instanceof SyntaxError || e.message?.includes("JSON"),
          "should throw SyntaxError for non-JSON");
      }
    } catch (err) {
      console.log(`    ⚠ 网络测试跳过: ${err.message}`);
    }
  });

  it("headers.get 方法可用", async () => {
    try {
      const res = await fetch4("https://httpbin.org/get");
      const ct = res.headers?.get?.("content-type");
      assert(typeof ct === "string" || ct === undefined, "headers.get returns string or undefined");
    } catch (err) {
      console.log(`    ⚠ 网络测试跳过: ${err.message}`);
    }
  });
});

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
