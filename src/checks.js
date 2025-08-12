// src/checks.js
// Groups: default | seo | price | compliance
// You can run a single group via matrix GROUP, or run them all locally.

export default [
  // --- sanity check (keeps Playwright honest)
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

  // --- SEO / sitemaps (index + robots discovery + .xml.gz supported)
  {
    name: "govuk_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://www.gov.uk/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },
  {
    name: "nasa_climate_sitemap_diff",
    type: "sitemap_diff",
    group: "seo",
    url: "https://climate.nasa.gov/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },

  // --- Price monitoring (public sandbox built for scraping)
  // Selectors based on BooksToScrape markup: price in "p.price_color",
  // availability in "p.instock.availability".
  {
    name: "toscrape_bane_price",
    type: "price",
    group: "price",
    url: "https://books.toscrape.com/catalogue/the-bane-chronicles-the-bane-chronicles-1-11_746/index.html",
    priceSelector: "p.price_color",
    thresholdPct: 2   // only alert when price moves >= 2%
  },
  {
    name: "toscrape_bane_availability",
    type: "availability",
    group: "price",
    url: "https://books.toscrape.com/catalogue/the-bane-chronicles-the-bane-chronicles-1-11_746/index.html",
    selector: "p.instock.availability"
  },

  // --- Compliance / comms watch (watch section text changes)
  {
    name: "iana_reserved_content",
    type: "content_watch",
    group: "compliance",
    url: "https://www.iana.org/domains/reserved",
    selector: "main",                  // watch the main content area
    // ignore obvious noise patterns if you find them (timestamps etc.)
    ignore: [
      "Last\\s*updated\\s*:\\s*\\w+\\s+\\d{1,2},\\s*\\d{4}"
    ]
  }
];
