import type { ServerResponse } from "node:http";
import {
  Controller,
  Get,
  Injectable,
  Logger,
  type OnModuleInit,
  Param,
  Res,
} from "@nestjs/common";
import {
  HTML_TYPE,
  IMMUTABLE,
  TEXT_TYPE,
  UI_CSP,
  writeRaw,
} from "../auth/http.js";
import { loadUi, resolveUiDirectory, type UiBundle } from "./assets.js";

/** Holds the UI build, read once at start. */
@Injectable()
export class UiFiles implements OnModuleInit {
  private readonly logger = new Logger("NestrixUi");
  bundle: UiBundle | undefined;
  /** Replaceable in tests. */
  resolveDirectory: () => string | undefined = resolveUiDirectory;

  onModuleInit(): void {
    try {
      const directory = this.resolveDirectory();
      if (directory === undefined) {
        this.logger.error(
          "@nestrix/ui is not installed: the dashboard answers 503. Reinstall the server.",
        );
        return;
      }
      this.bundle = loadUi(directory);
    } catch (error) {
      this.bundle = undefined;
      try {
        this.logger.error(
          `The @nestrix/ui build could not be loaded, the dashboard answers 503: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // Logging must not stop the server from starting.
      }
    }
  }
}

/**
 * `GET /` (the UI's `index.html`, `no-store`) and `GET /assets/<file>` (hashed files, immutable).
 * Files are looked up by exact name in the in-memory map built from the manifest; anything else
 * is a 404. Protected by the admin login (`AdminAuth.middleware()` and `AdminAuthGuard`) like
 * every path but ingest and the login itself. Every response carries the dashboard's CSP.
 */
@Controller()
export class UiController {
  constructor(private readonly files: UiFiles) {}

  @Get()
  index(@Res() res: ServerResponse): void {
    const bundle = this.files.bundle;
    if (!bundle) {
      this.unavailable(res);
      return;
    }
    writeRaw(res, {
      status: 200,
      csp: UI_CSP,
      contentType: HTML_TYPE,
      body: bundle.index,
    });
  }

  @Get("assets/:file")
  asset(@Param("file") file: unknown, @Res() res: ServerResponse): void {
    const bundle = this.files.bundle;
    if (!bundle) {
      this.unavailable(res);
      return;
    }
    const asset =
      typeof file === "string"
        ? bundle.assets.get(`assets/${file}`)
        : undefined;
    if (!asset) {
      writeRaw(res, {
        status: 404,
        csp: UI_CSP,
        contentType: TEXT_TYPE,
        body: "Not found.",
      });
      return;
    }
    writeRaw(res, {
      status: 200,
      csp: UI_CSP,
      contentType: asset.contentType,
      cacheControl: IMMUTABLE,
      body: asset.body,
    });
  }

  private unavailable(res: ServerResponse): void {
    writeRaw(res, {
      status: 503,
      csp: UI_CSP,
      contentType: TEXT_TYPE,
      body: "The dashboard build (@nestrix/ui) is not available on this server.",
    });
  }
}
