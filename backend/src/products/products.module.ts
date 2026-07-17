import { Module } from "@nestjs/common";
import { CategoriesModule } from "../categories/categories.module";
import { UploadsModule } from "../uploads/uploads.module";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

@Module({
  // CategoriesModule: the AI suggestion must pick from the shop's real
  // categories. UploadsModule: the photo goes through the same magic-byte
  // validation as a stored upload. (VisionModule is @Global.)
  imports: [CategoriesModule, UploadsModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
