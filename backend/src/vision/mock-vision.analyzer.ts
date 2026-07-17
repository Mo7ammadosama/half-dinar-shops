import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import type {
  CategoryOption,
  ProductPhoto,
  ProductSuggestion,
  ProductVisionAnalyzer,
} from "./vision.types";

/**
 * Canned suggestions, drawn from what a half-dinar shop actually stocks.
 *
 * Real-looking rather than "Lorem Ipsum 1" so the founder can judge the
 * *workflow* — photograph, glance at the fields, correct one, save — which is
 * the thing being evaluated. Nonsense text would make the flow feel fake and
 * hide whether the confirm-and-edit step is fast enough.
 */
const CANNED: ReadonlyArray<{ name: string; categoryHint: string; price: string; confidence: number }> = [
  { name: "Chocolate Bar 30g", categoryHint: "Biscuits", price: "0.50", confidence: 0.94 },
  { name: "Mineral Water 600ml", categoryHint: "Drinks", price: "0.35", confidence: 0.97 },
  { name: "Bar Soap 100g", categoryHint: "Personal", price: "0.50", confidence: 0.91 },
  { name: "Dish Sponge (2 pcs)", categoryHint: "Cleaning", price: "0.50", confidence: 0.88 },
  { name: "Ballpoint Pen (Blue)", categoryHint: "Stationery", price: "0.20", confidence: 0.86 },
  { name: "Paper Tissues Pack", categoryHint: "Personal", price: "0.25", confidence: 0.9 },
  { name: "Aluminium Foil Roll", categoryHint: "Kitchen", price: "0.90", confidence: 0.83 },
  // Deliberately low confidence: the merchant must see what an unsure
  // suggestion looks like, because that is when the UI has to earn its keep.
  { name: "Unidentified item", categoryHint: "", price: "", confidence: 0.21 },
];

/**
 * Development analyzer: returns a plausible suggestion without calling any API.
 *
 * Keeps the whole feature — endpoint, dashboard, tests — working with no
 * Anthropic account, and reports `isRealAi = false` so the dashboard can say so
 * rather than implying a real identification happened.
 */
@Injectable()
export class MockVisionAnalyzer implements ProductVisionAnalyzer {
  readonly name = "mock";
  readonly isRealAi = false;

  private readonly logger = new Logger(MockVisionAnalyzer.name);

  async suggest(photo: ProductPhoto, categories: CategoryOption[]): Promise<ProductSuggestion> {
    // Keyed off the image bytes so the same photo always yields the same
    // suggestion. A random pick would make the browser tests flaky and make
    // manual comparison ("did my change help?") impossible.
    const digest = createHash("sha256").update(photo.buffer).digest();
    const pick = CANNED[digest[0] % CANNED.length];

    // Resolve the hint against the shop's REAL categories, so the mock exercises
    // the same "must be a real category id" path as the live analyzer.
    const category =
      pick.categoryHint === ""
        ? null
        : (categories.find((c) => c.path.toLowerCase().includes(pick.categoryHint.toLowerCase())) ??
          null);

    this.logger.log(`Mock vision suggestion: ${pick.name} (no AI call made)`);

    return {
      name: pick.name,
      categoryId: category?.id ?? null,
      price: pick.price || null,
      confidence: pick.confidence,
      provider: this.name,
    };
  }
}
