import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { CurrentUser, Roles } from "../auth/decorators";
import type { AuthenticatedUser } from "../auth/jwt-payload";
import { CategoriesService } from "../categories/categories.module";
import { UploadsService } from "../uploads/uploads.module";
import { VISION_ANALYZER, VisionError, type ProductVisionAnalyzer } from "../vision/vision.types";
import { CreateProductDto, SetAvailabilityDto, UpdateProductDto } from "./dto";
import { ProductsService } from "./products.service";

/**
 * Merchant-facing product management.
 *
 * Every route is MERCHANT-only and scoped to the caller's own shop. The
 * customer-facing browse endpoints are built in Phase 3.
 */
@Roles("MERCHANT")
@Controller("products")
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly uploads: UploadsService,
    @Inject(VISION_ANALYZER) private readonly vision: ProductVisionAnalyzer,
  ) {}

  /**
   * Suggests a product's name, category and price from a photograph.
   *
   * The answer to "a shop has thousands of items": the merchant photographs the
   * item instead of typing three fields for each one.
   *
   * NOTHING IS SAVED HERE. This returns a suggestion for the merchant to
   * confirm or edit; creating the product is still POST /products. Keeping the
   * two apart is deliberate — an AI that could write to the catalogue directly
   * would put its mistakes in front of customers at full price.
   */
  @Post("suggest-from-photo")
  @UseInterceptors(
    FileInterceptor("file", {
      // Buffered in memory: the bytes are checked before anything is done with
      // them, and nothing is written to disk on this path at all.
      storage: memoryStorage(),
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
        files: 1,
      },
    }),
  )
  async suggestFromPhoto(@UploadedFile() file: Express.Multer.File) {
    // The SAME magic-byte check the upload endpoint uses — the AI route must
    // not become the weak way in for a non-image.
    const signature = this.uploads.validateImage(file);

    // The model may only pick from categories that really exist, so its answer
    // can go straight into the form's dropdown.
    const categories = await this.categories.findFlat();

    try {
      return await this.vision.suggest(
        { buffer: file.buffer, mimeType: signature.mime },
        categories,
      );
    } catch (error) {
      if (error instanceof VisionError) {
        // Degrade to typing, never to a dead end: the merchant can always fill
        // the form in by hand, which is exactly what they did before this
        // existed.
        throw new ServiceUnavailableException(
          "We could not read that photo. Please enter the details by hand.",
        );
      }
      throw error;
    }
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.products.findAll(user.id, { search, categoryId });
  }

  @Get(":id")
  findOne(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.findOne(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProductDto) {
    return this.products.create(user.id, dto);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(user.id, id, dto);
  }

  /** Dedicated toggle so the dashboard's switch does not need a full update. */
  @Patch(":id/availability")
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.products.setAvailability(user.id, id, dto.isAvailable);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.remove(user.id, id);
  }
}
