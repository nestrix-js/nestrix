import { Module } from "@nestjs/common";
import { UiController, UiFiles } from "./ui.controller.js";

/** Serves the `@nestrix-js/ui` build at `/` (behind the admin login, `src/auth`). */
@Module({
  controllers: [UiController],
  providers: [UiFiles],
  exports: [UiFiles],
})
export class UiModule {}
