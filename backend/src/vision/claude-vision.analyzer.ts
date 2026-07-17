import { Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import type {
  CategoryOption,
  ProductPhoto,
  ProductSuggestion,
  ProductVisionAnalyzer,
} from "./vision.types";
import { VisionError } from "./vision.types";

export interface ClaudeVisionConfig {
  apiKey: string;
  /** Model id. Configurable so the founder can trade cost against accuracy. */
  model: string;
  timeoutMs: number;
}

/** Image types Claude's vision accepts. Matches the upload validator. */
const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * The JSON shape the model must return.
 *
 * Used with structured outputs, so the response is schema-valid rather than
 * "usually valid JSON we hope parses" — the merchant is standing at a counter
 * waiting, and a parse error would be a dead end.
 */
const SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Short product name as it would appear on a shop shelf label, including " +
        "size/weight if visible, e.g. 'Chocolate Bar 30g'. English.",
    },
    categoryId: {
      type: ["string", "null"],
      description:
        "The id of the best-matching category from the provided list, or null if none fit.",
    },
    price: {
      type: ["string", "null"],
      description:
        "Estimated retail price in Jordanian Dinars, exactly 2 decimal places, e.g. '0.50'. " +
        "Null if there is no reasonable basis to estimate.",
    },
    confidence: {
      type: "number",
      description: "Confidence in the identification, 0 to 1.",
    },
  },
  required: ["name", "categoryId", "price", "confidence"],
  additionalProperties: false,
} as const;

/**
 * Product recognition via Claude's vision — the production implementation.
 *
 * Note the prompt does the heavy lifting of *constraining* the model: it may
 * only choose from the shop's real categories, it must price in JOD for a
 * half-dinar shop, and it must admit uncertainty rather than invent. Those are
 * product rules, so they live here beside the call rather than in a caller.
 */
export class ClaudeVisionAnalyzer implements ProductVisionAnalyzer {
  readonly name = "claude";
  readonly isRealAi = true;

  private readonly logger = new Logger(ClaudeVisionAnalyzer.name);
  private readonly client: Anthropic;

  constructor(private readonly config: ClaudeVisionConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      // One retry: the merchant is waiting at the counter, so a long retry
      // chain would feel broken. Better to fail fast and let them type it.
      maxRetries: 1,
    });
  }

  async suggest(photo: ProductPhoto, categories: CategoryOption[]): Promise<ProductSuggestion> {
    if (!SUPPORTED_MIME_TYPES.includes(photo.mimeType as (typeof SUPPORTED_MIME_TYPES)[number])) {
      throw new VisionError(`Unsupported image type: ${photo.mimeType}`, this.name);
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 1024,
        system: this.systemPrompt(categories),
        // Guarantees a schema-valid object rather than JSON-ish prose.
        output_config: { format: { type: "json_schema", schema: SUGGESTION_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: photo.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: photo.buffer.toString("base64"),
                },
              },
              {
                type: "text",
                text: "Identify this product for the shop's catalogue.",
              },
            ],
          },
        ],
      });
    } catch (cause) {
      throw new VisionError(
        `Could not reach the vision service: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.name,
        cause,
      );
    }

    // A safety refusal is a legitimate outcome, not a crash — and reading
    // content[0] without checking would throw on the empty content array.
    if (response.stop_reason === "refusal") {
      throw new VisionError(
        "The vision service declined to describe this image.",
        this.name,
      );
    }

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") {
      throw new VisionError("The vision service returned no suggestion.", this.name);
    }

    let parsed: {
      name?: unknown;
      categoryId?: unknown;
      price?: unknown;
      confidence?: unknown;
    };
    try {
      parsed = JSON.parse(text.text);
    } catch (cause) {
      throw new VisionError("The vision service returned an unreadable answer.", this.name, cause);
    }

    return this.validate(parsed, categories);
  }

  /**
   * Checks the model's answer against reality before it reaches a merchant.
   *
   * Structured outputs guarantee the *shape*, not the *truth*: a schema cannot
   * stop the model returning a category id that does not exist, or a price like
   * "about 0.5". Both would otherwise surface as a broken form or a corrupted
   * price, so they are rejected here.
   */
  private validate(
    parsed: { name?: unknown; categoryId?: unknown; price?: unknown; confidence?: unknown },
    categories: CategoryOption[],
  ): ProductSuggestion {
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) throw new VisionError("The vision service suggested no name.", this.name);

    // Only accept an id that is genuinely in the list we offered.
    const categoryId =
      typeof parsed.categoryId === "string" &&
      categories.some((c) => c.id === parsed.categoryId)
        ? parsed.categoryId
        : null;

    // Money must be exactly 2dp or it is not money — drop it rather than let a
    // malformed value reach a price field.
    const price =
      typeof parsed.price === "string" && /^\d+\.\d{2}$/.test(parsed.price) ? parsed.price : null;

    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0;

    return { name, categoryId, price, confidence, provider: this.name };
  }

  private systemPrompt(categories: CategoryOption[]): string {
    const list = categories.map((c) => `- ${c.id}: ${c.path}`).join("\n");

    return [
      "You identify products from photographs for a small variety shop in Jordan.",
      "",
      "The shop is a 'half-dinar shop': most items cost around 0.50 JOD, and almost",
      "everything is between 0.20 and 2.00 JOD. Price in Jordanian Dinars accordingly.",
      "",
      "Name the product as a shop-shelf label would: short, English, including the",
      "size or weight if it is visible on the packaging.",
      "",
      "Choose the category ID from EXACTLY this list, or null if none fit:",
      list,
      "",
      "Be honest about uncertainty. If the photo is blurry, the item is obscured, or",
      "you cannot tell what it is, give a low confidence and use null for price.",
      "A confident wrong answer costs the shopkeeper more than an honest 'not sure',",
      "because they will not check it.",
    ].join("\n");
  }
}
