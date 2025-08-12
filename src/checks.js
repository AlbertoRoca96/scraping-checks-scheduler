// src/checks.js
// Groups: default, seo, price, compliance

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

  // PRICE: take “GEM-MT 10” column from the row that contains “Charizard - Holo-1st Edition”
  // (Columns on that page include NM 7, NM-MT 8, MT 9, GEM-MT 10. The Charizard row exists.) :contentReference[oaicite:0]{index=0}
  {
    name: "psa_charizard_price_gem10",
    type: "psa_price_row",
    group: "price",
    url: "https://www.psacard.com/priceguide/non-sports-tcg-card-values/1999-poke-mon-game/2432",
    rowMatch: "Charizard - Holo-1st Edition",
    gradeCol: "GEM-MT 10"
  },

  // POPULATION: read the “TOTAL” column from the “Charizard - Holo-1st Edition” row
  // on the Pop Report set page. (This page lists set rows by card with grade columns + TOTAL.) :contentReference[oaicite:1]{index=1}
  {
    name: "psa_charizard_pop_total",
    type: "psa_pop_row",
    group: "compliance",
    url: "https://www.psacard.com/pop/tcg-cards/1999/pokemon-game/57801",
    rowMatch: "Charizard - Holo-1st Edition",  // case-insensitive substring match
    column: "TOTAL"                             // which Pop column to record
  },

  // SEC signal (unchanged)
  {
    name: "sec_aapl_8k_list_hash",
    type: "content_watch",
    group: "compliance",
    url: "https://www.sec.gov/edgar/browse/?CIK=0000320193&owner=exclude",
    selector: "body",
    hashOnly: true,
    stripPatterns: ["\\b\\d{1,2}:\\d{2}:\\d{2}\\b","\\bPage\\s*\\d+\\b"]
  }
];
