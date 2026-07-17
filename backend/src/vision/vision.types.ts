/**
 * The AI product-recognition seam.
 *
 * THE PROBLEM THIS EXISTS FOR: a half-dinar shop stocks *thousands* of items.
 * Typing a name, picking a category and entering a price for each one, by hand,
 * on a laptop, is the single biggest reason a real shopkeeper would give up
 * before finishing their catalogue — and an empty catalogue means an empty app.
 *
 * So: the merchant photographs an item, and the system proposes the name,
 * category and price. **A proposal, never a decision** — the merchant confirms
 * or edits every field before anything is saved. The AI is a typing
 * accelerator, not an authority on what is in the shop.
 */

export interface ProductPhoto {
  buffer: Buffer;
  /** Validated by magic bytes upstream — never the client's claim. */
  mimeType: string;
}

/** A category the shop can actually file a product under. */
export interface CategoryOption {
  id: string;
  /** Full path, e.g. "Food & Snacks > Drinks", so the model can disambiguate. */
  path: string;
}

export interface ProductSuggestion {
  /** Suggested product name, e.g. "Chocolate Bar 30g". */
  name: string;
  /**
   * The id of a category from the supplied list, or null.
   *
   * Constrained to the real list on purpose: a free-text category would have to
   * be reconciled against the master list later, which is exactly the manual
   * work this feature removes.
   */
  categoryId: string | null;
  /** Suggested price in JOD as a fixed-2 string, or null if unsure. */
  price: string | null;
  /**
   * 0..1 — the model's own confidence in the identification.
   *
   * Surfaced to the merchant so a wild guess looks like a wild guess. A
   * confident wrong answer is worse than an honest "not sure".
   */
  confidence: number;
  /** Which implementation produced this. Shown in the dashboard. */
  provider: string;
}

/** Thrown when the provider cannot produce a suggestion. */
export class VisionError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VisionError";
  }
}

export interface ProductVisionAnalyzer {
  readonly name: string;
  /** False for the mock — the dashboard says so rather than implying magic. */
  readonly isRealAi: boolean;

  suggest(photo: ProductPhoto, categories: CategoryOption[]): Promise<ProductSuggestion>;
}

/** Injection token — the interface is erased at runtime. */
export const VISION_ANALYZER = Symbol("VISION_ANALYZER");
