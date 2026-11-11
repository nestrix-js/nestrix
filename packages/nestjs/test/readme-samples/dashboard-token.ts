import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      ui: {
        // Required to serve the dashboard outside development. At least 32 characters.
        enabled: true,
        auth: { token: process.env.NESTRIX_UI_TOKEN ?? "" },
        // Default "/_nestrix". Outside the global prefix and versioning.
        path: "/_nestrix",
      },
    }),
  ],
})
export class AppModule {}
