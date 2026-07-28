/**
 * 状态管理 — 追踪 roomId 集合，检测变动
 *
 * - 首次记录 (isFirst): 不通知，静默初始化
 * - 去重冷却: 同一房间 5 分钟内消失→出现，视为抖动，不通知
 *
 * 优化:
 * - 使用 Set 做房间 ID 差集计算（O(n) 而非 O(n²) 的 includes）
 * - 延迟/分批清理过期 timeline 条目
 * - 支持批量保存模式，减少 checkAll 期间的磁盘写入
 */
const fs = require("fs");
const path = require("path");

const COOLDOWN_MS = 5 * 60 * 1000;          // 5 分钟冷却窗口
const CLEANUP_INTERVAL = 10;                  // 每 10 次 update 清理一次过期条目

class StateManager {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, "..", "state.json");
    this.data = {};
    this._updateCount = 0;
    this._batchMode = false;                   // 批量模式: 延迟写入磁盘
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        // 清理非团地状态的残留 key（如手动编辑的 properties 等）
        this.data = {};
        for (const [key, val] of Object.entries(raw)) {
          // 团地 key 格式: 支社_団地_識別 (如 "50_409_0")
          if (/^\d+_\d+_\d+$/.test(key) && val && typeof val.roomIds !== "undefined") {
            this.data[key] = val;
          }
        }
      }
    } catch (err) {
      console.error("状态文件读取失败:", err.message);
    }
  }

  _save() {
    if (this._batchMode) return;               // 批量模式下延迟写入

    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._writeNow();
    }, 500);
  }

  _writeNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("状态保存失败:", err.message);
    }
  }

  _key(shisya, danchi, shikibetu = "0") {
    return `${shisya}_${danchi}_${shikibetu}`;
  }

  /** 进入批量模式 — 暂停自动写入，需手动 flush() 落盘 */
  beginBatch() {
    this._batchMode = true;
  }

  /** 退出批量模式并立即落盘 */
  endBatch() {
    this._batchMode = false;
    this._writeNow();
  }

  /**
   * 更新物件状态
   * @param {string[]} currentRoomIds
   * @param {Map<string, object>} [roomMap] - id → room 对象的 Map，用于缓存房间详情
   * @returns {{ newIds: string[], goneIds: string[], isFirst: boolean, total: number,
   *             suppressedIds: string[] }}
   */
  update(shisya, danchi, shikibetu, currentRoomIds, roomMap) {
    const k = this._key(shisya, danchi, shikibetu);
    const prev = this.data[k];
    const isFirst = !prev;

    // ── 使用 Set 做差集计算，O(n) 代替 O(n*m) ──
    const prevSet = new Set(prev?.roomIds || []);
    const curSet = new Set(currentRoomIds);

    const newIds = currentRoomIds.filter(id => !prevSet.has(id));
    const goneIds = (prev?.roomIds || []).filter(id => !curSet.has(id));

    // ── 去重冷却：同一房间短期内消失又出现，抑制通知 ──
    const now = Date.now();
    const timeline = prev?.timeline || {};
    const suppressedIds = [];

    const realNewIds = [];
    for (const id of newIds) {
      const t = timeline[id];
      if (t && t.goneAt && (now - t.goneAt) < COOLDOWN_MS) {
        suppressedIds.push(id);
      } else {
        realNewIds.push(id);
      }
    }

    const realGoneIds = [];
    for (const id of goneIds) {
      const t = timeline[id];
      if (t && t.appearedAt && (now - t.appearedAt) < COOLDOWN_MS) {
        // 刚出现又消失 → 抑制
      } else {
        realGoneIds.push(id);
      }
    }

    // 更新 timeline
    // 注意: 首次初始化时，所有房间不应该设置 appearedAt（它们是基线，不是新出现的）
    if (!isFirst) {
      for (const id of newIds) {
        const existing = timeline[id];
        timeline[id] = existing
          ? { appearedAt: now, goneAt: existing.goneAt }
          : { appearedAt: now };
      }
    }
    for (const id of goneIds) {
      const existing = timeline[id];
      timeline[id] = existing
        ? { appearedAt: existing.appearedAt, goneAt: now }
        : { goneAt: now };
    }

    // ── 延迟清理过期 timeline 条目（每 N 次 update 执行一次） ──
    this._updateCount++;
    if (this._updateCount % CLEANUP_INTERVAL === 0) {
      this._cleanupTimeline(timeline, now);
    }

    // ── 缓存房间详情：合并新旧，只保留当前存在的房间 ──
    const prevRooms = prev?.rooms || {};
    const rooms = {};
    for (const id of currentRoomIds) {
      rooms[id] = (roomMap && roomMap.get(id)) || prevRooms[id] || { id };
    }

    this.data[k] = {
      roomIds: currentRoomIds,
      rooms,
      lastCheck: new Date().toISOString(),
      initialized: true,
      timeline,
    };
    this._save();

    return {
      newIds: realNewIds,
      goneIds: realGoneIds,
      goneRooms: realGoneIds.map(id => prevRooms[id]).filter(Boolean),
      isFirst,
      total: currentRoomIds.length,
      suppressedIds,
    };
  }

  /** 清理过期 timeline 条目 */
  _cleanupTimeline(timeline, now) {
    const cutoff = now - COOLDOWN_MS * 2;
    for (const id of Object.keys(timeline)) {
      const t = timeline[id];
      if ((t.appearedAt || 0) < cutoff && (t.goneAt || 0) < cutoff) {
        delete timeline[id];
      }
    }
  }

  getLastCheck(shisya, danchi, shikibetu) {
    return this.data[this._key(shisya, danchi, shikibetu)]?.lastCheck || null;
  }

  /** 获取缓存的房间详情数组，若无缓存返回 null */
  getRooms(shisya, danchi, shikibetu) {
    const entry = this.data[this._key(shisya, danchi, shikibetu)];
    if (!entry || !entry.rooms) return null;
    const roomIds = entry.roomIds || [];
    // 按 roomIds 顺序返回（保证展示顺序稳定）
    return roomIds.map(id => entry.rooms[id]).filter(Boolean);
  }

  reset(shisya, danchi, shikibetu) {
    delete this.data[this._key(shisya, danchi, shikibetu)];
    this._save();
  }

  flush() {
    this._batchMode = false;
    this._writeNow();
  }
}

module.exports = StateManager;
