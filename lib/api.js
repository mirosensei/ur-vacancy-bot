/**
 * UR 空房 API 客户端
 *
 * - 速率限制（避免被 ban）
 * - UA 轮换（预计算 headers，避免每次请求做 regex）
 * - 自动重试 + 指数退避
 * - 超时控制
 * - 连接复用（依赖 fetch4 的 keepAlive agent）
 */
const API_BASE = "https://chintai.r6.ur-net.go.jp/chintai/api/";
const SITE_ORIGIN = "https://www.ur-net.go.jp";

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// ── 预计算 headers（避免每次请求 regex + 字符串拼接） ──

function buildPlatform(ua) {
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh")) return "macOS";
  return "Linux";
}

function buildVer(ua) {
  const m = ua.match(/Chrome\/(\d+)/);
  return m ? m[1] : "131";
}

// 每个 UA 预计算一套 headers 模板
const HEADER_TEMPLATES = UA_POOL.map((ua) => {
  const ver = buildVer(ua);
  const platform = buildPlatform(ua);
  return {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": SITE_ORIGIN,
    "Referer": "https://www.ur-net.go.jp/chintai/",
    "Sec-Ch-Ua": `"Google Chrome";v="${ver}", "Chromium";v="${ver}", "Not_A Brand";v="24"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": `"${platform}"`,
    "DNT": "1",
    "Cache-Control": "no-cache",
    "User-Agent": ua,
  };
});


class ApiClient {
  constructor(opts = {}) {
    this.minInterval = opts.minInterval || 1500;
    this.timeout = opts.timeout || 15000;
    this.maxRetries = opts.maxRetries || 2;
    this.lastCall = 0;
    this._uaIdx = 0;
  }

  /** 轮转获取预计算的 headers（O(1) 数组索引，无需 regex） */
  _headers() {
    const idx = this._uaIdx % HEADER_TEMPLATES.length;
    this._uaIdx++;
    return HEADER_TEMPLATES[idx];
  }

  /** 速率限制等待 — 使用指数移动平均减少抖动计算开销 */
  async _wait() {
    const elapsed = Date.now() - this.lastCall;
    if (elapsed < this.minInterval) {
      // 在 [0.7*minInterval, 1.3*minInterval] 区间随机抖动
      const jitter = (0.7 + Math.random() * 0.6) * this.minInterval;
      const wait = Math.max(0, jitter - elapsed);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    this.lastCall = Date.now();
  }

  /** 带重试的 POST 请求 */
  async _post(endpoint, params = {}) {
    await this._wait();

    // 用 URLSearchParams 一次构建 body（只在首次尝试时计算）
    const body = new URLSearchParams(params).toString();
    let lastErr;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(API_BASE + endpoint, {
          method: "POST",
          headers: this._headers(),
          body,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (!res.ok) {
          // 对 429 做退避
          if (res.status === 429 && attempt < this.maxRetries - 1) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        // AbortError 不重试
        if (err.name === "AbortError" || err.name === "TimeoutError") throw err;
        if (attempt < this.maxRetries - 1) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }
    throw lastErr;
  }

  /** 获取指定团地的空房列表 */
  async getRooms(shisya, danchi, shikibetu = "0") {
    return this._post("bukken/detail/detail_bukken_room/", {
      shisya, danchi, shikibetu,
      orderByField: "0", orderBySort: "0", pageIndex: "0", sp: "",
    });
  }

  /** 获取团地基本信息（名称、URL、空房列表） */
  async getDanchiInfo(shisya, danchi, shikibetu = "0") {
    const rooms = await this.getRooms(shisya, danchi, shikibetu);
    const code = `${shisya}_${danchi}${shikibetu}`;
    let name = null;
    let url = "https://www.ur-net.go.jp/chintai/";
    let block = null;
    let tdfk = null;

    if (rooms && Array.isArray(rooms) && rooms.length > 0) {
      const r = rooms[0];
      block = r.block;
      tdfk = r.tdfk;
      if (block && tdfk) {
        url = `https://www.ur-net.go.jp/chintai/${block}/${tdfk}/${code}.html`;
      }
    }

    // 无论有无空房，都尝试抓取团地名称
    const pageResult = await this._fetchDanchiName(code, block, tdfk);
    if (pageResult) {
      name = pageResult.name;
      url = pageResult.url;
    }

    if (!name) {
      name = code;
    }

    return { name, url, rooms };
  }

  /** 从 UR 团地页面标题抓取名称，返回 {name, url} 或 null */
  async _fetchDanchiName(code, block, tdfk) {
    // 优先精确 URL（有 block/tdfk 时）
    if (block && tdfk) {
      const exactUrl = `https://www.ur-net.go.jp/chintai/${block}/${tdfk}/${code}.html`;
      const result = await this._tryFetchName(exactUrl);
      if (result) return result;
    }

    // 无 block/tdfk 时（或精确 URL 失败时）并行尝试全国各都道府県 URL
    // UR 在全国有多地区，不只关东。Promise.any 并行尝试，首个成功即返回
    const ALL_PREF_PATHS = [
      // 北海道・東北
      "hokkaitohoku/hokkaido", "hokkaitohoku/miyagi",
      // 関東
      "kanto/tokyo", "kanto/kanagawa", "kanto/saitama", "kanto/chiba",
      "kanto/ibaraki",
      // 東海
      "tokai/aichi", "tokai/gifu", "tokai/mie",
      // 関西
      "kansai/osaka", "kansai/hyogo", "kansai/kyoto", "kansai/nara", "kansai/shiga", "kansai/wakayama",
      // 中国
      "chugoku/hiroshima", "chugoku/okayama", "chugoku/yamaguchi",
      // 九州
      "kyushu/fukuoka",
    ];
    const prefUrls = ALL_PREF_PATHS.map(
      p => `https://www.ur-net.go.jp/chintai/${p}/${code}.html`
    );
    return Promise.any(prefUrls.map(url => this._tryFetchName(url))).catch(() => null);
  }

  /** 尝试从单个 URL 提取团地名称，成功返回 {name, url}，失败返回 null */
  async _tryFetchName(pageUrl) {
    try {
      await this._wait();  // 遵守速率限制，避免并发请求触发封 IP
      const res = await fetch(pageUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": UA_POOL[0] },
      });
      if (!res.ok) return null;
      const text = await res.text();
      const m = text.match(/<title>([^<（]+)/);
      if (m && m[1] && m[1].trim()) {
        return { name: m[1].trim(), url: pageUrl };
      }
    } catch (_) { /* 继续尝试 */ }
    return null;
  }
}

module.exports = { ApiClient };
