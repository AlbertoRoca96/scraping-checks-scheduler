import { promises as fsp } from "fs";
import path from "path";
import { chromium } from "playwright";
import checks from "./checks.js";
import crypto from "crypto";
import { gunzipSync } from "zlib";
import { URL } from "url";

const root = process.cwd();
const USER_AGENT =
  "Mozilla/5.0 (compatible; ScrapingChecksScheduler/0.1; +https://github.com/)";
const FAIL_ON_ERROR = process.env.FAIL_ON_ERROR === "1";

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}
async function readJson(p) {
  try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; }
}
async function writeJson(p, obj) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function sha(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
function simpleDiff(a, b) {
  const changed = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) changed.push(k);
  }
  return changed;
}

async function runPageCheck(check) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "User-Agent": USER_AGENT });
    await page.goto(check.url, { waitUntil: "domcontentloaded" });
    const data = {};
    for (const [key, spec] of Object.entries(check.fields)) {
      const { selector, attr = "text" } = spec;
      await page.waitForSelector(selector, { timeout: 15000 });
      if (attr === "text") {
        data[key] = (await page.textContent(selector))?.trim() ?? null;
      } else {
        data[key] = await page.getAttribute(selector, attr);
      }
    }
    return data;
  } finally {
    await browser.close();
  }
}

// --- Sitemap helpers --------------------------------------------------------

function looksLikeGzip(buf) {
  return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "*/*" }
  });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

async function fetchTextMaybeGzip(url) {
  const { res, buf } = await fetchBuffer(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const ce = (res.headers.get("content-encoding") || "").toLowerCase();
  const gzByType = ct.includes("application/gzip") || ct.includes("x-gzip");
  const gzByEnc = ce.includes("gzip");
  const gzByExt = url.toLowerCase().endsWith(".gz");
  if (gzByType || gzByEnc || gzByExt || looksLikeGzip(buf)) {
    return gunzipSync(buf).toString("utf8");
  }
  return buf.toString("utf8");
}

function extractLocsFromXml(xml) {
  // Very simple, works for standard sitemap XML.
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const locs = Array.from(xml.matchAll(/<\s*loc\s*>\s*([^<]+)\s*<\s*\/\s*loc\s*>/gi))
    .map(m => m[1].trim());
  return { isIndex, locs };
}

async function discoverSitemapsFromRobots(startUrl) {
  // Look at robots.txt for "Sitemap: ..." entries (standard practice).
  // https://docs.python.org/robots.txt shows a "Sitemap:" example. :contentReference[oaicite:2]{index=2}
  const u = new URL(startUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  try {
    const text = await fetchTextMaybeGzip(robotsUrl);
    const matches = Array.from(text.matchAll(/(?<=^|\n)\s*Sitemap:\s*(\S+)\s*/gi))
      .map(m => m[1]);
    return matches;
  } catch {
    return [];
  }
}

async function runSitemapCheck(check) {
  // Try the given URL first. If it fails, try robots.txt discovery.
  const tried = [];
  const urlsToTry = [check.url];

  // If caller provided a domain root or a known-bad path and it fails, we'll
  // append robots-discovered sitemaps below.
  let firstError = null;

  while (urlsToTry.length) {
    const url = urlsToTry.shift();
    tried.push(url);
    try {
      const xml = await fetchTextMaybeGzip(url);
      const { isIndex, locs } = extractLocsFromXml(xml);

      // If it's a sitemap index, fetch child sitemaps and aggregate URLs.
      if (isIndex) {
        const childSitemaps = locs.slice(0, check.indexLimit || 5); // keep light
        const all = [];
        for (const sm of childSitemaps) {
          try {
            const childXml = await fetchTextMaybeGzip(sm);
            const child = extractLocsFromXml(childXml);
            // child of index can be urlset or nested index (rare). Handle urlset.
            if (!child.isIndex) all.push(...child.locs);
          } catch (e) {
            // Skip bad child; continue.
          }
          if (check.limit && all.length >= check.limit) break;
        }
        const limited = check.limit ? all.slice(0, check.limit) : all;
        return { source: url, count: limited.length, sample: limited.slice(0, 10), all: limited };
      }

      // Normal urlset: locs are URLs.
      const limited = check.limit ? locs.slice(0, check.limit) : locs;
      return { source: url, count: limited.length, sample: limited.slice(0, 10), all: limited };
    } catch (e) {
      if (!firstError) firstError = e;
      // If we just tried the original URL, attempt robots.txt discovery once.
      if (urlsToTry.length === 0 && tried.length === 1) {
        const discovered = await discoverSitemapsFromRobots(check.url);
        for (const d of discovered) urlsToTry.push(d);
      }
    }
  }

  // If we reached here, everything failed.
  const err = firstError ? firstError.message : "Unknown sitemap error";
  throw new Error(`Sitemap fetch failed after trying ${tried.join(", ")}: ${err}`);
}

// --- Main runner ------------------------------------------------------------

async function run() {
  const resultsDir = path.join(root, "data");
  const latestDir = path.join(resultsDir, "latest");
  const historyDir = path.join(resultsDir, "history");
  await Promise.all([ensureDir(latestDir), ensureDir(historyDir)]);

  const summary = [];
  let hadError = false;

  for (const check of checks) {
    const startedAt = new Date().toISOString();
    let record;
    let changed = false;
    let changedKeys = [];
    try {
      let data;
      if (check.type === "page") data = await runPageCheck(check);
      else if (check.type === "sitemap") data = await runSitemapCheck(check);
      else throw new Error(`Unknown check type: ${check.type}`);

      record = {
        name: check.name,
        type: check.type,
        url: check.url,
        checkedAt: startedAt,
        data
      };

      const latestPath = path.join(latestDir, `${check.name}.json`);
      const prev = await readJson(latestPath);
      changedKeys = simpleDiff(prev?.data, data);
      changed = changedKeys.length > 0;

      // Always write latest; if changed, also write a history copy
      await writeJson(latestPath, record);
      if (changed) {
        const stamp = startedAt.replace(/[:]/g, "-");
        const histPath = path.join(historyDir, check.name, `${stamp}.json`);
        await writeJson(histPath, record);
      }

      // Optional webhook on change
      let webhook = null;
      if (changed) {
        const url = process.env.WEBHOOK_URL;
        if (url) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                event: "scrape.changed",
                check: check.name,
                changedKeys,
                current: record,
                previous: await readJson(path.join(latestDir, `${check.name}.json`))
              })
            });
            webhook = { sent: true, status: res.status };
          } catch (e) {
            webhook = { sent: false, error: String(e) };
          }
        } else {
          webhook = { sent: false, reason: "no WEBHOOK_URL set" };
        }
      }

      summary.push({ name: check.name, changed, changedKeys, error: null });
      console.log(`[${check.name}] changed=${changed} keys=${changedKeys.join(",")}`);
    } catch (e) {
      hadError = true;
      record = {
        name: check.name,
        type: check.type,
        url: check.url,
        checkedAt: startedAt,
        error: String(e)
      };
      // still publish an error record so you can see failures per-check
      await writeJson(path.join(latestDir, `${check.name}.json`), record);
      summary.push({ name: check.name, changed: false, changedKeys: [], error: String(e) });
      console.error(`[${check.name}] ERROR: ${String(e)}`);
    }
  }

  await writeJson(path.join(resultsDir, "report.json"), {
    generatedAt: new Date().toISOString(),
    summary
  });

  console.log("\nDone. Summary:\n", JSON.stringify(summary, null, 2));

  if (hadError && FAIL_ON_ERROR) {
    process.exit(1);
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
