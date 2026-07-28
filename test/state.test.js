/**
 * state.js 测试 — 状态管理模块
 *
 * 测试覆盖:
 * - 首次初始化 (isFirst)
 * - 新增/消失检测
 * - 抖动抑制（冷却窗口）
 * - Set 差集计算正确性
 * - 批量保存模式
 * - 过期 timeline 清理
 * - reset / flush
 */

const fs = require("fs");
const path = require("path");
const { describe } = require("./runner");

const TEST_STATE = path.join(__dirname, "test_state.json");
const StateManager = require("../lib/state");

// 清理测试文件
function cleanup() {
  try { fs.unlinkSync(TEST_STATE); } catch (e) { /* ok */ }
}

describe("StateManager", (before, after, it) => {
  before(cleanup);
  after(cleanup);

  it("首次更新返回 isFirst=true", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    const r = s.update("01", "001", "0", ["r1", "r2", "r3"]);
    assert(r.isFirst === true, "isFirst should be true");
    assert(r.total === 3, "total should be 3");
    assert(r.newIds.length === 3, "all IDs should be new");
    assert(r.goneIds.length === 0, "no gone on first check");
    assert(r.suppressedIds.length === 0, "no suppressed on first check");
    s.flush();
    cleanup();
  });

  it("第二次更新检测无变化", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2", "r3"]);
    const r = s.update("01", "001", "0", ["r1", "r2", "r3"]);
    assert(r.isFirst === false, "isFirst should be false");
    assert(r.newIds.length === 0, "no new IDs");
    assert(r.goneIds.length === 0, "no gone IDs");
    s.flush();
    cleanup();
  });

  it("检测新增房间", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2"]);
    const r = s.update("01", "001", "0", ["r1", "r2", "r3", "r4"]);
    assert(r.newIds.length === 2, "2 new rooms");
    assert(r.newIds.includes("r3"), "r3 is new");
    assert(r.newIds.includes("r4"), "r4 is new");
    assert(r.goneIds.length === 0, "no gone");
    s.flush();
    cleanup();
  });

  it("检测消失房间", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2", "r3"]);
    const r = s.update("01", "001", "0", ["r1"]);
    assert(r.goneIds.length === 2, "2 gone rooms");
    assert(r.goneIds.includes("r2"), "r2 is gone");
    assert(r.goneIds.includes("r3"), "r3 is gone");
    assert(r.newIds.length === 0, "no new");
    s.flush();
    cleanup();
  });

  it("抖动抑制 — 消失后短时间内出现", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2"]);

    // r2 消失
    const r1 = s.update("01", "001", "0", ["r1"]);
    assert(r1.goneIds.includes("r2"), "r2 should be gone");

    // r2 立即回来（抖动）
    const r2 = s.update("01", "001", "0", ["r1", "r2"]);
    assert(r2.suppressedIds.includes("r2"), "r2 should be suppressed as jitter");
    assert(r2.newIds.length === 0, "no real new after suppression");
    s.flush();
    cleanup();
  });

  it("抖动抑制 — 超过冷却窗口后正常通知", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2"]);

    const r1 = s.update("01", "001", "0", ["r1"]);
    assert(r1.goneIds.includes("r2"), "r2 should be gone");

    // 手动修改 timeline 模拟超过冷却窗口
    const k = s._key("01", "001", "0");
    const oldTimeline = s.data[k].timeline;
    // 把 goneAt 改到 6 分钟前
    const fakeNow = Date.now() - 6 * 60 * 1000;
    for (const id of Object.keys(oldTimeline)) {
      if (oldTimeline[id].goneAt) {
        oldTimeline[id].goneAt = fakeNow;
      }
    }
    s.data[k].timeline = oldTimeline;
    s._writeNow();

    const r2 = s.update("01", "001", "0", ["r1", "r2"]);
    assert(r2.newIds.includes("r2"), "r2 should be real new after cooldown");
    assert(r2.suppressedIds.length === 0, "no suppression after cooldown");
    s.flush();
    cleanup();
  });

  it("多个物件独立管理", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["a1", "a2"]);
    s.update("02", "002", "1", ["b1", "b2", "b3"]);

    // 物件1: 新增 a3
    const r1 = s.update("01", "001", "0", ["a1", "a2", "a3"]);
    assert(r1.newIds.length === 1, "物件1 有1个新增");
    assert(r1.newIds[0] === "a3", "物件1 新增 a3");

    // 物件2: 移除 b1
    const r2 = s.update("02", "002", "1", ["b2", "b3"]);
    assert(r2.goneIds.length === 1, "物件2 有1个消失");
    assert(r2.goneIds[0] === "b1", "物件2 消失 b1");
    s.flush();
    cleanup();
  });

  it("reset 清除物件状态", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2"]);
    s.reset("01", "001", "0");

    // 重置后再查应该是首次
    const r = s.update("01", "001", "0", ["r1"]);
    assert(r.isFirst === true, "should be first after reset");
    s.flush();
    cleanup();
  });

  it("批量模式 — beginBatch 暂停写入, endBatch 落盘", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);

    s.beginBatch();
    s.update("01", "001", "0", ["r1", "r2"]);
    s.update("01", "001", "0", ["r1", "r2", "r3"]);

    // 批量模式下不应写入磁盘
    const onDisk = fs.existsSync(TEST_STATE);
    assert(onDisk === false, "batch mode should not write to disk");

    s.endBatch();

    // endBatch 后应写入
    const written = JSON.parse(fs.readFileSync(TEST_STATE, "utf-8"));
    const k = s._key("01", "001", "0");
    assert(written[k] !== undefined, "state should be written after endBatch");
    assert(written[k].roomIds.length === 3, "3 rooms saved");
    s.flush();
    cleanup();
  });

  it("过期 timeline 条目被清理", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);

    // 先插入一个状态，手动注入过期 timeline
    s.update("01", "001", "0", ["r1"]);
    const k = s._key("01", "001", "0");
    const fakePast = Date.now() - 20 * 60 * 1000; // 20 分钟前
    s.data[k].timeline["r_old"] = { appearedAt: fakePast, goneAt: fakePast };

    // 多次 update 触发清理
    for (let i = 0; i < 15; i++) {
      s.update("01", "001", "0", ["r1"]);
    }

    // 过期条目应被清理
    assert(!s.data[k].timeline["r_old"], "expired timeline entry should be cleaned up");
    s.flush();
    cleanup();
  });

  it("空房间数组处理正确", () => {
    cleanup();
    const s = new StateManager(TEST_STATE);
    s.update("01", "001", "0", ["r1", "r2", "r3"]);
    const r = s.update("01", "001", "0", []);
    assert(r.total === 0, "total should be 0");
    assert(r.goneIds.length === 3, "all 3 gone");
    s.flush();
    cleanup();
  });
});

// ── 简易断言 ──
function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
