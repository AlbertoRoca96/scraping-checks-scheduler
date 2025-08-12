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

// ---------- small utils ----------
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
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

function runUrl() {
  const s = process.env.GITHUB_SERVER_URL;
  const r = process.env.GITHUB_REPOSITORY;
  const id = process.env.GITHUB_RUN_ID;
  if (s && r && id) return `${s}/${r}/actions/runs/${id}`;
  return null;
}

// ---------- Playwright page loader ----------
async function loadPage(url, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "User-Agent": USER_AGENT });
    page.setDefaultTimeout(20000);
    await withRetry("page.goto", () => page.goto(url, { waitUntil: "domcontentloaded" }));
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// ---------- Check Runners ----------

// type: "page"
async function runPageCheck(check) {
  return loadPage(check.url, async (page) => {
    const data = {};
    for (const [key, spec] of Object.entries(check.fields)) {
      const { selector, attr = "text" } = spec;
      await page.waitForSelector(selector);
      data[key] = attr === "text"
        ? (await page.textContent(selector))?.trim() ?? null
        : await page.getAttribute(selector, attr);
    }
    return data;
  });
}

// type: "price"
async function runPriceCheck(check) {
  return loadPage(check.url, async (page) => {
    await page.waitForSelector(check.priceSelector);
    const raw = (await page.textContent(check.priceSelector))?.trim() ?? "";
    const num = Number(raw.replace(/[^0-9.\-]/g, ""));
    return { price: Number.isFinite(num) ? num : null, raw };
  });
}

// type: "availability"
async function runAvailabilityCheck(check) {
  return loadPage(check.url, async (page) => {
    await page.waitForSelector(check.selector);
    const raw = (await page.textContent(check.selector))?.trim() ?? "";
    const available = /in\s*stock/i.test(raw);
    return { available, raw };
  });
}

// Sitemap helpers
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
async function resolveSitemap(url, check) {
  const tried = new Set();
  const queue = [url];
  let firstError = null;
  let triedRobots = false;

  while (queue.length) {
    const cur = queue.shift();
    if (tried.has(cur)) continue;
    tried.add(cur);
    try {
      const xml = await fetchTextMaybeGzip(cur);
      const { isIndex, locs } = extractLocsFromXml(xml);
      const resolve = (child) => new URL(child, cur).href;

      if (isIndex) {
        const childSitemaps = locs.slice(0, check.indexLimit || 5).map(resolve);
        const all = [];
        for (const sm of childSitemaps) {
          try {
            const childXml = await fetchTextMaybeGzip(sm);
            const child = extractLocsFromXml(childXml);
            if (!child.isIndex) all.push(...child.locs.map(u => resolve(u)));
          } catch { /* skip child */ }
          if (check.limit && all.length >= check.limit) break;
        }
        const limited = check.limit ? all.slice(0, check.limit) : all;
        return { source: cur, urls: limited };
      }

      if (locs.length > 0) {
        const absolute = locs.map(resolve);
        const limited = check.limit ? absolute.slice(0, check.limit) : absolute;
        return { source: cur, urls: limited };
      }

      if (!triedRobots) {
        triedRobots = true;
        const discovered = await discoverSitemapsFromRobots(url);
        for (const d of discovered) queue.push(d);
      }
    } catch (e) {
      if (!firstError) firstError = e;
      if (!triedRobots) {
        triedRobots = true;
        const discovered = await discoverSitemapsFromRobots(url);
        for (const d of discovered) queue.push(d);
      }
    }
  }
  const err = firstError ? firstError.message : "Unknown sitemap error";
  throw new Error(`Sitemap fetch failed after trying ${Array.from(tried).join(", ")}: ${err}`);
}

// type: "sitemap" or "sitemap_diff"
async function runSitemap(check) {
  const out = await resolveSitemap(check.url, check);
  return { source: out.source, count: out.urls.length, sample: out.urls.slice(0, 10), all: out.urls };
}

// type: "content_watch"
async function runContentWatch(check) {
  return loadPage(check.url, async (page) => {
    let text;
    if (check.selector) {
      await page.waitForSelector(check.selector);
      text = (await page.textContent(check.selector)) ?? "";
    } else {
      text = await page.content(); // full HTML
    }
    const ignore = Array.isArray(check.ignore) ? check.ignore : [];
    const sanitized = ignore.reduce((acc, pattern) => acc.replace(new RegExp(pattern, "gi"), ""), text);
    return {
      selector: check.selector || "FULL_PAGE",
      textSample: sanitized.trim().slice(0, 400),
      hash: sha256(sanitized)
    };
  });
}

// change logic per type
function priceChange(prev, cur, thresholdPct = 1) {
  const a = prev?.price, b = cur?.price;
  if (typeof a === "number" && typeof b === "number") {
    const pct = ((b - a) / (a === 0 ? 1 : a)) * 100;
    const changed = Math.abs(pct) >= thresholdPct;
    return { changed, changedKeys: changed ? ["price", "pct"] : [], pct };
  }
  return { changed: true, changedKeys: ["price"], pct: null };
}
function availabilityChange(prev, cur) {
  const changed = prev?.available !== cur?.available;
  return { changed, changedKeys: changed ? ["available"] : [] };
}
function sitemapChange(prev, cur) {
  const prevSet = new Set(prev?.all || []);
  const curSet = new Set(cur?.all || []);
  const added = [...curSet].filter(u => !prevSet.has(u));
  const removed = [...prevSet].filter(u => !curSet.has(u));
  const changed = added.length > 0 || removed.length > 0;
  const data = { ...cur, added, removed, addedCount: added.length, removedCount: removed.length };
  return { changed, changedKeys: changed ? ["added", "removed"] : [], data };
}
function contentChange(prev, cur) {
  const changed = prev?.hash !== cur?.hash;
  return { changed, changedKeys: changed ? ["hash"] : [] };
}

// webhook
async function sendWebhook({ check, changedKeys, record, previous, extraText }) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return { sent: false, reason: "no WEBHOOK_URL set" };
  const link = runUrl();
  const lines = [
    changedKeys.length ? `✅ **${check}** changed (${changedKeys.join(", ")})` : `ℹ️ **${check}** ran with no changes`,
    extraText ? extraText : null,
    link ? `Run: ${link}` : null
  ].filter(Boolean);
  const text = lines.join("\n");

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

// HTML report helper
function renderHtml(summary, group) {
  const rows = summary.map(s => `
    <tr>
      <td><code>${s.name}</code></td>
      <td style="text-align:center;">${s.changed ? "✅" : "—"}</td>
      <td>${(s.changedKeys || []).join(", ")}</td>
      <td>${s.error ? `<code>${s.error}</code>` : ""}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>Scrape Report (${group || "all"})</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color:#111;}
  table { border-collapse: collapse; width: 100%; }
  th, td { border:1px solid #ddd; padding:8px; }
  th { background:#f7f7f7; text-align:left; }
  code { background:#f0f0f0; padding:1px 4px; border-radius:4px; }
</style>
<h1>Scrape Report — ${group || "all"}</h1>
<p>Generated: ${new Date().toISOString()} ${runUrl() ? `| <a href="${runUrl()}">Run</a>` : ""}</p>
<table>
  <thead><tr><th>Check</th><th>Changed</th><th>Keys</th><th>Error</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>Raw JSON in <code>data/latest/</code>.</p>
</html>`;
}

// ---------- main ----------
async function run() {
  const resultsDir = path.join(root, "data");
  const latestDir = path.join(resultsDir, "latest");
  const historyDir = path.join(resultsDir, "history");
  const reportsDir = path.join(resultsDir, "reports");
  await Promise.all([ensureDir(latestDir), ensureDir(historyDir), ensureDir(reportsDir)]);

  // plan: run current group only
  const todo = checks.filter(c => !GROUP || c.group === GROUP);
  // for pruning, consider ALL check names (not just group)
  const allCheckNames = new Set(checks.map(c => c.name));

  const summary = [];
  let hadError = false;

  for (const check of todo) {
    const startedAt = new Date().toISOString();
    let record; let changed = false; let changedKeys = [];
    try {
      let data;
      let extraText = null;

      if (check.type === "page") data = await runPageCheck(check);
      else if (check.type === "price") data = await runPriceCheck(check);
      else if (check.type === "availability") data = await runAvailabilityCheck(check);
      else if (check.type === "content_watch") data = await runContentWatch(check);
      else if (check.type === "sitemap" || check.type === "sitemap_diff") data = await runSitemap(check);
      else throw new Error(`Unknown check type: ${check.type}`);

      record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, data };

      const latestPath = path.join(latestDir, `${check.name}.json`);
      const prev = await readJson(latestPath);

      // decide change type
      if (check.type === "price") {
        const { changed: ch, changedKeys: ck, pct } =
          priceChange(prev?.data, data, check.thresholdPct ?? 1);
        changed = ch; changedKeys = ck;
        if (pct !== null) extraText = `Price move: ${pct.toFixed(2)}%`;
      } else if (check.type === "availability") {
        const t = availabilityChange(prev?.data, data);
        changed = t.changed; changedKeys = t.changedKeys;
      } else if (check.type === "content_watch") {
        const t = contentChange(prev?.data, data);
        changed = t.changed; changedKeys = t.changedKeys;
      } else if (check.type === "sitemap" || check.type === "sitemap_diff") {
        const t = sitemapChange(prev?.data, data);
        changed = t.changed; changedKeys = t.changedKeys; record.data = t.data;
      } else {
        const ignore = Array.isArray(check.ignoreKeys) ? check.ignoreKeys : [];
        changedKeys = simpleDiff(prev?.data, data, ignore);
        changed = changedKeys.length > 0;
      }

      await writeJson(latestPath, record);
      if (changed) {
        const stamp = startedAt.replace(/[:]/g, "-");
        const histPath = path.join(historyDir, check.name, `${stamp}.json`);
        await writeJson(histPath, record);
        await sendWebhook({ check: check.name, changedKeys, record, previous: prev, extraText });
      }

      summary.push({ name: check.name, changed, changedKeys, error: null });
      console.log(`[${check.name}] changed=${changed} keys=${changedKeys.join(",")}`);
    } catch (e) {
      hadError = true;
      const record = { name: check.name, type: check.type, url: check.url, checkedAt: startedAt, error: String(e) };
      await writeJson(path.join(latestDir, `${check.name}.json`), record);
      summary.push({ name: check.name, changed: false, changedKeys: [], error: String(e) });
      console.error(`[${check.name}] ERROR: ${String(e)}`);
    }
  }

  // prune stale latest files that are not part of ANY check (any group)
  try {
    const files = await fsp.readdir(latestDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const name = f.replace(/\.json$/, "");
      if (!allCheckNames.has(name)) {
        await fsp.unlink(path.join(latestDir, f));
        console.log(`[prune] removed stale ${f}`);
      }
    }
  } catch (e) {
    console.warn(`[prune] warning: ${String(e)}`);
  }

  // Per-group reports
  const groupKey = (GROUP || "all").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  await writeJson(path.join(reportsDir, `report-${groupKey}.json`), {
    generatedAt: new Date().toISOString(),
    group: GROUP || "all",
    summary
  });

  const mdLines = [
    `| Check | Changed | Keys | Error |`,
    `|---|:---:|:--|:--|`,
    ...summary.map(s => `| \`${s.name}\` | ${s.changed ? "✅" : "—"} | ${s.changedKeys.join(", ")} | ${s.error ? "`" + s.error + "`" : ""} |`)
  ];
  await fsp.writeFile(path.join(reportsDir, `report-${groupKey}.md`), mdLines.join("\n") + "\n", "utf8");
  await fsp.writeFile(path.join(reportsDir, `report-${groupKey}.html`), renderHtml(summary, GROUP), "utf8");

  console.log("\nDone. Summary:\n", JSON.stringify(summary, null, 2));
  if (hadError && FAIL_ON_ERROR) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
