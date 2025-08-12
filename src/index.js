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
  "Mozilla/5.0 (compatible; ScrapingChecksScheduler/0.3; +https://github.com/)";
const FAIL_ON_ERROR = process.env.FAIL_ON_ERROR === "1";
const GROUP = process.env.GROUP || ""; // run only checks with matching `group`, if set

// ---------- fs helpers ----------
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; } }
async function writeJson(p, obj) { await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

// ---------- diff + normalization ----------
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

// ---------- utility ----------
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

// ---------- page checks ----------
async function runPageCheck(check) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "User-Agent": USER_AGENT });
    page.setDefaultTimeout(20000);

    await withRetry("page.goto", () =>
      page.goto(check.url, { waitUntil: "domcontentloaded" })
    );

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

// ---------- sitemap checks ----------
function looksLikeGzip(buf) { return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b; }

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "*/*" } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

// Safe gunzip: if headers say gzip but body isn't, fall back to plain text.
async function fetchTextMaybeGzip(url) {
  const { res, buf } = await withRetry(`fetch ${url}`, () => fetchBuffer(url));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const ce = (res.headers.get("content-encoding") || "").toLowerCase();
  const gzByType = ct.includes("application/gzip") || ct.includes("x-gzip");
  const gzByEnc = ce.includes("gzip");
  const gzByExt = url.toLowerCase().endsWith(".gz");

  if (gzByType || gzByEnc || gzByExt || looksLikeGzip(buf)) {
    try { return gunzipSync(buf).toString("utf8"); }
    catch { /* fall back */ }
  }
  return buf.toString("utf8");
}

function extractLocsFromXml(xml) {
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const rawLocs = Array.from(xml.matchAll(/<\s*loc\s*>\s*([^<]+)\s*<\s*\/\s*loc\s*>/gi))
    .map(m => m[1].trim());
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

async function runSitemapCheck(check) {
  const tried = new Set();
  const queue = [check.url];
  let firstError = null;
  let triedRobots = false;

  while (queue.length) {
    const url = queue.shift();
    if (tried.has(url)) continue;
    tried.add(url);

    try {
      const xml = await fetchTextMaybeGzip(url);
      const { isIndex, locs } = extractLocsFromXml(xml);

      // Resolve relative children against the current URL
      const resolve = (child) => new URL(child, url).href;

      if (isIndex) {
        const childSitemaps = locs.slice(0, check.indexLimit || 5).map(resolve);
        const all = [];
        for (const sm of childSitemaps) {
          try {
            const childXml = await fetchTextMaybeGzip(sm);
            const child = extractLocsFromXml(childXml);
            if (!child.isIndex) all.push(...child.locs.map(u => resolve(u)));
          } catch { /* ignore bad child and continue */ }
          if (check.limit && all.length >= check.limit) break;
        }
        const limited = check.limit ? all.slice(0, check.limit) : all;
        return { source: url, count: limited.length, sample: limited.slice(0, 10), all: limited };
      }

      // urlset
      if (locs.length > 0) {
        const absolute = locs.map(resolve);
        const limited = check.limit ? absolute.slice(0, check.limit) : absolute;
        return { source: url, count: limited.length, sample: limited.slice(0, 10), all: limited };
      }

      // No locs found: try robots-discovered sitemaps once
      if (!triedRobots) {
        triedRobots = true;
        const discovered = await discoverSitemapsFromRobots(check.url);
        for (const d of discovered) queue.push(d);
      }
    } catch (e) {
      if (!firstError) firstError = e;
      // On fetch/parse failure: try robots-discovered sitemaps once
      if (!triedRobots) {
        triedRobots = true;
        const discovered = await discoverSitemapsFromRobots(check.url);
        for (const d of discovered) queue.push(d);
      }
    }
  }

  const err = firstError ? firstError.message : "Unknown sitemap error";
  throw new Error(`Sitemap fetch failed after trying ${Array.from(tried).join(", ")}: ${err}`);
}

// ---------- webhook ----------
function runUrl() {
  const s = process.env.GITHUB_SERVER_URL;
  const r = process.env.GITHUB_REPOSITORY;
  const id = process.env.GITHUB_RUN_ID;
  if (s && r && id) return `${s}/${r}/actions/runs/${id}`;
  return null;
}
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
        text,               // Slack compatible
        content: text,      // Discord compatible
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

  // optional grouping
  const todo = checks.filter(c => !GROUP || c.group === GROUP);
  const checkNames = new Set(todo.map(c => c.name));

  const summary = [];
  let hadError = false;

  for (const check of todo) {
    const startedAt = new Date().toISOString();
    let record; let changed = false; let changedKeys = [];
    try {
      let data;
      if (check.type === "page") data = await runPageCheck(check);
      else if (check.type === "sitemap") data = await runSitemapCheck(check);
      else throw new Error(`Unknown check type: ${check.type}`);

      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, data };

      const latestPath = path.join(latestDir, `${check.name}.json`);
      const prev = await readJson(latestPath);

      const ignore = Array.isArray(check.ignoreKeys) ? check.ignoreKeys : [];
      changedKeys = simpleDiff(prev?.data, data, ignore);
      changed = changedKeys.length > 0;

      // Always write latest; if changed, also write a history copy
      await writeJson(latestPath, record);
      if (changed) {
        const stamp = startedAt.replace(/[:]/g, "-");
        const histPath = path.join(historyDir, check.name, `${stamp}.json`);
        await writeJson(histPath, record);
        await sendWebhook({ check: check.name, changedKeys, record, previous: prev });
      }

      summary.push({ name: check.name, changed, changedKeys, error: null });
      console.log(`[${check.name}] changed=${changed} keys=${changedKeys.join(",")}`);
    } catch (e) {
      hadError = true;
      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, error: String(e) };
      await writeJson(path.join(latestDir, `${check.name}.json`), record);
      summary.push({ name: check.name, changed: false, changedKeys: [], error: String(e) });
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

  // write machine + human-friendly reports
  await writeJson(path.join(resultsDir, "report.json"), {
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
  await ensureDir(resultsDir);
  await fsp.writeFile(path.join(resultsDir, "report.md"), mdLines.join("\n") + "\n", "utf8");

  console.log("\nDone. Summary:\n", JSON.stringify(summary, null, 2));
  if (hadError && FAIL_ON_ERROR) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
