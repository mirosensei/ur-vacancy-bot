/**
 * index.js 测试 — 工具函数和并发控制
 */

const { describe } = require("./runner");

// 内联 parseCode 和 runWithConcurrency（避免触发 index.js 中的 Telegram polling）
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

describe("工具函数", (before, after, it) => {

  it("parseCode 解析有效编号", () => {
    const r = parseCode("01_0010");
    assert(r !== null, "should parse");
    assert(r.shisya === "01", "shisya");
    assert(r.danchi === "001", "danchi");
    assert(r.shikibetu === "0", "shikibetu");
    assert(r.code === "01_0010", "code");
  });

  it("parseCode 解析带识别符的编号", () => {
    const r = parseCode("03_0051");
    assert(r !== null, "should parse");
    assert(r.shisya === "03", "shisya");
    assert(r.danchi === "005", "danchi");
    assert(r.shikibetu === "1", "shikibetu non-zero");
    assert(r.code === "03_0051", "code");
  });

  it("parseCode 拒绝无效格式", () => {
    assert(parseCode("") === null, "empty");
    assert(parseCode("abc") === null, "no match");
    assert(parseCode("01_001") === null, "too few danchi digits");
    assert(parseCode("123_45678") === null, "too many digits");
  });

  it("parseCode 处理首尾空白", () => {
    const r = parseCode("  02_0030  ");
    assert(r !== null, "should parse with whitespace");
    assert(r.code === "02_0030", "code trimmed");
  });

  it("runWithConcurrency 顺序执行保持结果顺序", async () => {
    const items = [3, 1, 2];
    const results = await runWithConcurrency(items, async (n) => {
      await sleep(n * 10);  // shorter sleep first returns earlier
      return n * 10;
    }, 3);

    assert(results.length === 3, "3 results");
    assert(results[0] === 30, "first item result");
    assert(results[1] === 10, "second item result (preserved order)");
    assert(results[2] === 20, "third item result (preserved order)");
  });

  it("runWithConcurrency 错误被捕获为 error 属性", async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, async (n) => {
      if (n === 2) throw new Error("test error");
      return n;
    }, 3);

    assert(results[0] === 1, "first ok");
    assert(results[1].error === "test error", "second error captured");
    assert(results[2] === 3, "third ok");
  });

  it("runWithConcurrency 尊重并发限制", async () => {
    let running = 0;
    let maxRunning = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await runWithConcurrency(items, async (n) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(20);
      running--;
      return n;
    }, 2);  // concurrency = 2

    assert(maxRunning <= 2, `maxRunning should be ≤ 2, got ${maxRunning}`);
  });

  it("runWithConcurrency 空数组返回空数组", async () => {
    const results = await runWithConcurrency([], async (n) => n, 3);
    assert(results.length === 0, "empty input → empty output");
  });
});

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
