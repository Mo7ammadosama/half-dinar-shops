import { imageSrc } from "../src/api";

/**
 * Pins the relative-vs-absolute photo URL rule (launch blocker B1).
 *
 * `products.image_url` is relative ("/uploads/x.jpg") while photos sit on the
 * API's local disk, and absolute ("https://cdn/x.jpg") once they move to object
 * storage. Both shapes are live: dev uses one, production the other.
 *
 * This test exists because the bug it guards is invisible. Prepending the API
 * base to an absolute URL yields "http://host:3000https://cdn/x.jpg" — no
 * exception, no failed request the app notices, just every product photo
 * quietly not loading on the day storage switches over.
 */
describe("imageSrc", () => {
  it("passes an absolute https URL through untouched", () => {
    const url = "https://pub-abc.r2.dev/products/abc-123.jpg";
    expect(imageSrc(url)).toBe(url);
  });

  it("passes an absolute http URL through untouched", () => {
    const url = "http://cdn.example.com/products/abc-123.jpg";
    expect(imageSrc(url)).toBe(url);
  });

  it("resolves a relative upload path against the API host", () => {
    const resolved = imageSrc("/uploads/abc-123.png");
    expect(resolved).toMatch(/^https?:\/\/.+\/uploads\/abc-123\.png$/);
    // The bug this guards against: the API base concatenated onto a full URL.
    expect(resolved).not.toMatch(/https?:\/\/.*https?:\/\//);
  });

  it("returns undefined when a product has no photo", () => {
    // The common case today — most seeded products have no image and fall back
    // to an emoji placeholder.
    expect(imageSrc(null)).toBeUndefined();
  });
});
