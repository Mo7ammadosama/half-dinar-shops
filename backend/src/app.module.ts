import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ServeStaticModule } from "@nestjs/serve-static";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { Redis } from "ioredis";
import { join } from "node:path";
import { RateLimitModule, REDIS_CLIENT } from "./rate-limit/rate-limit.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard, RolesGuard } from "./auth/guards";
import { CategoriesModule } from "./categories/categories.module";
import { validateEnv } from "./config/env.validation";
import { RATE_LIMITS } from "./config/rate-limits";
import { MerchantsModule } from "./merchants/merchants.module";
import { OrdersModule } from "./orders/orders.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProductsModule } from "./products/products.module";
import { PushModule } from "./push/push.module";
import { ShopsModule } from "./shops/shops.module";
import { SmsModule } from "./sms/sms.module";
import { StorageModule } from "./storage/storage.module";
import { UploadsModule } from "./uploads/uploads.module";
import { VisionModule } from "./vision/vision.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fails fast on missing/weak configuration rather than at first use.
      validate: validateEnv,
    }),
    // Must be imported before ThrottlerModule: it provides REDIS_CLIENT, which
    // the throttler's factory injects to decide its storage backend.
    RateLimitModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null) => ({
        // Exactly ONE global throttler. Every named throttler declared here is
        // applied to every route, so adding a second strict one (e.g. an "otp"
        // limit of 3/min) would silently throttle the whole API to 3 requests a
        // minute. Sensitive routes instead override this same "default" bucket
        // with their own @Throttle({ default: ... }).
        throttlers: [{ name: "default", ...RATE_LIMITS.default }],
        // Redis when configured, otherwise the throttler's in-memory default.
        // In-memory resets on restart and is per-instance — that is blocker B2,
        // and env.validation.ts refuses to boot production without Redis.
        ...(redis ? { storage: new ThrottlerStorageRedisService(redis) } : {}),
      }),
    }),
    // Serves uploaded product photos at /uploads/<file>.
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOAD_DIR || "uploads"),
      serveRoot: "/uploads",
      serveStaticOptions: { index: false, redirect: false },
    }),
    PrismaModule,
    SmsModule,
    StorageModule,
    PushModule,
    VisionModule,
    AuthModule,
    MerchantsModule,
    ProductsModule,
    ShopsModule,
    OrdersModule,
    AdminModule,
    CategoriesModule,
    UploadsModule,
  ],
  providers: [
    // Order matters: rate limit, then authenticate, then check role.
    //
    // ThrottlerGuard is registered as a provider and bound with `useExisting`
    // rather than `useClass`. Binding with useClass would make APP_GUARD the
    // only token, leaving nothing for tests to override — and a test suite
    // firing dozens of requests from one IP would throttle itself. Rate
    // limiting is verified for real in throttle.e2e-spec.ts.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
