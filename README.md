Scraping & Checks Scheduler
A “headless Playwright on a cron” that scrapes sources, diffs them, and emits JSON + optional webhooks — all running in GitHub Actions. Data lands in docs/data/ so GitHub Pages can render a live dashboard. 
GitHub

Live dashboard: https://<your-username>.github.io/scraping-checks-scheduler/
(Uses docs/index.html to visualize the latest run + mini sparklines from time-series files.)

What’s included
Check types & groups
default

page – basic DOM extraction (example.com H1 + link)

seo

sitemap_diff – PlayStation Blog, Nintendo US News (detect new/removed URLs)

price

price – numeric price from a CSS selector (demo WooCommerce page)

availability – boolean stock flag via regex match

psa_price_row – PSA price guide: find a row by fuzzy tokens and pull a specific grade column (e.g., GEM-MT 10)

compliance

psa_pop_row – PSA pop report: read TOTAL (or a named column) for a fuzzy-matched row

content_watch – content hash of a page (e.g., SEC EDGAR list); stores a normalized hash only

stocks

stock_quote – Alpha Vantage GLOBAL_QUOTE for a ticker (e.g., NTDOY); stores price + change
Docs for the Quote endpoint (aka function=GLOBAL_QUOTE) and response fields are here. 
Alpha Vantage

Every run writes data/latest/<check>.json. If the payload changed, a copy is also written under data/history/<check>/*.json, and a webhook is posted if WEBHOOK_URL is set. 
GitHub

Time-series
For checks that have a numeric signal (price, availability, psa_price_row, psa_pop_row, stock_quote), the runner also appends
data/timeseries/<check>/series.jsonl with { t, v } points. The dashboard shows tiny sparklines from these files.
