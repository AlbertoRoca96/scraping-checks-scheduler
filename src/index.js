// src/index.js
import { promises as fsp } from "fs";
import path from "path";
import { chromium } from "playwright";
import checks from "./checks.js";
import crypto from "crypto";
import { gunzipSync } from "zlib";
import { URL } from "url";

const root = process.cwd();
const USER_AGENT =
  "Mozilla/5.0 (compatible; ScrapingChecksScheduler/0.4; +https://github.com/)";
const FAIL_ON_ERROR = process.env.FAIL_ON_ERROR === "1";
const GROUP = process.env.GROUP || ""; // run only checks with matching `group`, if set

// ---------- fs helpers ----------
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; } }
async function writeJson(p, obj) { await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
// Append a line of UTF-8 text to a file (create if missing)
async function appendLine(p, line) { await ensureDir(path.dirname(p)); await fsp.appendFile(p, line, "utf8"); }

// ---------- normalize + diff ----------
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

// ---------- utils ----------
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

// ---------- tiny helper for time-series ----------
// For now we only record price & availability to keep series small.
function seriesValueFor(type, data) {
  if (type === "price") {
    const v = data?.price;
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }
  if (type === "availability") {
    if (typeof data?.available === "boolean") return data.available ? 1 : 0;
    return null;
  }
  return null;
}

// ---------- page helpers ----------
async function newPage() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "User-Agent": USER_AGENT });
  page.setDefaultTimeout(20000);
  return { browser, page };
}

// ---------- check: page (generic field scraping) ----------
async function runPageCheck(check) {
  const { browser, page } = await newPage();
  try {
    await withRetry("page.goto", () => page.goto(check.url, { waitUntil: "domcontentloaded" }));
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
    await browser.close();
  }
}

// ---------- check: price ----------
function parseCurrency(txt = "") {
  const cleaned = (txt || "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
async function runPriceCheck(check) {
  const { browser, page } = await newPage();
  try {
    await withRetry("page.goto", () => page.goto(check.url, { waitUntil: "domcontentloaded" }));
    await page.waitForSelector(check.selector);
    const raw = (await page.textContent(check.selector))?.trim() ?? "";
    return { price: parseCurrency(raw), raw };
  } finally {
    await browser.close();
  }
}

// ---------- check: availability ----------
async function runAvailabilityCheck(check) {
  const { browser, page } = await newPage();
  try {
    await withRetry("page.goto", () => page.goto(check.url, { waitUntil: "domcontentloaded" }));
    await page.waitForSelector(check.selector);
    const raw = (await page.textContent(check.selector))?.trim() ?? "";
    const re = check.availableRegex ? new RegExp(check.availableRegex, "i") : /in stock|available/i;
    return { available: re.test(raw), raw };
  } finally {
    await browser.close();
  }
}

// ---------- sitemap helpers ----------
function looksLikeGzip(buf) { return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b; }
async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "*/*" } });
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
function extractLocsFromXml(xml) {
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const rawLocs = Array.from(xml.matchAll(/<\s*loc\s*>\s*([^<]+)\s*<\s*\/\s*loc\s*>/gi)).map(m => m[1].trim());
  return { isIndex, locs: rawLocs };
}
async function discoverSitemapsFromRobots(startUrl) {
  const u = new URL(startUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  try {
    const text = await fetchTextMaybeGzip(robotsUrl);
    return Array.from(text.matchAll(/(?<=^|\n)\s*Sitemap:\s*(\S+)\s*/gi)).map(m => m[1]);
  } catch { return []; }
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

// ---------- check: sitemap (raw) ----------
async function runSitemapCheck(check) {
  const { urls, source } = await fetchSitemapUrls(check.url, {
    indexLimit: check.indexLimit || 5,
    limit: check.limit
  });
  return { source, count: urls.length, sample: urls.slice(0, 10), all: urls };
}

// ---------- check: sitemap_diff ----------
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
  return {
    source: current.source,
    nowCount: current.all.length,
    prevCount: prevAll.length,
    added,
    removed
  };
}

// ---------- check: content_watch ----------
async function runContentWatch(check) {
  const { browser, page } = await newPage();
  try {
    await withRetry("page.goto", () => page.goto(check.url, { waitUntil: "domcontentloaded" }));
    const selectors = Array.isArray(check.selectors) ? check.selectors : [check.selector || "body"];
    const parts = [];
    for (const sel of selectors) {
      await page.waitForSelector(sel);
      const t = await page.textContent(sel);
      if (t) parts.push(t);
    }
    let text = parts.join("\n\n");
    // strip dynamic noise if configured
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
    await browser.close();
  }
}

// ---------- webhook ----------
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
        text,               // Slack-compatible
        content: text,      // Discord-compatible
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

// ---------- main ----------
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
      else throw new Error(`Unknown check type: ${check.type}`);

      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, data };

      const ignore = Array.isArray(check.ignoreKeys) ? check.ignoreKeys : [];
      changedKeys = simpleDiff(prev?.data, data, ignore);
      changed = changedKeys.length > 0;

      await writeJson(latestPath, record);

      // --- append time-series (JSONL) for select check types ---
      try {
        const tsVal = seriesValueFor(check.type, data);
        if (tsVal !== null) {
          const line = JSON.stringify({ t: startedAt, v: tsVal }) + "\n";
          const tsPath = path.join(resultsDir, "timeseries", check.name, "series.jsonl");
          await appendLine(tsPath, line);
        }
      } catch { /* non-fatal */ }

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

  // prune stale latest files that no longer correspond to current checks
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
