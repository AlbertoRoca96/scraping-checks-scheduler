// src/checks.js
// Groups: default, seo, price, compliance

export default [
  // --- Sanity check (kept tiny)
  {
    name: "example_h1",
    type: "page",
    group: "default",
    url: "https://example.com/",
    fields: {
      heading: { selector: "h1", attr: "text" },
      moreInfoLink: { selector: "a[href*='iana.org']", attr: "href" }
    }
  },

  // ======================
  // SEO / Content Ops
  // ======================

  // WordPress sites usually expose /sitemap_index.xml (robots can list exact paths).
  // PlayStation Blog news posts -> detect new URLs (added) / removals.
  {
    name: "playstation_blog_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://blog.playstation.com/sitemap_index.xml", // will fall back to robots if needed
    limit: 800,
    indexLimit: 12
  },

  // Nintendo US News sitemap (explicitly listed in robots.txt -> sitemaps on S3)
  // Robots reference (shows sitemap locations): https://www.nintendo.com/robots.txt
  {
    name: "nintendo_us_news_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://noa-prod-graph-sitemaps.s3.amazonaws.com/nintendo.com/us/news/sitemap.xml",
    limit: 1200
  },

  // ======================
  // Price & Availability (Pokémon demo store)
  // ======================

  // Price watch: Pikachu on a WooCommerce demo shop (intentionally scrape-friendly)
  // CSS is stable: p.price span.woocommerce-Price-amount
  {
    name: "scrapeme_pikachu_price",
    type: "price",
    group: "price",
    url: "https://scrapeme.live/shop/Pikachu/",
    selector: "p.price span.woocommerce-Price-amount"
  },

  // Availability watch: same PDP; "In stock" text under p.stock
  {
    name: "scrapeme_pikachu_availability",
    type: "availability",
    group: "price",
    url: "https://scrapeme.live/shop/Pikachu/",
    selector: "p.stock",
    availableRegex: "in stock"   // case-insensitive
  },

  // ======================
  // Compliance / Market Signals
  // ======================

  // PSA Population Report content hash (alerts when table changes).
  // Example: 1999 Base Set Charizard Holo (PSA page)
  {
    name: "psa_charizard_pop_hash",
    type: "content_watch",
    group: "compliance",
    url: "https://www.psacard.com/Pop/pokemon/pokemon-base-set-1999/charizard-holo/52618",
    selector: "body",
    hashOnly: true,
    // Strip common dynamic noise (dates, commas in big numbers won't matter due to hashing text).
    stripPatterns: [
      "\\bUpdated\\s*\\d{1,2}/\\d{1,2}/\\d{2,4}\\b",
      "\\b\\d{1,2}:\\d{2}\\s*(AM|PM)\\b"
    ]
  },

  // SEC EDGAR: new 8-Ks show up on the company filings list; hashing the list section
  // gives you material-event heads-ups (Item 1.01, 2.02, 5.02, etc.).
  {
    name: "sec_aapl_8k_list_hash",
    type: "content_watch",
    group: "compliance",
    url: "https://www.sec.gov/edgar/browse/?CIK=0000320193&owner=exclude", // Apple Inc
    selector: "body",
    hashOnly: true,
    stripPatterns: [
      // Strip obvious timestamps or pagination counters to reduce noise.
      "\\b\\d{1,2}:\\d{2}:\\d{2}\\b",
      "\\bPage\\s*\\d+\\b"
    ]
  }
];
