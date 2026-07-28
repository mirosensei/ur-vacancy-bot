#!/usr/bin/env node
/**
 * 运行所有测试
 *
 * 用法: node test/run_all.js
 */

const { summary } = require("./runner");

async function main() {
  console.log("=" .repeat(50));
  console.log("  UR Vacancy Bot — Test Suite");
  console.log("=" .repeat(50));

  // 按依赖顺序加载测试模块
  try {
    require("./fetch4.test.js");
  } catch (err) {
    console.error("fetch4.test.js 加载失败:", err.message);
  }

  try {
    require("./api.test.js");
  } catch (err) {
    console.error("api.test.js 加载失败:", err.message);
  }

  try {
    require("./state.test.js");
  } catch (err) {
    console.error("state.test.js 加载失败:", err.message);
  }

  try {
    require("./telegram.test.js");
  } catch (err) {
    console.error("telegram.test.js 加载失败:", err.message);
  }

  try {
    require("./index.test.js");
  } catch (err) {
    console.error("index.test.js 加载失败:", err.message);
  }

  summary();
}

main().catch(err => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
