import {
  BadRequestException,
  Controller,
  Inject,
  Injectable,
  Module,
  Post,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Roles } from "../auth/decorators";
import { IMAGE_STORAGE, ImageStorageError, type ImageStorage } from "../storage/storage.types";

/**
 * Image types we accept, keyed by their file signature ("magic bytes").
 *
 * The browser-supplied mimetype and filename are both attacker-controlled, so
 * neither is trusted. The real file contents decide the type and the extension
 * we save under.
 */
const IMAGE_SIGNATURES: Array<{ ext: string; mime: string; matches: (b: Buffer) => boolean }> = [
  {
    ext: "jpg",
    mime: "image/jpeg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "png",
    mime: "image/png",
    matches: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    ext: "webp",
    mime: "image/webp",
    // "RIFF" .... "WEBP"
    matches: (b) =>
      b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  },
];

@Injectable()
export class UploadsService {
  constructor(@Inject(IMAGE_STORAGE) private readonly storage: ImageStorage) {}

  /**
   * Decides what an uploaded file really is, from its bytes.
   *
   * Exposed so every path that accepts an image — storing it, or sending it to
   * the AI analyzer — runs the SAME check. Duplicating this logic per endpoint
   * is how one of them ends up weaker than the other, and "the AI endpoint"
   * would be an odd but effective way to smuggle a non-image into the system.
   */
  validateImage(file: Express.Multer.File): { ext: string; mime: string } {
    if (!file?.buffer?.length) throw new BadRequestException("No image file was uploaded.");

    const signature = IMAGE_SIGNATURES.find((s) => s.matches(file.buffer));
    if (!signature) {
      throw new BadRequestException("Unsupported image type. Upload a JPEG, PNG, or WebP image.");
    }
    return { ext: signature.ext, mime: signature.mime };
  }

  /**
   * Validates an uploaded image by its contents, then hands it to whichever
   * storage backend is configured (local disk in dev, object storage in
   * production — see src/storage/).
   *
   * Validation deliberately stays here rather than in the storage layer: the
   * rule "only real images, typed by their magic bytes" must hold regardless of
   * where the bytes end up, so no backend can weaken it.
   */
  async storeImage(file: Express.Multer.File) {
    const signature = this.validateImage(file);

    try {
      return await this.storage.store({
        buffer: file.buffer,
        ext: signature.ext,
        mimeType: signature.mime,
      });
    } catch (error) {
      if (error instanceof ImageStorageError) {
        // The merchant must know the photo did not save — otherwise they carry
        // on believing their catalogue has a picture that was never stored.
        throw new ServiceUnavailableException(
          "We could not save that photo right now. Please try again in a moment.",
        );
      }
      throw error;
    }
  }
}

@Roles("MERCHANT")
@Controller("uploads")
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post("product-image")
  @UseInterceptors(
    FileInterceptor("file", {
      // Buffered in memory so the contents can be checked before anything is
      // written to disk — an invalid upload never becomes a file.
      storage: memoryStorage(),
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
        files: 1,
      },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.storeImage(file);
  }
}

@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
  // Exported so the AI product-entry endpoint reuses this exact magic-byte
  // validation rather than growing its own, weaker copy.
  exports: [UploadsService],
})
export class UploadsModule {}
