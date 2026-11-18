import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Get, Post, Req, Res } from "@nestjs/common";
import { AdminAuth } from "./admin-auth.js";

/**
 * `/login`, `/login.css`, `/logout`, and single sign-on's `/login/oidc` and `/login/oidc/callback`
 * (issue #34). Responses are written to the raw response by `AdminAuth`
 * (`@Res()`), so their headers are exactly the ones it sets.
 */
@Controller()
export class AuthController {
  constructor(private readonly auth: AdminAuth) {}

  @Get("login")
  showLogin(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.auth.showLogin(req, res);
  }

  @Post("login")
  login(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.auth.login(req, res);
  }

  @Get("login/oidc")
  oidcStart(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.auth.oidcStart(req, res);
  }

  @Get("login/oidc/callback")
  oidcCallback(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.auth.oidcCallback(req, res);
  }

  @Get("login.css")
  css(@Res() res: ServerResponse): void {
    this.auth.css(res);
  }

  @Post("logout")
  logout(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.auth.logout(req, res);
  }
}
