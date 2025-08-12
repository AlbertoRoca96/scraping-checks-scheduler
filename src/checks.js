// Each "check" is either a simple page scrape or a sitemap diff.
// Start with two safe demos you can run immediately.

export default [
  {
    name: "example_h1",
    type: "page",
    url: "https://example.com",
    // Grab text from a selector on the page:
    fields: {
      heading: { selector: "h1", attr: "text" } // => "Example Domain"
    }
  },
  {
    name: "python_sitemap",
    type: "sitemap",
    url: "https://www.python.org/sitemap.xml",
    limit: 200 // keep it small for the demo
  }

  // Add your own:
  // {
  //   name: "my_product_price",
  //   type: "page",
  //   url: "https://example.com/product/123",
  //   fields: {
  //     price: { selector: ".product-price", attr: "text" }
  //   }
  // }
];
