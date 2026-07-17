import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { LocalImageStorage } from "../src/storage/local-image.storage";
import { S3ImageStorage } from "../src/storage/s3-image.storage";
import { createImageStorage } from "../src/storage/storage.module";
import { ImageStorageError } from "../src/storage/storage.types";
import { validateEnv } from "../src/config/env.validation";
import { createTestApp, productionEnv, REAL_PNG, uniquePhone } from "./helpers";

/**
 * Product photo storage (launch blocker B1).
 *
 * B1 is that photos live on local disk and die on redeploy. These tests prove
 * the storage destination is now a config choice, that the bytes genuinely land
 * where they are meant to, and that production refuses to boot on ephemeral
 * storage.
 */
describe("Product photo storage (blocker B1)", () => {
  /**
   * A valid production config, minus object storage — so these tests vary only
   * the thing they are about. See productionEnv() in helpers.ts.
   */
  const withoutObjectStorage = () => {
    const env = productionEnv();
    delete env.S3_BUCKET;
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;
    delete env.S3_PUBLIC_BASE_URL;
    return env;
  };

  describe("provider selection", () => {
    const fakeConfig = (values: Record<string, string | undefined>) =>
      ({ get: (key: string) => values[key] }) as never;

    it("uses local disk when no object-storage credentials are configured", () => {
      const storage = createImageStorage(fakeConfig({}));
      expect(storage.name).toBe("local");
      expect(storage.isDurable).toBe(false);
    });

    // The headline requirement: keys alone flip it live.
    it("switches to object storage purely by the presence of credentials", () => {
      const storage = createImageStorage(
        fakeConfig({
          S3_BUCKET: "photos",
          S3_ACCESS_KEY_ID: "key",
          S3_SECRET_ACCESS_KEY: "secret",
          S3_PUBLIC_BASE_URL: "https://cdn.example.com",
        }),
      );
      expect(storage.name).toBe("s3");
      expect(storage.isDurable).toBe(true);
    });

    it("refuses half-configured object storage rather than silently using disk", () => {
      expect(() =>
        createImageStorage(fakeConfig({ STORAGE_PROVIDER: "s3", S3_BUCKET: "photos" })),
      ).toThrow(/incomplete/i);
    });

    it("rejects an unknown provider name", () => {
      expect(() => createImageStorage(fakeConfig({ STORAGE_PROVIDER: "dropbox" }))).toThrow(
        /Unknown STORAGE_PROVIDER/,
      );
    });
  });

  describe("startup guard", () => {
    it("refuses to boot in production with photos on local disk", () => {
      // This is B1's whole point: without the guard, a production deploy quietly
      // destroys the merchant's photos on the next redeploy.
      expect(() => validateEnv(withoutObjectStorage())).toThrow(/destroyed on redeploy/);
    });

    it("boots in production once object storage is configured", () => {
      expect(() => validateEnv(productionEnv())).not.toThrow();
    });

    it("allows local disk outside production", () => {
      expect(() =>
        validateEnv({ ...withoutObjectStorage(), NODE_ENV: "development" }),
      ).not.toThrow();
    });
  });

  describe("local storage", () => {
    it("writes the real bytes to disk and returns a relative URL", async () => {
      const dir = await mkdtemp(join(tmpdir(), "halfdinar-storage-"));
      const stored = await new LocalImageStorage(dir).store({
        buffer: REAL_PNG,
        ext: "png",
        mimeType: "image/png",
      });

      expect(stored.imageUrl).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);

      // Read it back: proves the file exists with the exact bytes, rather than
      // trusting that a promise resolved.
      const onDisk = await readFile(join(dir, stored.imageUrl.replace("/uploads/", "")));
      expect(onDisk.equals(REAL_PNG)).toBe(true);
    });

    it("never reuses a filename, so two uploads cannot overwrite each other", async () => {
      const dir = await mkdtemp(join(tmpdir(), "halfdinar-storage-"));
      const storage = new LocalImageStorage(dir);
      const image = { buffer: REAL_PNG, ext: "png", mimeType: "image/png" };

      const [a, b] = await Promise.all([storage.store(image), storage.store(image)]);
      expect(a.imageUrl).not.toBe(b.imageUrl);
    });
  });

  describe("S3 storage", () => {
    const config = {
      bucket: "photos",
      region: "auto",
      accessKeyId: "key",
      secretAccessKey: "secret",
      publicBaseUrl: "https://cdn.example.com",
      keyPrefix: "products/",
    };

    afterEach(() => jest.restoreAllMocks());

    /**
     * Reaches the SDK client so it can be intercepted.
     *
     * The S3 client is private; the test needs its `send` to avoid a real
     * network call. Typed narrowly here rather than sprinkling `as never`
     * around, which would switch off the checking that makes these assertions
     * meaningful in the first place.
     */
    const clientOf = (storage: S3ImageStorage) =>
      (storage as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client;

    it("uploads the bytes and returns an absolute public URL", async () => {
      const storage = new S3ImageStorage(config);
      // Intercept at the S3 client boundary — the SDK's own request machinery
      // (signing, serialisation) is not ours to re-test.
      const send = jest.spyOn(clientOf(storage), "send").mockResolvedValue({});

      const stored = await storage.store({
        buffer: REAL_PNG,
        ext: "png",
        mimeType: "image/png",
      });

      expect(stored.imageUrl).toMatch(
        /^https:\/\/cdn\.example\.com\/products\/[0-9a-f-]+\.png$/,
      );

      const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input.Bucket).toBe("photos");
      expect(command.input.ContentType).toBe("image/png");
      expect(command.input.Body).toBe(REAL_PNG);
      // The key must be server-generated and prefixed, never client-influenced.
      expect(String(command.input.Key)).toMatch(/^products\/[0-9a-f-]+\.png$/);
    });

    it("surfaces an upload failure instead of returning a URL to nothing", async () => {
      const storage = new S3ImageStorage(config);
      jest.spyOn(clientOf(storage), "send").mockRejectedValue(new Error("AccessDenied"));

      await expect(
        storage.store({ buffer: REAL_PNG, ext: "png", mimeType: "image/png" }),
      ).rejects.toThrow(ImageStorageError);
    });

    it("does not double-slash when the public base URL has a trailing slash", async () => {
      const storage = new S3ImageStorage({ ...config, publicBaseUrl: "https://cdn.example.com/" });
      jest.spyOn(clientOf(storage), "send").mockResolvedValue({});

      const stored = await storage.store({ buffer: REAL_PNG, ext: "png", mimeType: "image/png" });
      expect(stored.imageUrl).not.toContain("//products");
    });
  });

  describe("the upload endpoint still enforces its rules through the seam", () => {
    let app: INestApplication;
    let http: TestAgent;
    let token: string;

    beforeAll(async () => {
      ({ app } = await createTestApp());
      http = request(app.getHttpServer());

      // Sign in as the seeded pilot merchant.
      const phone = "0791234567";
      const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });
      token = verify.body.accessToken;
    });

    afterAll(async () => await app.close());

    it("stores a real image and returns a usable URL", async () => {
      const res = await http
        .post("/api/uploads/product-image")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", REAL_PNG, "photo.png")
        .expect(201);

      expect(res.body.imageUrl).toBeDefined();
      expect(res.body.mimeType).toBe("image/png");
    });

    it("STILL rejects a non-image disguised with an image filename", async () => {
      // Regression guard: moving storage behind an interface must not have
      // moved the magic-byte check out of the path. This is the security rule
      // from Phase 2 and it has to survive the refactor.
      await http
        .post("/api/uploads/product-image")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("#!/bin/sh\nrm -rf /"), "innocent.png")
        .expect(400);
    });

    it("STILL refuses an upload from a customer", async () => {
      const phone = uniquePhone().replace("+962", "0");
      const req = await http.post("/api/auth/otp/request").send({ phoneNumber: phone });
      const verify = await http
        .post("/api/auth/otp/verify")
        .send({ phoneNumber: phone, code: req.body.devCode });

      await http
        .post("/api/uploads/product-image")
        .set("Authorization", `Bearer ${verify.body.accessToken}`)
        .attach("file", REAL_PNG, "photo.png")
        .expect(403);
    });
  });
});
