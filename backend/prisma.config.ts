// Prisma 7 configuration. Loads DATABASE_URL from .env (Prisma no longer does this implicitly).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `npx prisma db seed` runs this. ts-node uses the CommonJS tsconfig, matching NestJS.
    seed: "ts-node prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
