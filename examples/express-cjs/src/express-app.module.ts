import { Module } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { MulterController } from "./multer.controller.js";

/** `AppModule` plus the Express-only routes. `main.ts` boots this one. */
@Module({ imports: [AppModule], controllers: [MulterController] })
export class ExpressAppModule {}
