# Scraping & Checks Scheduler

A “headless Playwright on a cron” that scrapes sources, diffs them, and emits JSON + optional webhooks. Runs entirely in **GitHub Actions**.

## What’s included

- **SEO/content ops**: `sitemap_diff` for PlayStation Blog and Nintendo US News (detect newly published pages).  
- **Price/stock**: `price` + `availability` for a Pokémon PDP on a demo WooCommerce store.  
- **Compliance/signals**: `content_watch` for **PSA pop** page and **SEC EDGAR 8-K** (hashes list page).

## How it works

- Each check writes `data/latest/<check>.json`. If the payload changed, it also writes a versioned file under `data/history/<check>/...json` and posts a webhook (if `WEBHOOK_URL` set).
- The workflow runs 4 groups in parallel, uploads their `data/` dirs as artifacts, then a final job merges and commits.

## Setup

1) Fork/clone → push.  
2) (Optional) Add **WEBHOOK_URL** (Slack/Discord) to: **Settings → Secrets and variables → Actions → New repository secret**.  
3) Run manually: **Actions → Scraping & Checks Scheduler → Run workflow**.

## Add your own checks

Edit `src/checks.js`. Available `type`s: `page`, `price`, `availability`, `sitemap`, `sitemap_diff`, `content_watch`.

