// src/checks.js
export default [
  // --- keep a tiny page check for sanity
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

  // --- GOV.UK sitemap (already working for you)
  {
    name: "govuk_sitemap",
    type: "sitemap",
    group: "default",
    url: "https://www.gov.uk/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },

  // --- NASA Climate site (robots.txt lists these sitemaps)
  {
    name: "nasa_climate_sitemap",
    type: "sitemap",
    group: "a",
    url: "https://climate.nasa.gov/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },

  // --- NASA JPL (robots.txt lists /sitemap.xml)
  {
    name: "nasa_jpl_sitemap",
    type: "sitemap",
    group: "a",
    url: "https://www.jpl.nasa.gov/sitemap.xml",
    limit: 500,
    indexLimit: 8
  }
];
