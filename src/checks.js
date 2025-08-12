// src/checks.js
// Each item defines a "check" to run.
// - type: "page"     -> Playwright loads a page and extracts fields
// - type: "sitemap"  -> Fetches sitemap (supports index + .gz)
// Optional per-check keys you can use now or later:
//   group: "a" | "b" | "c" | "default"  -> run subsets via the GROUP env
//   ignoreKeys: ["fieldName"]           -> exclude volatile fields from diffs

export default [
  {
    name: "example_h1",
    type: "page",
    group: "default",
    url: "https://example.com/",
    fields: {
      heading: { selector: "h1", attr: "text" },           // "Example Domain"
      moreInfoLink: { selector: "a[href*='iana.org']", attr: "href" }
    },
    // ignoreKeys: ["someVolatileField"]
  },

  {
    name: "govuk_sitemap",
    type: "sitemap",
    group: "default",
    // GOV.UK sitemap index (stable; refreshed regularly)
    url: "https://www.gov.uk/sitemap.xml",
    limit: 500,     // keep artifacts small; raise if you want more URLs
    indexLimit: 8    // how many child sitemaps to scan if it's an index
  }

  // Example to add later (price):
  // {
  //   name: "my_price",
  //   type: "page",
  //   group: "a",
  //   url: "https://example.com/product/sku123",
  //   fields: {
  //     title: { selector: "h1.product-title", attr: "text" },
  //     price: { selector: ".price .amount", attr: "text" }
  //   },
  //   ignoreKeys: [] // e.g., ["last_updated"]
  // }
];
