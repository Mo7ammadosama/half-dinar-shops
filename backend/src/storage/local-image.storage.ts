import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageStorage, ImageToStore, StoredImage } from "./storage.types";
import { ImageStorageError } from "./storage.types";

/**
 * Local disk storage — the development implementation.
 *
 * This is the behaviour the app has always had, now behind the interface. It
 * reports `isDurable = false` because anything written here dies with the
 * container, and env.validation.ts refuses to boot production on top of it.
 */
@Injectable()
export class LocalImageStorage implements ImageStorage {
  readonly name = "local";
  readonly isDurable = false;

  private readonly logger = new Logger(LocalImageStorage.name);

  constructor(private readonly uploadDir: string) {}

  async store(image: ImageToStore): Promise<StoredImage> {
    try {
      await mkdir(this.uploadDir, { recursive: true });

      // The filename is generated server-side, never taken from the upload, so
      // a crafted name like "../../server.js" cannot escape the directory.
      const filename = `${randomUUID()}.${image.ext}`;
      await writeFile(join(this.uploadDir, filename), image.buffer);

      // Relative on purpose: the API serves these itself at /uploads/<file>,
      // so the URL stays correct across localhost, a LAN IP, and a domain.
      return {
        imageUrl: `/uploads/${filename}`,
        mimeType: image.mimeType,
        bytes: image.buffer.length,
      };
    } catch (cause) {
      throw new ImageStorageError(
        `Could not save the image to disk: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.name,
        cause,
      );
    }
  }
}
