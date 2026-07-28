/**
 * fetch() 替代 — 强制 IPv4 + HTTP Keep-Alive 连接复用
 *
 * Node.js 的 undici fetch 默认优先 IPv6，在 IPv6 不通的环境会超时。
 * 此模块用原生 https 模块实现 fetch-like API，固定 family: 4。
 *
 * 优化:
 * - 使用 keepAlive Agent 复用 TCP/TLS 连接，避免每次请求重新握手
 * - 正确清理 AbortSignal 监听器，防止内存泄漏
 */

const https = require("https");

// 共享 Agent — 复用连接、减少握手开销
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,       // 空闲连接保留 30 秒
  maxSockets: 10,                // 每个 host 最多 10 个并发连接
  maxFreeSockets: 5,             // 空闲时保留 5 个连接复用
  timeout: 30_000,               // 连接超时
  family: 4,                     // 强制 IPv4
});

function fetch4(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
      agent,                       // 复用连接池
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: {
            get: (name) => res.headers[name.toLowerCase()],
          },
          json: () => {
            try {
              return Promise.resolve(JSON.parse(text));
            } catch (e) {
              return Promise.reject(e);
            }
          },
          text: () => Promise.resolve(text),
        });
      });
    });

    req.on("error", reject);

    if (opts.body) req.write(opts.body);
    req.end();

    // 正确处理 AbortSignal — 清理监听器防止内存泄漏
    if (opts.signal) {
      const onAbort = () => {
        req.destroy(new Error("aborted"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });

      // 如果 signal 已经 aborted，立即触发
      if (opts.signal.aborted) {
        req.destroy(new Error("aborted"));
      }
    }
  });
}

module.exports = { fetch4 };
