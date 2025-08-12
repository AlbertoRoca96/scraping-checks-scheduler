// src/index.js
import { promises as fsp } from "fs";
import path from "path";
import { chromium } from "playwright";
import checks from "./checks.js";
import crypto from "crypto";
import { gunzipSync } from "zlib";
import { URL } from "url";

/* ================================
   Config
=================================== */
const root = process.cwd();
const REALISTIC_UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FAIL_ON_ERROR = process.env.FAIL_ON_ERROR === "1";
const GROUP = process.env.GROUP || "";
const GOTO_WAIT_UNTIL = (process.env.GOTO_WAIT_UNTIL || "domcontentloaded");
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 45000);

// Stock providers
const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;

/* ================================
   fs helpers
=================================== */
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; } }
async function writeJson(p, obj) { await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
async function appendLine(p, line) { await ensureDir(path.dirname(p)); await fsp.appendFile(p, line, "utf8"); }

/* ================================
   normalize + diff
=================================== */
function normalizeValue(v) {
  if (typeof v === "string") {
    const trimmed = v.replace(/\s+/g, " ").trim();
    const num = trimmed.replace(/[^\d.,-]/g, "");
    if (/\d/.test(num)) {
      const n = Number(num.replace(/,/g, ""));
      if (!Number.isNaN(n)) return n;
    }
    return trimmed;
  }
  if (Array.isArray(v)) return v.map(normalizeValue).sort();
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeValue(v[k]);
    return out;
  }
  return v;
}
function simpleDiff(a, b, ignore = []) {
  const A = normalizeValue(a) ?? {};
  const B = normalizeValue(b) ?? {};
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  const changed = [];
  for (const k of keys) {
    if (ignore.includes(k)) continue;
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) changed.push(k);
  }
  return changed;
}

/* ================================
   utils
=================================== */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(label, fn, { tries = 3, baseMs = 800 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < tries) await delay(baseMs * i);
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(lastErr)}`);
}
function runUrl() {
  const s = process.env.GITHUB_SERVER_URL;
  const r = process.env.GITHUB_REPOSITORY;
  const id = process.env.GITHUB_RUN_ID;
  if (s && r && id) return `${s}/${r}/actions/runs/${id}`;
  return null;
}

/* ================================
   time-series helper
=================================== */
function seriesValueFor(type, data) {
  if (type === "price" || type === "psa_price_row" || type === "stock") {
    const v = data?.price;
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }
  if (type === "availability") {
    if (typeof data?.available === "boolean") return data.available ? 1 : 0;
    return null;
  }
  if (type === "psa_pop_row") {
    const v = data?.population;
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }
  return null;
}

/* ================================
   Playwright: robust page factory
=================================== */
async function newPage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: REALISTIC_UA,
    locale: "en-US",
    viewport: { width: 1366, height: 900 }
  });
  await context.route("**/*", (route) => {
    const rt = route.request().resourceType();
    if (rt === "image" || rt === "media" || rt === "font") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  return { browser, context, page };
}

/* ================================
   generic table helpers (DOM)
=================================== */
function toNumberLike(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^\d.+-]/g, "").replace(/,/g, "").replace(/[+–-]+$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
async function scrapeFirstTableMatrix(page) {
  await page.waitForSelector("table");
  return await page.evaluate(() => {
    const tbl = document.querySelector("table");
    const headers = Array.from(tbl.querySelectorAll("thead th, thead td")).map(th => th.innerText.trim());
    const rows = Array.from(tbl.querySelectorAll("tbody tr"))
      .map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim()));
    return { headers, rows };
  });
}

/* ================================
   HTML fetch helpers (gzip aware)
=================================== */
function looksLikeGzip(buf) { return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b; }
async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": REALISTIC_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache"
    }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}
async function fetchTextMaybeGzip(url) {
  const { res, buf } = await withRetry(`fetch ${url}`, () => fetchBuffer(url));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const ce = (res.headers.get("content-encoding") || "").toLowerCase();
  const gzByType = ct.includes("application/gzip") || ct.includes("x-gzip");
  const gzByEnc = ce.includes("gzip");
  const gzByExt = url.toLowerCase().endsWith(".gz");
  if (gzByType || gzByEnc || gzByExt || looksLikeGzip(buf)) {
    try { return gunzipSync(buf).toString("utf8"); } catch { /* fall back */ }
  }
  return buf.toString("utf8");
}

/* ================================
   tiny HTML table parser (no deps)
=================================== */
function stripTags(s) { return s.replace(/<[^>]*>/g, " "); }
function cleanCell(s) { return stripTags(s).replace(/\s+/g, " ").trim(); }
function parseFirstTable(html) {
  const m = html.match(/<table[\s\S]*?<\/table>/i);
  if (!m) return null;
  const table = m[0];

  let headers = [];
  const thead = table.match(/<thead[\s\S]*?<\/thead>/i);
  if (thead) {
    headers = [...thead[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((x) => cleanCell(x[1]));
  } else {
    const firstTr = table.match(/<tr[\s\S]*?<\/tr>/i);
    if (firstTr) headers = [...firstTr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((x) => cleanCell(x[1]));
  }

  const bodyHtml = thead ? table.replace(thead[0], "") : table;
  const trs = [...bodyHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(x => x[0]);

  const rows = trs.map(tr =>
    [...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map(x => cleanCell(x[1]))
  ).filter(r => r.length > 0);

  return { headers, rows };
}

/* ================================
   string matching helpers
=================================== */
function looseContains(hay, needle) {
  const H = (hay || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const N = (needle || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const toks = N.split(/\s+/).filter(Boolean);
  return toks.every(t => H.includes(t));
}

/* ================================
   generic page checks (Playwright)
=================================== */
async function gotoSafely(page, url) {
  await withRetry("page.goto", () =>
    page.goto(url, { waitUntil: GOTO_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS })
  );
}
async function runPageCheck(check) {
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    const data = {};
    for (const [key, spec] of Object.entries(check.fields)) {
      const { selector, attr = "text" } = spec;
      await page.waitForSelector(selector);
      data[key] = attr === "text"
        ? (await page.textContent(selector))?.trim() ?? null
        : await page.getAttribute(selector, attr);
    }
    return data;
  } finally {
    await context.close(); await browser.close();
  }
}

/* ================================
   price + availability (Playwright)
=================================== */
function parseCurrency(txt = "") {
  const cleaned = String(txt).replace(/[^\d.,+–-]/g, "").replace(/,/g, "").replace(/[+–-]+$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
async function runPriceCheck(check) {
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    await page.waitForSelector(check.selector);
    const raw = (await page.textContent(check.selector))?.trim() ?? "";
    return { price: parseCurrency(raw), raw };
  } finally {
    await context.close(); await browser.close();
  }
}
async function runAvailabilityCheck(check) {
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    await page.waitForSelector(check.selector);
    const raw = (await page.textContent(check.selector))?.trim() ?? "";
    const re = check.availableRegex ? new RegExp(check.availableRegex, "i") : /in stock|available/i;
    return { available: re.test(raw), raw };
  } finally {
    await context.close(); await browser.close();
  }
}

/* ================================
   sitemap helpers
=================================== */
async function discoverSitemapsFromRobots(startUrl) {
  const u = new URL(startUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  try {
    const text = await fetchTextMaybeGzip(robotsUrl);
    return Array.from(text.matchAll(/(?<=^|\n)\s*Sitemap:\s*(\S+)\s*/gi)).map(m => m[1]);
  } catch { return []; }
}
function extractLocsFromXml(xml) {
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const rawLocs = Array.from(xml.matchAll(/<\s*loc\s*>\s*([^<]+)\s*<\s*\/\s*loc\s*>/gi)).map(m => m[1].trim());
  return { isIndex, locs: rawLocs };
}
async function fetchSitemapUrls(url, { indexLimit = 5, limit } = {}) {
  const queue = [url];
  const tried = new Set();
  let firstError = null;

  while (queue.length) {
    const cur = queue.shift();
    if (tried.has(cur)) continue;
    tried.add(cur);

    try {
      const xml = await fetchTextMaybeGzip(cur);
      const { isIndex, locs } = extractLocsFromXml(xml);
      const resolve = (child) => new URL(child, cur).href;

      if (isIndex) {
        const child = locs.slice(0, indexLimit).map(resolve);
        const all = [];
        for (const sm of child) {
          try {
            const subXml = await fetchTextMaybeGzip(sm);
            const sub = extractLocsFromXml(subXml);
            if (!sub.isIndex) all.push(...sub.locs.map(resolve));
          } catch { /* ignore bad child */ }
          if (limit && all.length >= limit) break;
        }
        return { source: cur, urls: limit ? all.slice(0, limit) : all };
      } else {
        const urls = (limit ? locs.slice(0, limit) : locs).map(resolve);
        return { source: cur, urls };
      }
    } catch (e) {
      if (!firstError) firstError = e;
      if (queue.length === 0 && tried.size === 1) {
        const discovered = await discoverSitemapsFromRobots(url);
        for (const d of discovered) queue.push(d);
      }
    }
  }
  const err = firstError ? firstError.message : "Unknown sitemap error";
  throw new Error(`Sitemap fetch failed: ${err}`);
}

/* ================================
   sitemap checks
=================================== */
async function runSitemapCheck(check) {
  const { urls, source } = await fetchSitemapUrls(check.url, {
    indexLimit: check.indexLimit || 5,
    limit: check.limit
  });
  return { source, count: urls.length, sample: urls.slice(0, 10), all: urls };
}
function diffSets(prev = [], next = []) {
  const A = new Set(prev);
  const B = new Set(next);
  const added = [...B].filter(x => !A.has(x)).sort();
  const removed = [...A].filter(x => !B.has(x)).sort();
  return { added, removed };
}
async function runSitemapDiffCheck(check, prevRecord) {
  const current = await runSitemapCheck(check);
  const prevAll = prevRecord?.data?.all || [];
  const { added, removed } = diffSets(prevAll, current.all);
  return { source: current.source, nowCount: current.all.length, prevCount: prevAll.length, added, removed };
}

/* ================================
   content_watch
=================================== */
async function runContentWatch(check) {
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    const selectors = Array.isArray(check.selectors) ? check.selectors : [check.selector || "body"];
    const parts = [];
    for (const sel of selectors) {
      await page.waitForSelector(sel);
      const t = await page.textContent(sel);
      if (t) parts.push(t);
    }
    let text = parts.join("\n\n");
    if (Array.isArray(check.stripPatterns)) {
      for (const pat of check.stripPatterns) {
        try {
          const re = new RegExp(pat, "gim");
          text = text.replace(re, "");
        } catch { /* ignore bad regex */ }
      }
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    const hash = crypto.createHash("sha256").update(normalized).digest("hex");
    const payload = { hash, length: normalized.length };
    if (!check.hashOnly) payload.sample = normalized.slice(0, 300);
    return payload;
  } finally {
    await context.close(); await browser.close();
  }
}

/* ================================
   PSA custom checks (HTML fallback)
=================================== */
// (unchanged helpers for PSA pages)
async function runPsaPriceRow(check) {
  try {
    const html = await fetchTextMaybeGzip(check.url);
    const parsed = parseFirstTable(html);
    if (parsed && parsed.headers.length && parsed.rows.length) {
      const { headers, rows } = parsed;
      const colIdx = headers.findIndex(h =>
        h.replace(/\s+/g, " ").toUpperCase().includes((check.gradeCol || "").toUpperCase())
      );
      if (colIdx < 0) throw new Error(`grade column not found: ${check.gradeCol}`);
      const row = rows.find(r => r.some(c => looseContains(c, check.rowMatch)));
      if (!row) throw new Error(`row not found: ${check.rowMatch}`);
      const raw = row[colIdx] || "";
      const price = toNumberLike(raw);
      return { row: row[0], grade: check.gradeCol, price, raw, mode: "html" };
    }
  } catch {}
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    const { headers, rows } = await scrapeFirstTableMatrix(page);
    const colIdx = headers.findIndex(h => h.replace(/\s+/g, " ").toUpperCase().includes((check.gradeCol || "").toUpperCase()));
    if (colIdx < 0) throw new Error(`grade column not found: ${check.gradeCol}`);
    const row = rows.find(r => r.some(c => looseContains(c, check.rowMatch)));
    if (!row) throw new Error(`row not found: ${check.rowMatch}`);
    const raw = row[colIdx] || "";
    const price = toNumberLike(raw);
    return { row: row[0], grade: check.gradeCol, price, raw, mode: "playwright" };
  } finally {
    await context.close(); await browser.close();
  }
}
async function runPsaPopRow(check) {
  try {
    const html = await fetchTextMaybeGzip(check.url);
    const parsed = parseFirstTable(html);
    if (parsed && parsed.headers.length && parsed.rows.length) {
      const { headers, rows } = parsed;
      const colName = (check.column || "TOTAL").toUpperCase();
      const colIdx = headers.findIndex(h => (h || "").trim().toUpperCase() === colName);
      if (colIdx < 0) throw new Error(`column not found: ${check.column || "TOTAL"}`);
      const row = rows.find(r => looseContains(r.join(" "), check.rowMatch));
      if (!row) throw new Error(`row not found: ${check.rowMatch}`);
      const raw = row[colIdx] || "";
      const population = toNumberLike(raw);
      return { row: row[0], column: check.column || "TOTAL", population, raw, mode: "html" };
    }
  } catch {}
  const { browser, context, page } = await newPage();
  try {
    await gotoSafely(page, check.url);
    const { headers, rows } = await scrapeFirstTableMatrix(page);
    const colName = (check.column || "TOTAL").toUpperCase();
    const colIdx = headers.findIndex(h => (h || "").trim().toUpperCase() === colName);
    if (colIdx < 0) throw new Error(`column not found: ${check.column || "TOTAL"}`);
    const row = rows.find(r => looseContains((r[1] || r[0] || ""), check.rowMatch) || looseContains(r.join(" "), check.rowMatch));
    if (!row) throw new Error(`row not found: ${check.rowMatch}`);
    const raw = row[colIdx] || "";
    const population = toNumberLike(raw);
    return { row: row[0], column: check.column || "TOTAL", population, raw, mode: "playwright" };
  } finally {
    await context.close(); await browser.close();
  }
}

/* ================================
   STOCK quotes (Alpha Vantage with optional Stooq fallback)
=================================== */
async function runStockCheck(check) {
  const provider = (check.provider || (ALPHAVANTAGE_KEY ? "alphavantage" : "stooq")).toLowerCase();

  if (provider === "alphavantage") {
    if (!ALPHAVANTAGE_KEY) throw new Error("ALPHAVANTAGE_KEY not set");
    const func = check.function || "TIME_SERIES_INTRADAY";
    const interval = check.interval || "5min";

    const url = func === "TIME_SERIES_INTRADAY"
      ? `https://www.alphavantage.co/query?function=${func}&symbol=${encodeURIComponent(check.symbol)}&interval=${interval}&outputsize=compact&apikey=${ALPHAVANTAGE_KEY}`
      : `https://www.alphavantage.co/query?function=${func}&symbol=${encodeURIComponent(check.symbol)}&outputsize=compact&apikey=${ALPHAVANTAGE_KEY}`;

    const json = await withRetry("alphavantage", async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });

    const series =
      json["Time Series (5min)"] ||
      json["Time Series (15min)"] ||
      json["Time Series (30min)"] ||
      json["Time Series (60min)"] ||
      json["Time Series (Daily)"] ||
      json["Time Series (Daily)"]; // covers daily funcs

    if (!series || typeof series !== "object") {
      const note = json?.Note || json?.Information || "unexpected response";
      throw new Error(`Alpha Vantage: ${note}`);
    }

    const latestTs = Object.keys(series).sort().pop();
    const row = series[latestTs] || {};
    const toNum = (k) => toNumberLike(row[k]) ?? toNumberLike(row[k?.toLowerCase?.()]);
    const price = toNum("4. close");

    return {
      provider: "alphavantage",
      symbol: check.symbol,
      function: func,
      interval: func.includes("INTRADAY") ? interval : "1d",
      latest: latestTs,
      price,
      open: toNum("1. open"),
      high: toNum("2. high"),
      low:  toNum("3. low"),
      volume: toNum("5. volume")
    };
  }

  // Stooq last-quote CSV: symbol, date, time, open, high, low, close, volume
  // Example pattern: https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv
  const stq = check.stooqSymbol || (check.symbol || "").toLowerCase();
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stq)}&f=sd2t2ohlcv&h&e=csv`;
  const csv = await fetchTextMaybeGzip(url);
  const line = (csv.trim().split("\n").slice(-1)[0] || "").trim();
  const parts = line.split(",");
  if (parts.length < 8) throw new Error(`stooq parse failed (${line})`);
  const [symbol, date, time, open, high, low, close, volume] = parts;

  return {
    provider: "stooq",
    symbol,
    latest: `${date} ${time}`,
    price: toNumberLike(close),
    open: toNumberLike(open),
    high: toNumberLike(high),
    low: toNumberLike(low),
    volume: toNumberLike(volume)
  };
}

/* ================================
   webhook
=================================== */
async function sendWebhook({ check, changedKeys, record, previous }) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return { sent: false, reason: "no WEBHOOK_URL set" };
  const link = runUrl();
  const text = changedKeys.length
    ? `✅ ${check} changed (${changedKeys.join(", ")})\n${link ?? ""}`.trim()
    : `ℹ️ ${check} ran with no changes.\n${link ?? ""}`.trim();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        content: text,
        event: "scrape.changed",
        check,
        changedKeys,
        current: record,
        previous
      })
    });
    return { sent: true, status: res.status };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

/* ================================
   main
=================================== */
async function run() {
  const resultsDir = path.join(root, "data");
  const latestDir = path.join(resultsDir, "latest");
  const historyDir = path.join(resultsDir, "history");
  await Promise.all([ensureDir(latestDir), ensureDir(historyDir)]);

  const todo = checks.filter(c => !GROUP || c.group === GROUP);
  const checkNames = new Set(todo.map(c => c.name));

  const summary = [];
  let hadError = false;

  for (const check of todo) {
    const startedAt = new Date().toISOString();
    let record; let changed = false; let changedKeys = [];
    try {
      const latestPath = path.join(latestDir, `${check.name}.json`);
      const prev = await readJson(latestPath);

      let data;
      if (check.type === "page") data = await runPageCheck(check);
      else if (check.type === "price") data = await runPriceCheck(check);
      else if (check.type === "availability") data = await runAvailabilityCheck(check);
      else if (check.type === "sitemap") data = await runSitemapCheck(check);
      else if (check.type === "sitemap_diff") data = await runSitemapDiffCheck(check, prev);
      else if (check.type === "content_watch") data = await runContentWatch(check);
      else if (check.type === "psa_price_row") data = await runPsaPriceRow(check);
      else if (check.type === "psa_pop_row") data = await runPsaPopRow(check);
      else if (check.type === "stock") data = await runStockCheck(check);
      else throw new Error(`Unknown check type: ${check.type}`);

      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, data };

      const ignore = Array.isArray(check.ignoreKeys) ? check.ignoreKeys : [];
      changedKeys = simpleDiff(prev?.data, data, ignore);
      changed = changedKeys.length > 0;

      await writeJson(latestPath, record);

      // append time-series (JSONL)
      try {
        const tsVal = seriesValueFor(check.type, data);
        if (tsVal !== null) {
          const line = JSON.stringify({ t: startedAt, v: tsVal }) + "\n";
          const tsPath = path.join(resultsDir, "timeseries", check.name, "series.jsonl");
          await appendLine(tsPath, line);
        }
      } catch {}

      if (changed) {
        const stamp = startedAt.replace(/[:]/g, "-");
        const histPath = path.join(historyDir, check.name, `${stamp}.json`);
        await writeJson(histPath, record);
        await sendWebhook({ check: check.name, changedKeys, record, previous: prev });
      }

      summary.push({ name: check.name, type: check.type, changed, changedKeys, error: null });
      console.log(`[${check.name}] changed=${changed} keys=${changedKeys.join(",")}`);
    } catch (e) {
      hadError = true;
      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, error: String(e) };
      await writeJson(path.join(latestDir, `${check.name}.json`), record);
      summary.push({ name: check.name, type: check.type, changed: false, changedKeys: [], error: String(e) });
      console.error(`[${check.name}] ERROR: ${String(e)}`);
    }
  }

  // prune stale latest files
  try {
    const files = await fsp.readdir(latestDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const name = f.replace(/\.json$/, "");
      if (!checkNames.has(name)) {
        await fsp.unlink(path.join(latestDir, f));
        console.log(`[prune] removed stale ${f}`);
      }
    }
  } catch (e) {
    console.warn(`[prune] warning: ${String(e)}`);
  }

  // write per-group reports
  await writeJson(path.join(resultsDir, `report-${GROUP || "all"}.json`), {
    generatedAt: new Date().toISOString(),
    group: GROUP || "all",
    summary
  });
  const mdLines = [
    `# Scrape Report (${new Date().toISOString()})`,
    ``,
    `Group: \`${GROUP || "all"}\`  |  Run: ${runUrl() ?? "(local)"}`,
    ``,
    `| Check | Changed | Keys | Error |`,
    `|---|:---:|:--|:--|`,
    ...summary.map(s => `| \`${s.name}\` | ${s.changed ? "✅" : "—"} | ${s.changedKeys.join(", ")} | ${s.error ? "`" + s.error + "`" : ""} |`)
  ];
  await fsp.writeFile(path.join(resultsDir, `report-${GROUP || "all"}.md`), mdLines.join("\n") + "\n", "utf8");

  console.log("\nDone. Summary:\n", JSON.stringify(summary, null, 2));
  if (hadError && FAIL_ON_ERROR) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
