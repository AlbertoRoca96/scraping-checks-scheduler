import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { chromium } from "playwright";
import checks from "./checks.js";
import crypto from "crypto";

const root = process.cwd();

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
  // Very basic diff: list changed keys at top level
  const changed = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) changed.push(k);
  }
  return changed;
}

async function runPageCheck(check) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
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
  await browser.close();
  return data;
}

async function runSitemapCheck(check) {
  const res = await fetch(check.url);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();
  // very light parsing: extract <loc>...</loc>
  const urls = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g)).map(m => m[1]);
  const limited = check.limit ? urls.slice(0, check.limit) : urls;
  return { count: limited.length, sample: limited.slice(0, 10), all: limited };
}

async function sendWebhook(payload) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return { sent: false, reason: "no WEBHOOK_URL set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { sent: true, status: res.status };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

async function run() {
  const resultsDir = path.join(root, "data");
  const latestDir = path.join(resultsDir, "latest");
  const historyDir = path.join(resultsDir, "history");
  await Promise.all([ensureDir(latestDir), ensureDir(historyDir)]);

  const summary = [];
  for (const check of checks) {
    const startedAt = new Date().toISOString();
    let data;
    if (check.type === "page") data = await runPageCheck(check);
    else if (check.type === "sitemap") data = await runSitemapCheck(check);
    else throw new Error(`Unknown check type: ${check.type}`);

    const record = {
      name: check.name,
      type: check.type,
      url: check.url,
      checkedAt: startedAt,
      data
    };

    const latestPath = path.join(latestDir, `${check.name}.json`);
    const prev = await readJson(latestPath);
    const changedKeys = simpleDiff(prev?.data, data);
    const changed = changedKeys.length > 0;

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
      webhook = await sendWebhook({
        event: "scrape.changed",
        check: check.name,
        changedKeys,
        current: record,
        previous: prev
      });
    }

    summary.push({ name: check.name, changed, changedKeys, webhook });
    console.log(`[${check.name}] changed=${changed} keys=${changedKeys.join(",")}`);
  }

  await writeJson(path.join(resultsDir, "report.json"), {
    generatedAt: new Date().toISOString(),
    summary
  });

  console.log("\nDone. Summary:\n", JSON.stringify(summary, null, 2));
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
