// src/checks.js
// Two example checks:
// 1) A simple page scrape (stable, fast) to prove Playwright is working.
// 2) A sitemap scrape against GOV.UK's official sitemap index.

export default [
  {
    name: "example_h1",
    type: "page",
    url: "https://example.com/",
    fields: {
      heading: { selector: "h1", attr: "text" }, // -> "Example Domain"
      moreInfoLink: { selector: "a[href*='iana.org']", attr: "href" }
    }
  },

  {
    name: "govuk_sitemap",
    type: "sitemap",
    // GOV.UK’s official sitemap index; it links to ~30 sub-sitemaps.
    // This URL is stable and updated via a daily cron job.
    url: "https://www.gov.uk/sitemap.xml",
    limit: 500 // keep runs snappy; bump if you want more
  }
];
