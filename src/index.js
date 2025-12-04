// === Cloudflare Worker: GMSTR/XAGTRY + Trend Premium (with logging, verbose & dry-run) ===

// ───────────────────────────────────────────────────────────────────────────────
// Mini Logger (console + optional JSON "logs" when ?verbose=1)
// ENV: LOG_LEVEL=info|debug (default: info), LOG_TO_CONSOLE=1|0 (default: 1)
// ───────────────────────────────────────────────────────────────────────────────
function newLogger(env, url) {
  const logs = [];
  const level = (env && env.LOG_LEVEL) || "info";         // "info" | "debug"
  const wantConsole = (env && env.LOG_TO_CONSOLE) !== "0"; // default console ON

  function push(kind, msg, extra) {
    const ts = new Date().toISOString();
    const line = { ts, kind, msg, ...(extra ? { extra } : {}) };
    logs.push(line);
    if (wantConsole) {
      (kind === "error" ? console.error : console.log)(
        `[${ts}] [${kind}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`
      );
    }
  }

  return {
    info: (m, e) => (level === "info" || level === "debug") && push("info", m, e),
    debug: (m, e) => (level === "debug") && push("debug", m, e),
    error: (m, e) => push("error", m, e),
    dumpIfRequested: () =>
      url && url.searchParams.get("verbose") === "1" ? logs : undefined,
  };
}

// küçük bekleme
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────────
// TREND PARAMETRELERİ (env üzerinden override edilebilir)
// TradingView çizgin: 30 Apr 2012 => 2238, 15 Dec 2025 => 2022
// Toplam bar (günlük iş günü ekseni): 3417
// Gün -> bar katsayısı: 0.686558168
// calcFairRatioToday => yüzde (%), örn 22.35 döndürür
// ───────────────────────────────────────────────────────────────────────────────
const TREND_START_DATE = (env) => env?.TREND_START_DATE || "2012-04-30";
const TREND_START_VAL  = (env) => Number(env?.TREND_START_VAL  || 2238);
const TREND_END_DATE   = (env) => env?.TREND_END_DATE   || "2025-12-15";
const TREND_END_VAL    = (env) => Number(env?.TREND_END_VAL    || 2022);
const TREND_TOTAL_BARS = (env) => Number(env?.TREND_TOTAL_BARS || 3417);
const TREND_DAY2BAR_K  = (env) => Number(env?.TREND_DAY2BAR_K  || 0.686558168);

// Bugün için adil oran (GMSTR/XAGTRY %) hesapla
function calcFairRatioToday(env, today = new Date()) {
  const start = new Date(TREND_START_DATE(env) + "T00:00:00Z");
  const y1 = TREND_START_VAL(env);
  const y2 = TREND_END_VAL(env);
  const totalBars = TREND_TOTAL_BARS(env);
  const k = TREND_DAY2BAR_K(env);

  const daysSinceStart = (today - start) / 86400000; // takvim günü
  const barIdx = daysSinceStart * k;                 // gün -> bar
  const t = Math.max(0, Math.min(1, barIdx / totalBars)); // 0..1 arası ilerleme

  const yToday = y1 + (y2 - y1) * t; // doğrusal interpolasyon
  return yToday / 100;               // yüzdeye çevir (2235 -> %22.35)
}

// ───────────────────────────────────────────────────────────────────────────────
// Veri Kaynakları
// ───────────────────────────────────────────────────────────────────────────────

// Yahoo: önce v7 quote, olmazsa v8 chart (1d/1m → 5d/5m → 1mo/1d)
async function fetchYahooQuote(symbol, log) {
  const uaHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
  };

  const qUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
    symbol
  )}&_=${Date.now() % 1e6}`;

  let res = await fetch(qUrl, {
    headers: uaHeaders,
    cf: { cacheTtl: 60, cacheEverything: true },
  });

  for (let i = 1; res.status === 429 && i <= 3; i++) {
    log && log.info("yahoo:quote:429_retry", { i });
    await sleep(500 * i);
    res = await fetch(qUrl, {
      headers: uaHeaders,
      cf: { cacheTtl: 60, cacheEverything: true },
    });
  }

  if (res.ok) {
    try {
      const j = await res.json();
      const it = j?.quoteResponse?.result?.[0];
      const price =
        it?.regularMarketPrice ?? it?.postMarketPrice ?? it?.preMarketPrice;
      if (typeof price === "number") {
        log && log.debug("yahoo:quote:ok", { symbol, price });
        return price;
      }
      log && log.debug("yahoo:quote:no_price", { symbol });
    } catch (e) {
      log && log.debug("yahoo:quote:json_error", { e: String(e) });
    }
  } else {
    log && log.debug("yahoo:quote:fail", { status: res.status });
  }

  const tryChart = async (range, interval) => {
    const cUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=${range}&interval=${interval}&corsDomain=finance.yahoo.com&_=${
      Date.now() % 1e6
    }`;
    let r = await fetch(cUrl, {
      headers: uaHeaders,
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    for (let i = 1; r.status === 429 && i <= 3; i++) {
      log && log.info("yahoo:chart:429_retry", { i, range, interval });
      await sleep(500 * i);
      r = await fetch(cUrl, {
        headers: uaHeaders,
        cf: { cacheTtl: 60, cacheEverything: true },
      });
    }
    if (!r.ok) {
      log && log.debug("yahoo:chart:fail", { status: r.status, range, interval });
      return null;
    }
    const j = await r.json();
    const res0 = j?.chart?.result?.[0];
    if (!res0) return null;

    let p = res0?.meta?.regularMarketPrice;
    if (typeof p !== "number") {
      const closes = res0?.indicators?.quote?.[0]?.close || [];
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === "number") {
          p = closes[i];
          break;
        }
      }
    }
    if (typeof p === "number") {
      log && log.debug("yahoo:chart:ok", { symbol, range, interval, price: p });
      return p;
    }
    return null;
  };

  let price = await tryChart("1d", "1m");
  if (price == null) price = await tryChart("5d", "5m");
  if (price == null) price = await tryChart("1mo", "1d");

  if (price == null) {
    throw new Error(`Yahoo quote failed: ${res.status} ${res.statusText || ""}`.trim());
  }
  return price;
}

// Stooq: CSV (sağlam) — q/l (tek satır) → olmazsa q/d/l (tarih serisi)
async function fetchStooqClose(symbol, log) {
  const tryUrls = [
    `https://stooq.com/q/l/?s=${encodeURIComponent(
      symbol.toLowerCase()
    )}&f=sd2t2ohlcv&h&e=csv&_=${Date.now() % 1e6}`,
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(
      symbol.toLowerCase()
    )}&i=d&_=${Date.now() % 1e6}`,
  ];

  for (const url of tryUrls) {
    const res = await fetch(url, {
      cf: { cacheTtl: 30, cacheEverything: true },
    });
    if (!res.ok) {
      log && log.debug("stooq:res:not_ok", { url, status: res.status });
      continue;
    }

    const text = (await res.text()).trim();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) continue;

    const header = lines[0].split(",");
    const closeIdx = header.findIndex((h) => h.trim().toLowerCase() === "close");
    if (closeIdx === -1) continue;

    for (let i = lines.length - 1; i >= 1; i--) {
      const cols = lines[i].split(",");
      const raw = (cols[closeIdx] || "").trim();
      const val = Number(raw.replace(",", "."));
      if (isFinite(val)) {
        log && log.debug("stooq:ok", { symbol, val });
        return val;
      }
    }
  }

  throw new Error(`Stooq close not found for ${symbol}`);
}

// ───────────────────────────────────────────────────────────────────────────────
// Google Sheets
// ───────────────────────────────────────────────────────────────────────────────
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function pemToArrayBuffer(pem) {
  const base = pem
    .replace(/\r/g, "")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");
  const bin = atob(base);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function signJWT_RS256(payload, pem) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (o) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  const data = `${enc(header)}.${enc(payload)}`;

  const keyBuf = pemToArrayBuffer(pem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(data)
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${data}.${b64}`;
}

async function getAccessToken(env, log) {
  const now = Math.floor(Date.now() / 1000);
  const privateKeyFixed = (env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const payload = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: GOOGLE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const jwt = await signJWT_RS256(payload, privateKeyFixed);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token failed");
  const j = await r.json();
  log && log.debug("sheets:token.ok");
  return j.access_token;
}

async function getSheetIdByName(env, token) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}?fields=sheets(properties(sheetId,title))`;
  const r = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("spreadsheets.get failed");
  const j = await r.json();
  const m = j.sheets?.find((s) => s.properties?.title === env.SHEET_NAME);
  if (!m) throw new Error(`sheet "${env.SHEET_NAME}" not found`);
  return m.properties.sheetId;
}

function fmtTS_TR() {
  const dt = new Date();
  const fmt = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(dt).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second} GMT+3`;
}

async function ensureHeader(env, token) {
  const header = [
    [
      "Timestamp",              // A
      "GMSTR",                  // B
      "XAGTRY",                 // C
      "GMSTR/XAGTRY (%)",       // D
      "% prim/iskonto (oran)",  // E
      "Adil GMSTR",             // F
      "% prim/iskonto (fiyat)", // G
      "GLDTR",                  // H
      "XAUTRY",                 // I
      "GLDTR/XAUTRY (%)"        // J  (şu an %)
    ],
  ];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(
    env.SHEET_NAME
  )}!A1:J1?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: header }),
  });
  if (!r.ok) throw new Error("header write failed");
}

async function insertRow2(env, token, rowValues, log) {
  const sheetId = await getSheetIdByName(env, token);
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`;

  // 2. satırın önüne ekle
  const addReq = {
    requests: [
      {
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 },
          inheritFromBefore: false,
        },
      },
    ],
  };
  const r1 = await fetch(batchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(addReq),
  });
  if (!r1.ok) throw new Error("insertRow2 failed (insertDimension)");
  log && log.debug("sheets:insertRow2:insertDimension.ok");

  // 2. satıra yaz
  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(
    env.SHEET_NAME
  )}!A2:J2?valueInputOption=USER_ENTERED`;
  const r2 = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [rowValues] }),
  });
  if (!r2.ok) throw new Error("insertRow2 failed (write row2)");
  log && log.debug("sheets:insertRow2:writeRow.ok");

  // 200+ satırsa alttan sil
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(
    env.SHEET_NAME
  )}!A:A`;
  const r3 = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r3.ok) {
    const j = await r3.json();
    const rows = j.values?.length || 0;
    if (rows > 201) {
      const delReq = {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: rows - 1,
                endIndex: rows,
              },
            },
          },
        ],
      };
      const rDel = await fetch(batchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(delReq),
      });
      if (rDel.ok) log && log.debug("sheets:trim:ok", { deleted: 1 });
    }
  }
}

async function colorize(env, token, log) {
  const sheetId = await getSheetIdByName(env, token);
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(
    env.SHEET_NAME
  )}!A2:J3`;
  const r = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return;

  const j = await r.json();
  const rows = j.values || [];
  if (rows.length < 2) return;

  const cur = rows[0]; // A2..J2
  const prev = rows[1]; // A3..J3

  const colsToCompare = [1, 2, 3, 7, 8, 9]; // B,C,D,H,I,J
  const requests = [];

  function makeColor(r, g, b) {
    return { red: r / 255, green: g / 255, blue: b / 255 };
  }
  const green = makeColor(199, 233, 192); // up (artan)
  const red   = makeColor(253, 205, 197); // down (düşen)
  const yellow= makeColor(255, 255, 204); // same / NA

  colsToCompare.forEach((cIdx) => {
    const vCur = Number(String(cur[cIdx] ?? "").toString().replace(",", "."));
    const vPrev = Number(String(prev[cIdx] ?? "").toString().replace(",", "."));
    let fill = yellow;
    if (isFinite(vCur) && isFinite(vPrev)) {
      fill = vCur > vPrev ? green : vCur < vPrev ? red : yellow;
    }
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: cIdx,
          endColumnIndex: cIdx + 1,
        },
        cell: { userEnteredFormat: { backgroundColor: fill } },
        fields: "userEnteredFormat.backgroundColor",
      },
    });
  });

  // E (oran prim/iskonto) & G (fiyat prim/iskonto): negatif=yeşil, pozitif=kırmızı
  const e = Number(String(cur[4] ?? "").toString().replace(",", "."));
  const g = Number(String(cur[6] ?? "").toString().replace(",", "."));
  const eFill = isFinite(e) ? (e < 0 ? green : e > 0 ? red : yellow) : yellow;
  const gFill = isFinite(g) ? (g < 0 ? green : g > 0 ? red : yellow) : yellow;

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 4, endColumnIndex: 5 },
      cell: { userEnteredFormat: { backgroundColor: eFill } },
      fields: "userEnteredFormat.backgroundColor",
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 6, endColumnIndex: 7 },
      cell: { userEnteredFormat: { backgroundColor: gFill } },
      fields: "userEnteredFormat.backgroundColor",
    },
  });

  if (requests.length) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });
  }
  log && log.debug("sheets:colorize:ok");
}

// ───────────────────────────────────────────────────────────────────────────────
// Worker Handler
// ───────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const log = newLogger(env, url);

    try {
      log.info("request:start", { path: url.pathname, qs: Object.fromEntries(url.searchParams) });

      // 1) Verileri çek
      log.info("fetch:prices:start");
      const [gmstr, xagtry, gldtr, xautry] = await Promise.all([
        fetchYahooQuote(env.YAHOO_SYMBOL || "GMSTR.IS", log),
        fetchStooqClose("XAGTRY", log),
        fetchYahooQuote("GLDTR.IS", log),
        fetchStooqClose("XAUTRY", log),
      ]);
      log.info("fetch:prices:done", { gmstr, xagtry, gldtr, xautry });

      // 2) Oranlar
      const ratioGMSTR_XAG = (gmstr / xagtry) * 100; // %
      const ratioGLDTR_XAU = (gldtr / xautry) * 100; // %
      log.info("calc:ratios", { ratioGMSTR_XAG, ratioGLDTR_XAU });

      // 3) Trend → adil oran (%, zaten % döner)
      const fairRatio = calcFairRatioToday(env);
      log.info("calc:trend", { fairRatio });

      // 4) Adil GMSTR ve prim/iskonto
      const fairGMSTR = (fairRatio / 100) * xagtry;
      const premOran = ((ratioGMSTR_XAG - fairRatio) / fairRatio) * 100;
      const premFiyat = ((gmstr - fairGMSTR) / fairGMSTR) * 100;
      log.info("calc:fair_and_premium", { fairGMSTR, premOran, premFiyat });

      // DRY-RUN: sadece hesap + log, Sheets'e yazma
      if (url.searchParams.get("dry") === "1") {
        const payload = {
          ok: true,
          dry: true,
          ts: fmtTS_TR(),
          gmstr,
          xagtry,
          ratioGMSTR_XAG: Number(ratioGMSTR_XAG.toFixed(4)),
          fairRatio: Number(fairRatio.toFixed(4)),
          fairGMSTR: Number(fairGMSTR.toFixed(4)),
          premOran: Number(premOran.toFixed(4)),
          premFiyat: Number(premFiyat.toFixed(4)),
          gldtr,
          xautry,
          ratioGLDTR_XAU: Number(ratioGLDTR_XAU.toFixed(4)),
        };
        const maybeLogs = log.dumpIfRequested();
        if (maybeLogs) payload.logs = maybeLogs;
        log.info("request:dry_done");
        return new Response(JSON.stringify(payload, null, 2), {
          headers: { "content-type": "application/json" },
        });
      }

      // 5) Sheets’e yaz
      const token = await getAccessToken(env, log);
      await ensureHeader(env, token);

      const ts = fmtTS_TR();
      const row = [
        ts,                                         // A
        gmstr,                                      // B
        xagtry,                                     // C
        Number(ratioGMSTR_XAG.toFixed(4)),          // D
        Number(premOran.toFixed(4)),                // E
        Number(fairGMSTR.toFixed(4)),               // F
        Number(premFiyat.toFixed(4)),               // G
        gldtr,                                      // H
        xautry,                                     // I
        Number(ratioGLDTR_XAU.toFixed(4)),          // J
      ];

      log.info("sheets:insertRow2:start");
      await insertRow2(env, token, row, log);
      log.info("sheets:insertRow2:done");

      log.info("sheets:colorize:start");
      await colorize(env, token, log);
      log.info("sheets:colorize:done");

      const payload = {
        ok: true,
        ts,
        gmstr,
        xagtry,
        ratioGMSTR_XAG: Number(ratioGMSTR_XAG.toFixed(4)),
        fairRatio: Number(fairRatio.toFixed(4)),
        fairGMSTR: Number(fairGMSTR.toFixed(4)),
        premOran: Number(premOran.toFixed(4)),
        premFiyat: Number(premFiyat.toFixed(4)),
        gldtr,
        xautry,
        ratioGLDTR_XAU: Number(ratioGLDTR_XAU.toFixed(4)),
      };

      const maybeLogs = log.dumpIfRequested();
      if (maybeLogs) payload.logs = maybeLogs;

      log.info("request:done");
      return new Response(JSON.stringify(payload, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      const payload = { ok: false, error: String(err) };
      const maybeLogs = log.dumpIfRequested();
      if (maybeLogs) payload.logs = maybeLogs;
      log.error("request:error", { error: String(err) });
      return new Response(JSON.stringify(payload, null, 2), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
