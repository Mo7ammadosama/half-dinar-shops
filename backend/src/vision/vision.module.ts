import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClaudeVisionAnalyzer } from "./claude-vision.analyzer";
import { MockVisionAnalyzer } from "./mock-vision.analyzer";
import { VISION_ANALYZER, type ProductVisionAnalyzer } from "./vision.types";

/**
 * The model used for product recognition.
 *
 * Overridable via VISION_MODEL so the founder can trade cost against accuracy
 * without a code change, but pinned here so a deploy is reproducible rather
 * than silently drifting when a new model ships.
 */
const DEFAULT_VISION_MODEL = "claude-opus-4-8";

/**
 * Chooses the product-recognition implementation from configuration alone.
 *
 * Same contract as the SMS/storage/push seams: pasting an API key switches it
 * live with zero code changes.
 *
 * Like push (and unlike SMS/storage) there is NO production boot guard — the
 * shop can be stocked by hand without AI, so this is a large convenience, not a
 * correctness requirement. Refusing to boot over it would be wrong.
 */
export function createVisionAnalyzer(
  config: ConfigService,
  mock: MockVisionAnalyzer = new MockVisionAnalyzer(),
): ProductVisionAnalyzer {
  const logger = new Logger("VisionModule");

  const explicit = config.get<string>("VISION_PROVIDER")?.trim().toLowerCase();
  const apiKey = config.get<string>("ANTHROPIC_API_KEY")?.trim();

  const chosen = explicit || (apiKey ? "claude" : "mock");

  if (chosen === "claude") {
    if (!apiKey) {
      throw new Error(
        "VISION_PROVIDER=claude, but ANTHROPIC_API_KEY is not set. See docs/AI_VISION_SETUP.md.",
      );
    }
    const model = config.get<string>("VISION_MODEL")?.trim() || DEFAULT_VISION_MODEL;
    logger.log(`AI product entry: claude (${model})`);

    return new ClaudeVisionAnalyzer({
      apiKey,
      model,
      timeoutMs: Number(config.get<string>("VISION_TIMEOUT_MS") ?? 30_000),
    });
  }

  if (chosen !== "mock") {
    throw new Error(`Unknown VISION_PROVIDER "${chosen}". Supported: "mock", "claude".`);
  }

  logger.warn(
    "AI product entry: mock — suggestions are canned, NOT real recognition. " +
      "See docs/AI_VISION_SETUP.md to go live.",
  );
  return mock;
}

@Global()
@Module({
  providers: [
    MockVisionAnalyzer,
    {
      provide: VISION_ANALYZER,
      inject: [ConfigService, MockVisionAnalyzer],
      useFactory: createVisionAnalyzer,
    },
  ],
  exports: [VISION_ANALYZER, MockVisionAnalyzer],
})
export class VisionModule {}
