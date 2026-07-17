import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join } from "node:path";
import { LocalImageStorage } from "./local-image.storage";
import { S3ImageStorage } from "./s3-image.storage";
import { IMAGE_STORAGE, type ImageStorage } from "./storage.types";

/**
 * Chooses where product photos are stored, from configuration alone.
 *
 * Same contract as the SMS seam: pasting S3/R2 credentials into .env switches
 * storage to the cloud with **zero code changes**. `STORAGE_PROVIDER` exists
 * only to force a choice explicitly.
 */
export function createImageStorage(config: ConfigService): ImageStorage {
  const logger = new Logger("StorageModule");

  const explicit = config.get<string>("STORAGE_PROVIDER")?.trim().toLowerCase();
  const bucket = config.get<string>("S3_BUCKET")?.trim();
  const accessKeyId = config.get<string>("S3_ACCESS_KEY_ID")?.trim();
  const secretAccessKey = config.get<string>("S3_SECRET_ACCESS_KEY")?.trim();
  const publicBaseUrl = config.get<string>("S3_PUBLIC_BASE_URL")?.trim();

  const hasS3Credentials = Boolean(bucket && accessKeyId && secretAccessKey && publicBaseUrl);
  const chosen = explicit || (hasS3Credentials ? "s3" : "local");

  if (chosen === "s3") {
    if (!hasS3Credentials) {
      throw new Error(
        "STORAGE_PROVIDER=s3, but the object-storage settings are incomplete. Required: " +
          "S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BASE_URL " +
          "(plus S3_ENDPOINT for non-AWS providers like Cloudflare R2). " +
          "See docs/STORAGE_SETUP.md.",
      );
    }
    const endpoint = config.get<string>("S3_ENDPOINT")?.trim();
    logger.log(`Product photo storage: s3 (bucket ${bucket}${endpoint ? ` at ${endpoint}` : ""})`);

    return new S3ImageStorage({
      bucket: bucket!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      publicBaseUrl: publicBaseUrl!,
      endpoint,
      // R2 ignores region but the SDK requires one; "auto" is R2's convention.
      region: config.get<string>("S3_REGION")?.trim() || "auto",
      keyPrefix: config.get<string>("S3_KEY_PREFIX")?.trim() || "products/",
    });
  }

  if (chosen !== "local") {
    throw new Error(`Unknown STORAGE_PROVIDER "${chosen}". Supported: "local", "s3".`);
  }

  logger.warn(
    "Product photo storage: local disk — photos are LOST on redeploy. Development only. " +
      "See docs/STORAGE_SETUP.md to go live.",
  );
  return new LocalImageStorage(join(process.cwd(), config.get<string>("UPLOAD_DIR") || "uploads"));
}

@Global()
@Module({
  providers: [
    {
      provide: IMAGE_STORAGE,
      inject: [ConfigService],
      useFactory: createImageStorage,
    },
  ],
  exports: [IMAGE_STORAGE],
})
export class StorageModule {}
