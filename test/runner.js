/**
 * 简易测试运行器 — 零依赖
 *
 * 用法: node test/run_all.js
 */

let currentSuite = "";
let passed = 0;
let failed = 0;
const errors = [];

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
};

function describe(name, fn) {
  currentSuite = name;
  const hooks = { before: [], after: [] };
  const tests = [];

  const before = (f) => hooks.before.push(f);
  const after = (f) => hooks.after.push(f);
  const it = (name, testFn) => tests.push({ name, fn: testFn });

  // 将 before/after/it 注入到回调的闭包中
  // 同时作为 this 方法（兼容 this.before() 调用）
  const ctx = { before, after, it };
  fn.call(ctx, before, after, it);

  console.log(`\n${colors.bold}${currentSuite}${colors.reset}`);

  for (const test of tests) {
    try {
      for (const b of hooks.before) b();
      test.fn();
      for (const a of hooks.after) a();
      passed++;
      console.log(`  ${colors.green}✓${colors.reset} ${test.name}`);
    } catch (e) {
      failed++;
      errors.push({ suite: currentSuite, test: test.name, error: e.message });
      console.log(`  ${colors.red}✗${colors.reset} ${test.name}`);
      console.log(`    ${colors.red}→ ${e.message}${colors.reset}`);
    }
  }
}

// standalone it (for tests not inside a describe block)
function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
  } catch (e) {
    failed++;
    errors.push({ suite: "standalone", test: name, error: e.message });
    console.log(`  ${colors.red}✗${colors.reset} ${name}`);
    console.log(`    ${colors.red}→ ${e.message}${colors.reset}`);
  }
}

function summary() {
  console.log(`\n${colors.bold}────────────────────────${colors.reset}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${colors.green}${colors.bold}✓ All ${total} tests passed${colors.reset}`);
  } else {
    console.log(`${colors.red}${colors.bold}✗ ${failed}/${total} tests failed${colors.reset}`);
    for (const e of errors) {
      console.log(`  ${colors.red}${e.suite} › ${e.test}${colors.reset}`);
      console.log(`    ${e.error}`);
    }
  }
  console.log("");
  return failed === 0;
}

module.exports = { describe, it, summary, colors };
