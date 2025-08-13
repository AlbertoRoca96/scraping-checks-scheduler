// src/checks.js
// Groups: default, seo, price, compliance, stocks

export default [
  // --- sanity
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
  {
    name: "playstation_blog_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://blog.playstation.com/sitemap_index.xml",
    limit: 800,
    indexLimit: 12
  },
  {
    name: "nintendo_us_news_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://noa-prod-graph-sitemaps.s3.amazonaws.com/nintendo.com/us/news/sitemap.xml",
    limit: 1200
  },

  // ======================
  // Demo price & stock
  // ======================
  {
    name: "scrapeme_pikachu_price",
    type: "price",
    group: "price",
    url: "https://scrapeme.live/shop/Pikachu/",
    selector: "p.price span.woocommerce-Price-amount"
  },
  {
    name: "scrapeme_pikachu_availability",
    type: "availability",
    group: "price",
    url: "https://scrapeme.live/shop/Pikachu/",
    selector: "p.stock",
    availableRegex: "in stock"
  },

  // ======================
  // PSA (Charizard, 1999 Pokémon Game)
  // ======================
  {
    name: "psa_charizard_price_gem10",
    type: "psa_price_row",
    group: "price",
    url: "https://www.psacard.com/priceguide/non-sports-tcg-card-values/1999-poke-mon-game/2432",
    rowMatch: "Charizard Holo 1st Edition", // tolerant
    gradeCol: "GEM-MT 10",
    ignoreKeys: ["raw", "mode"]
  },
  {
    name: "psa_charizard_pop_total",
    type: "psa_pop_row",
    group: "compliance",
    url: "https://www.psacard.com/pop/tcg-cards/1999/pokemon-game/57801",
    rowMatch: "Charizard Holo 1st Edition",
    column: "TOTAL",
    ignoreKeys: ["raw", "mode"]
  },

  // ======================
  // SEC signal
  // ======================
  {
    name: "sec_aapl_8k_list_hash",
    type: "content_watch",
    group: "compliance",
    url: "https://www.sec.gov/edgar/browse/?CIK=0000320193&owner=exclude",
    selector: "body",
    hashOnly: true,
    stripPatterns: ["\\b\\d{1,2}:\\d{2}:\\d{2}\\b","\\bPage\\s*\\d+\\b"]
  },

  // ======================
  // Stocks (Alpha Vantage GLOBAL_QUOTE)
  // ======================
  {
    name: "stock_ntdoy_global_quote",
    type: "stock_quote",
    group: "stocks",
    url: "https://www.alphavantage.co/documentation/#latestprice",
    symbol: "NTDOY",
    ignoreKeys: ["raw"]
  }
];
