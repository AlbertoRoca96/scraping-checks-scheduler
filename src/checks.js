// src/checks.js
export default [
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

  {
    name: "govuk_sitemap",
    type: "sitemap",
    group: "default",
    url: "https://www.gov.uk/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },

  {
    name: "nasa_climate_sitemap",
    type: "sitemap",
    group: "default",
    url: "https://climate.nasa.gov/sitemap.xml",
    limit: 500,
    indexLimit: 8
  },

  {
    name: "nasa_jpl_sitemap",
    type: "sitemap",
    group: "default",
    url: "https://www.jpl.nasa.gov/sitemap.xml",
    limit: 500,
    indexLimit: 8
  }
];
