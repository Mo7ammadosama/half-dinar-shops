/**
 * The product-photo storage seam (launch blocker B1).
 *
 * Photos used to be written straight to local disk, which means a container
 * redeploy or a replaced server silently destroys every photo the merchant
 * uploaded — the shop's catalogue quietly loses its pictures and nobody gets an
 * error. Everything that persists an image now goes through this interface, so
 * the destination is a configuration choice.
 */

export interface StoredImage {
  /**
   * What gets written to `products.image_url`.
   *
   * Local storage returns a **relative** path ("/uploads/x.jpg"); object
   * storage returns an **absolute** URL ("https://cdn.../x.jpg"). Clients must
   * handle both — see `imageSrc()` in mobile/src/api.ts and
   * merchant-dashboard/src/api.ts, which pass absolute URLs through untouched.
   */
  imageUrl: string;
  mimeType: string;
  bytes: number;
}

export interface ImageToStore {
  /** Raw bytes, already content-validated by the caller. */
  buffer: Buffer;
  /** File extension without the dot, derived from the real magic bytes. */
  ext: string;
  mimeType: string;
}

/** Thrown when the backing store rejects or cannot accept an upload. */
export class ImageStorageError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ImageStorageError";
  }
}

export interface ImageStorage {
  /** Short name of the implementation, e.g. "local" or "s3". */
  readonly name: string;

  /**
   * True when stored images survive the server being replaced.
   *
   * Local disk returns false. env.validation.ts refuses to boot a production
   * instance backed by ephemeral storage — that is B1's guard.
   */
  readonly isDurable: boolean;

  store(image: ImageToStore): Promise<StoredImage>;
}

/** Injection token — `ImageStorage` is an interface and erased at runtime. */
export const IMAGE_STORAGE = Symbol("IMAGE_STORAGE");
