// Must come first: rate-limit @Throttle decorators read process.env when their
// module is imported, which happens before Nest's ConfigModule initializes.
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  configureApp(app);

  // The dashboard runs on a different port in development.
  app.enableCors({ origin: true, credentials: true });

  const port = config.getOrThrow<number>("PORT");
  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log(`API listening on http://localhost:${port}/api`);
  if (config.get<boolean>("EXPOSE_OTP_IN_RESPONSE")) {
    logger.warn("EXPOSE_OTP_IN_RESPONSE is ON — login codes are returned in API responses.");
    logger.warn("This is for local development only. Never enable it in production.");
  }
}

void bootstrap();
