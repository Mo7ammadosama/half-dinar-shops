import { INestApplication, ValidationPipe } from "@nestjs/common";

/**
 * Applies the app-wide HTTP configuration.
 *
 * Shared by main.ts and the e2e tests so the tests exercise the same validation
 * rules the real server enforces — otherwise a pipe could be removed in
 * production and every test would still pass.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix("api");

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties, and reject rather than ignore them, so a
      // client cannot smuggle fields (e.g. merchantId) into a DTO.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  return app;
}
