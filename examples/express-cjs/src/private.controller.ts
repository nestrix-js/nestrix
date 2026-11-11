import { Controller, Get, UseGuards } from "@nestjs/common";
import { AlwaysRejectGuard } from "./always-reject.guard.js";

/** Controller-level guard: every route here answers 403. */
@Controller("private")
@UseGuards(AlwaysRejectGuard)
export class PrivateController {
  @Get()
  get(): string {
    return "unreachable";
  }
}
