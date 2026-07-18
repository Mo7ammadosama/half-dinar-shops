import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { MockVisionAnalyzer } from "../src/vision/mock-vision.analyzer";
import { ClaudeVisionAnalyzer } from "../src/vision/claude-vision.analyzer";
import { createVisionAnalyzer } from "../src/vision/vision.module";
import { VisionError } from "../src/vision/vision.types";
import { createTestApp, forceMockVision, REAL_PNG, uniquePhone } from "./helpers";

/**
 * AI product entry from a photograph (8.2a).
 *
 * The point of the feature: a half-dinar shop stocks thousands of items, and
 * typing a name/category/price for each one by hand is why a catalogue never
 * gets finished.
 *
 * HONEST SCOPE: real recognition accuracy cannot be tested here — it needs an
 * Anthropic API key, and "is the model right about this photo?" is not a unit
 * test. What IS tested: the request sent to Claude, that a suggestion can never
 * become a product without the merchant, that the model cannot invent a
 * category or a malformed price, and that a failure degrades to typing rather
 * than a dead end.
 */
describe("AI product entry (8.2a)", () => {
  const CATEGORIES = [
    { id: "cat-drinks", path: "Food & Snacks > Drinks" },
    { id: "cat-biscuits", path: "Food & Snacks > Biscuits & Sweets" },
    { id: "cat-cleaning", path: "Household > Cleaning Supplies" },
  ];

  describe("provider selection", () => {
    const fakeConfig = (values: Record<string, string | undefined>) =>
      ({ get: (key: string) => values[key] }) as never;

    it("uses the mock when no API key is configured, and admits it is not real", () => {
      const analyzer = createVisionAnalyzer(fakeConfig({}));
      expect(analyzer.name).toBe("mock");
      // The dashboard reads this to say "demo mode" rather than implying the
      // photo was genuinely recognised.
      expect(analyzer.isRealAi).toBe(false);
    });

    it("switches to Claude purely by the presence of an API key — no code change", () => {
      const analyzer = createVisionAnalyzer(fakeConfig({ ANTHROPIC_API_KEY: "sk-ant-test" }));
      expect(analyzer.name).toBe("claude");
      expect(analyzer.isRealAi).toBe(true);
    });

    it("refuses VISION_PROVIDER=claude without a key rather than silently faking it", () => {
      expect(() => createVisionAnalyzer(fakeConfig({ VISION_PROVIDER: "claude" }))).toThrow(
        /ANTHROPIC_API_KEY/,
      );
    });

    it("rejects an unknown provider name", () => {
      expect(() => createVisionAnalyzer(fakeConfig({ VISION_PROVIDER: "eyeballs" }))).toThrow(
        /Unknown VISION_PROVIDER/,
      );
    });
  });

  describe("the mock analyzer", () => {
    const mock = new MockVisionAnalyzer();
    const photo = { buffer: REAL_PNG, mimeType: "image/png" };

    it("returns a plausible, shop-shaped suggestion", async () => {
      const s = await mock.suggest(photo, CATEGORIES);
      expect(s.name).toBeTruthy();
      expect(s.provider).toBe("mock");
      expect(s.confidence).toBeGreaterThan(0);
    });

    it("gives the SAME answer for the same photo", async () => {
      // Keyed off the image bytes, not random: a random mock would make the
      // browser tests flaky and make "did my change help?" unanswerable.
      const a = await mock.suggest(photo, CATEGORIES);
      const b = await mock.suggest(photo, CATEGORIES);
      expect(a).toEqual(b);
    });

    it("only ever suggests a category that really exists", async () => {
      const s = await mock.suggest(photo, CATEGORIES);
      if (s.categoryId !== null) {
        expect(CATEGORIES.map((c) => c.id)).toContain(s.categoryId);
      }
    });
  });

  describe("the Claude analyzer", () => {
    const analyzer = () =>
      new ClaudeVisionAnalyzer({ apiKey: "sk-ant-test", model: "claude-opus-4-8", timeoutMs: 5_000 });
    const photo = { buffer: REAL_PNG, mimeType: "image/png" };

    /**
     * Reaches the SDK client to intercept it — no real API call is made.
     *
     * Typed as a plain async function rather than the SDK's full overloaded
     * signature: `create` has several overloads, so `jest.spyOn` infers
     * `never` for the mock value and every mockResolvedValue is a type error.
     */
    const clientOf = (a: ClaudeVisionAnalyzer) =>
      (a as unknown as {
        client: { messages: { create: (...args: unknown[]) => Promise<unknown> } };
      }).client;

    const reply = (body: unknown) => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(body) }],
    });

    afterEach(() => jest.restoreAllMocks());

    it("sends the photo and the shop's real categories to the model", async () => {
      const a = analyzer();
      const create = jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue(
          reply({ name: "Mineral Water 600ml", categoryId: "cat-drinks", price: "0.35", confidence: 0.9 }),
        );

      await a.suggest(photo, CATEGORIES);

      const req = create.mock.calls[0][0] as {
        model: string;
        system: string;
        messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }>;
        output_config: unknown;
      };

      expect(req.model).toBe("claude-opus-4-8");
      // The image really is attached, as base64 of the actual bytes.
      const image = req.messages[0].content.find((c) => c.type === "image");
      expect(image?.source?.data).toBe(REAL_PNG.toString("base64"));
      // Every real category id must be offered, or the model cannot pick one.
      for (const c of CATEGORIES) expect(req.system).toContain(c.id);
      // Structured outputs, so the answer is schema-valid rather than hopeful.
      expect(req.output_config).toBeDefined();
    });

    it("tells the model this is a half-dinar shop, so prices land in the right range", async () => {
      const a = analyzer();
      const create = jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue(reply({ name: "x", categoryId: null, price: null, confidence: 0.5 }));

      await a.suggest(photo, CATEGORIES);

      const req = create.mock.calls[0][0] as { system: string };
      expect(req.system).toMatch(/half-dinar/i);
      expect(req.system).toMatch(/JOD|Jordanian/i);
    });

    it("REJECTS a category the model invented", async () => {
      // Structured outputs guarantee the shape, not the truth — a schema cannot
      // stop the model returning an id that does not exist. Left unchecked it
      // would reach the form as a broken dropdown selection.
      const a = analyzer();
      jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue(
          reply({ name: "Cola", categoryId: "cat-does-not-exist", price: "0.50", confidence: 0.9 }),
        );

      const s = await a.suggest(photo, CATEGORIES);
      expect(s.categoryId).toBeNull();
      // The rest of the suggestion still stands — one bad field is not a reason
      // to throw away a useful name.
      expect(s.name).toBe("Cola");
    });

    it("REJECTS a price that is not exactly 2 decimal places", async () => {
      // Money must be exact. "about 0.5" in a price field would corrupt a real
      // order total later.
      const a = analyzer();
      jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue(
          reply({ name: "Cola", categoryId: "cat-drinks", price: "about 0.5", confidence: 0.9 }),
        );

      const s = await a.suggest(photo, CATEGORIES);
      expect(s.price).toBeNull();
      expect(s.name).toBe("Cola");
    });

    it("clamps a nonsense confidence rather than showing it to a merchant", async () => {
      const a = analyzer();
      jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue(reply({ name: "Cola", categoryId: null, price: null, confidence: 99 }));

      const s = await a.suggest(photo, CATEGORIES);
      expect(s.confidence).toBe(0);
    });

    it("treats a safety refusal as a failure, not a crash", async () => {
      // stop_reason "refusal" returns an EMPTY content array — reading
      // content[0] unconditionally would throw a TypeError here.
      const a = analyzer();
      jest
        .spyOn(clientOf(a).messages, "create")
        .mockResolvedValue({ stop_reason: "refusal", content: [] });

      await expect(a.suggest(photo, CATEGORIES)).rejects.toThrow(VisionError);
    });

    it("reports an API failure rather than hanging", async () => {
      const a = analyzer();
      jest.spyOn(clientOf(a).messages, "create").mockRejectedValue(new Error("ETIMEDOUT"));

      await expect(a.suggest(photo, CATEGORIES)).rejects.toThrow(/Could not reach/);
    });

    it("rejects an image type the model cannot read", async () => {
      const a = analyzer();
      await expect(
        a.suggest({ buffer: REAL_PNG, mimeType: "image/tiff" }, CATEGORIES),
      ).rejects.toThrow(/Unsupported image type/);
    });
  });

  describe("the endpoint", () => {
    let app: INestApplication;
    let http: TestAgent;
    let merchantToken: string;

    beforeAll(async () => {
      // Pin the mock analyzer: this block tests the ENDPOINT's contract (a
      // suggestion is returned, nothing is saved, non-images are rejected), not
      // live Claude. A real ANTHROPIC_API_KEY in .env would otherwise route
      // these to the network and return 503 offline.
      ({ app } = await createTestApp(false, forceMockVision));
      http = request(app.getHttpServer());

      const phone = "0791234567"; // the seeded pilot merchant
      const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });
      merchantToken = verify.body.accessToken;
    });

    afterAll(async () => await app.close());

    it("suggests details from a photo, choosing from the shop's real categories", async () => {
      const res = await http
        .post("/api/products/suggest-from-photo")
        .set("Authorization", `Bearer ${merchantToken}`)
        .attach("file", REAL_PNG, "item.png")
        .expect(201);

      expect(res.body.name).toBeTruthy();
      expect(res.body.confidence).toBeGreaterThan(0);
      expect(res.body.provider).toBe("mock");

      if (res.body.categoryId) {
        // Must be a genuine category from the database, ready for the dropdown.
        const categories = await http
          .get("/api/categories")
          .set("Authorization", `Bearer ${merchantToken}`)
          .expect(200);
        expect(categories.body.map((c: { id: string }) => c.id)).toContain(res.body.categoryId);
      }
    });

    it("SAVES NOTHING — the suggestion is not a product", async () => {
      // The whole safety model: an AI that could write to the catalogue would
      // put its mistakes in front of customers at a real price.
      const before = await http
        .get("/api/products")
        .set("Authorization", `Bearer ${merchantToken}`)
        .expect(200);

      await http
        .post("/api/products/suggest-from-photo")
        .set("Authorization", `Bearer ${merchantToken}`)
        .attach("file", REAL_PNG, "item.png")
        .expect(201);

      const after = await http
        .get("/api/products")
        .set("Authorization", `Bearer ${merchantToken}`)
        .expect(200);

      expect(after.body).toHaveLength(before.body.length);
    });

    it("rejects a non-image disguised with an image filename", async () => {
      // The AI route must not be the weak way past the upload validation — it
      // reuses the same magic-byte check.
      await http
        .post("/api/products/suggest-from-photo")
        .set("Authorization", `Bearer ${merchantToken}`)
        .attach("file", Buffer.from("#!/bin/sh\nrm -rf /"), "innocent.png")
        .expect(400);
    });

    it("refuses a customer", async () => {
      const phone = uniquePhone().replace("+962", "0");
      const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });

      await http
        .post("/api/products/suggest-from-photo")
        .set("Authorization", `Bearer ${verify.body.accessToken}`)
        .attach("file", REAL_PNG, "item.png")
        .expect(403);
    });

    it("refuses an unauthenticated caller", async () => {
      await http
        .post("/api/products/suggest-from-photo")
        .attach("file", REAL_PNG, "item.png")
        .expect(401);
    });
  });
});
