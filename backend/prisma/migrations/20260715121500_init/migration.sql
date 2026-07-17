-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('customer', 'merchant', 'admin');

-- CreateEnum
CREATE TYPE "merchant_status" AS ENUM ('pending', 'approved', 'suspended');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "cancelled_by" AS ENUM ('customer', 'merchant', 'system');

-- CreateEnum
CREATE TYPE "order_item_status" AS ENUM ('confirmed', 'unavailable');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('assigned', 'picked_up', 'on_way', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_number" VARCHAR(20) NOT NULL,
    "otp_verified" BOOLEAN NOT NULL DEFAULT false,
    "role" "user_role" NOT NULL DEFAULT 'customer',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "shop_name" VARCHAR(120) NOT NULL,
    "location_lat" DOUBLE PRECISION NOT NULL,
    "location_lng" DOUBLE PRECISION NOT NULL,
    "opening_hours" VARCHAR(120) NOT NULL,
    "status" "merchant_status" NOT NULL DEFAULT 'pending',
    "commission_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "parent_category_id" UUID,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "image_url" VARCHAR(500),
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending',
    "total_price" DECIMAL(10,2) NOT NULL,
    "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cancelled_by" "cancelled_by",
    "cancellation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_at_order" DECIMAL(10,2) NOT NULL,
    "status" "order_item_status" NOT NULL DEFAULT 'confirmed',

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "captain_name" VARCHAR(120) NOT NULL,
    "captain_phone" VARCHAR(20) NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'assigned',
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" VARCHAR(1000),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_user_id_key" ON "merchants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_parent_category_id_name_key" ON "categories"("parent_category_id", "name");

-- CreateIndex
CREATE INDEX "products_merchant_id_idx" ON "products"("merchant_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "orders_merchant_id_idx" ON "orders"("merchant_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_order_id_key" ON "deliveries"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_key" ON "reviews"("order_id");

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints (hand-written).
--
-- Prisma's schema language cannot express CHECK constraints, so they are added
-- here as raw SQL. They are the last line of defence: even if an API-layer bug
-- slips through, the database itself rejects negative money, zero-quantity
-- lines, and out-of-range ratings.
--
-- Prisma ignores CHECK constraints during drift detection, so these survive
-- future `prisma migrate dev` runs.
-- ---------------------------------------------------------------------------

-- Money must never be negative.
ALTER TABLE "products"
  ADD CONSTRAINT "products_price_non_negative" CHECK ("price" >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_price_non_negative" CHECK ("total_price" >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivery_fee_non_negative" CHECK ("delivery_fee" >= 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_price_at_order_non_negative" CHECK ("price_at_order" >= 0);

-- An order line for zero or fewer units is meaningless.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);

-- Commission is a fraction of the order total: 0.0000 (0%) .. 1.0000 (100%).
ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_commission_rate_range" CHECK ("commission_rate" >= 0 AND "commission_rate" <= 1);

-- Geographic coordinates must be physically valid.
ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_location_lat_range" CHECK ("location_lat" >= -90 AND "location_lat" <= 90);

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_location_lng_range" CHECK ("location_lng" >= -180 AND "location_lng" <= 180);

-- Ratings are a 1..5 star scale.
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5);

-- A category cannot be its own parent (guards the self-referencing tree).
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_no_self_parent" CHECK ("parent_category_id" IS NULL OR "parent_category_id" <> "id");

-- A cancelled order must record who cancelled it, and only a cancelled order may.
-- Keeps `cancelled_by` and `status` from contradicting each other.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancelled_by_matches_status" CHECK (
    ("status" = 'cancelled' AND "cancelled_by" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancelled_by" IS NULL)
  );
