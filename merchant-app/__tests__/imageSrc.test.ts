/**
 * imageSrc must leave an absolute URL untouched and only prefix a relative path.
 *
 * The trap this guards (shared with both other clients): prepending the API base
 * to an already-absolute cloud URL yields "http://host...https://cdn/x.jpg" and
 * silently breaks every product photo the day storage moves off local disk.
 */
import { API_BASE, imageSrc } from "../src/api";

describe("imageSrc", () => {
  it("returns undefined for a null path", () => {
    expect(imageSrc(null)).toBeUndefined();
  });

  it("prefixes the API host onto a relative upload path", () => {
    const host = API_BASE.replace(/\/api$/, "");
    expect(imageSrc("/uploads/x.jpg")).toBe(`${host}/uploads/x.jpg`);
  });

  it("leaves an absolute cloud URL untouched", () => {
    expect(imageSrc("https://cdn.example.com/x.jpg")).toBe("https://cdn.example.com/x.jpg");
    expect(imageSrc("http://cdn.example.com/y.png")).toBe("http://cdn.example.com/y.png");
  });
});
