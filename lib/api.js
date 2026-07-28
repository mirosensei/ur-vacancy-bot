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

  /** 获取团地基本信息（名称、URL） — 不查空房，让 checkAll 负责 */
  async getDanchiInfo(shisya, danchi, shikibetu = "0") {
    const code = `${shisya}_${danchi}${shikibetu}`;
    const meta = await this._getDanchiMeta(shisya, danchi, shikibetu);

    const name = meta?.name || code;

    // URL: 优先 ALT 文本中的都道府県名，其次支社推测
    let url;
    if (meta?.prefPath) {
      url = `https://www.ur-net.go.jp/chintai/${meta.prefPath}/${code}.html`;
    } else {
      const region = _guessRegion(shisya);
      url = region
        ? `https://www.ur-net.go.jp/chintai/${region}/${code}.html`
        : "https://www.ur-net.go.jp/chintai/";
    }

    return { name, url };
  }

  /** 从 detail_bukken API 提取团地名称和都道府県路径 */
  async _getDanchiMeta(shisya, danchi, shikibetu) {
    try {
      const data = await this._post("bukken/detail/detail_bukken/", {
        shisya, danchi, shikibetu,
        orderByField: "0", orderBySort: "0", pageIndex: "0", sp: "",
      });
      const alt = data?.[0]?.img?.[0]?.ALT;
      if (!alt) return null;

      // ALT: "京都府京都市右京区にあるUR賃貸住宅 嵯峨の外観写真 1/13"
      // 无效 ALT: "にあるUR賃貸住宅 の 1/2"（不存在团地返回的占位数据）
      const prefM = alt.match(/^(\S{2,4}?[都道府県])/);
      const prefPath = prefM ? PREF_PATH_MAP[prefM[1]] : null;

      let name = null;
      const nameM = alt.match(/UR賃貸住宅\s+(.+?)(?:の外観|の周辺|の住棟|の交通|$)/);
      if (nameM) {
        const raw = nameM[1].trim();
        // 过滤无效占位数据：全角字母、纯空白、"の"开头等
        if (raw && !/^[\s\x00-\x7f　・。、の]*$/.test(raw) && raw.length >= 2) {
          name = raw;
        }
      }

      return { name, prefPath };
    } catch (_) { /* fall through */ }
    return null;
  }
}

/** 都道府県名 → URL 路径（从 ALT 文本提取，精确） */
const PREF_PATH_MAP = {
  "北海道": "hokkaitohoku/hokkaido",  "宮城県": "hokkaitohoku/miyagi",
  "東京都": "kanto/tokyo",           "神奈川県": "kanto/kanagawa",
  "埼玉県": "kanto/saitama",         "千葉県": "kanto/chiba",
  "茨城県": "kanto/ibaraki",
  "愛知県": "tokai/aichi",           "岐阜県": "tokai/gifu",
  "三重県": "tokai/mie",
  "大阪府": "kansai/osaka",          "兵庫県": "kansai/hyogo",
  "京都府": "kansai/kyoto",          "奈良県": "kansai/nara",
  "滋賀県": "kansai/shiga",          "和歌山県": "kansai/wakayama",
  "広島県": "chugoku/hiroshima",     "岡山県": "chugoku/okayama",
  "山口県": "chugoku/yamaguchi",
  "福岡県": "kyushu/fukuoka",
};

/** 支社 → 都道府県路径推测（最后兜底，仅 PREF_PATH_MAP 无法覆盖时使用） */
function _guessRegion(shisya) {
  // 按支社推测都道府県路径 — 见 ur-notifier 项目
  const MAP = {
    // 北海道・東北 (01-09)
    "01": "hokkaitohoku/hokkaido", "04": "hokkaitohoku/miyagi",
    // 関東 (10-70)
    "10": "kanto/tokyo",    "11": "kanto/tokyo",
    "12": "kanto/tokyo",    "13": "kanto/tokyo",
    "20": "kanto/kanagawa", "21": "kanto/kanagawa",
    "30": "kanto/chiba",    "31": "kanto/chiba",
    "40": "kanto/saitama",  "41": "kanto/saitama",
    "50": "kanto/ibaraki",  "60": "kanto/gunma",
    "70": "kanto/tochigi",
    // 関西 (80-86)
    "80": "kansai/osaka",   "81": "kansai/osaka",
    "82": "kansai/hyogo",   "83": "kansai/kyoto",
    "84": "kansai/shiga",   "85": "kansai/nara",
    "86": "kansai/wakayama",
    // 東海 (90-92)
    "90": "tokai/aichi",    "91": "tokai/gifu",
    "92": "tokai/mie",
  };
  return MAP[shisya] || null;
}

module.exports = { ApiClient };
