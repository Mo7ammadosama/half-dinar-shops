import { Logger } from "@nestjs/common";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { ImageStorage, ImageToStore, StoredImage } from "./storage.types";
import { ImageStorageError } from "./storage.types";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Custom endpoint for S3-compatible providers.
   *
   * Cloudflare R2, Backblaze B2, DigitalOcean Spaces and MinIO all speak the S3
   * API at their own hostname. Leave unset for genuine AWS S3.
   */
  endpoint?: string;
  /**
   * Public base URL the stored objects are readable at, e.g.
   * "https://pub-xxxx.r2.dev" or a CDN domain in front of the bucket.
   */
  publicBaseUrl: string;
  /** Key prefix inside the bucket. */
  keyPrefix: string;
}

/**
 * Object storage over the S3 API — the production implementation for B1.
 *
 * Deliberately S3-*compatible* rather than AWS-specific: the same class serves
 * Cloudflare R2, Backblaze B2, Spaces or MinIO by setting `endpoint`. R2 is the
 * recommended default (no egress fees) — see docs/STORAGE_SETUP.md.
 */
export class S3ImageStorage implements ImageStorage {
  readonly name = "s3";
  readonly isDurable = true;

  private readonly logger = new Logger(S3ImageStorage.name);
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  async store(image: ImageToStore): Promise<StoredImage> {
    // Server-generated key: the client never influences where this lands.
    const key = `${this.config.keyPrefix}${randomUUID()}.${image.ext}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: image.buffer,
          ContentType: image.mimeType,
          // Long cache: the key is unique per upload, so a photo at a given URL
          // never changes. Replacing a product photo writes a new key.
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
    } catch (cause) {
      throw new ImageStorageError(
        `Could not upload the image to object storage: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        this.name,
        cause,
      );
    }

    // Absolute URL — the bytes are not served by this API at all.
    const imageUrl = `${this.config.publicBaseUrl.replace(/\/$/, "")}/${key}`;
    this.logger.log(`Stored product image at ${imageUrl}`);

    return { imageUrl, mimeType: image.mimeType, bytes: image.buffer.length };
  }
}
