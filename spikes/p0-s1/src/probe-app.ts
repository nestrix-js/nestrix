import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ArgumentMetadata,
  BadRequestException,
  Body,
  type CallHandler,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
  Param,
  type PipeTransform,
  Post,
  Query,
  Req,
  Scope,
  type Type,
  UseGuards,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE, REQUEST } from "@nestjs/core";
import { type Observable, tap } from "rxjs";
import { HooksModule, record } from "./probe.js";

type AnyReq = IncomingMessage & { raw?: IncomingMessage };

function probeOf(req: AnyReq | undefined): string | undefined {
  const value = (req?.raw ?? req)?.headers?.["x-probe"];
  return typeof value === "string" ? value : undefined;
}

function probeOfContext(ctx: ExecutionContext): string | undefined {
  return probeOf(ctx.switchToHttp().getRequest<AnyReq>());
}

/** Global guard: always allows, records what it sees. */
@Injectable()
export class ProbeGlobalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    record("guard:global", probeOfContext(ctx));
    return true;
  }
}

/** Method-level guard: always allows, records what it sees. */
@Injectable()
export class ProbeMethodGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    record("guard:method", probeOfContext(ctx));
    return true;
  }
}

/** Global interceptor: records before the handler and when its result arrives. */
@Injectable()
export class ProbeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const probe = probeOfContext(ctx);
    record("interceptor:before", probe);
    return next.handle().pipe(
      tap({
        next: () => record("interceptor:after", probe),
        error: () => record("interceptor:error", probe),
      }),
    );
  }
}

/**
 * Global pipe. It gets no request, so only the store tells which request it ran
 * for. (Nest does not run pipes for `@Headers()` parameters.)
 */
@Injectable()
export class ProbePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    record(
      `pipe:${metadata.type}`,
      metadata.data === "x-probe" && typeof value === "string"
        ? value
        : undefined,
      { data: metadata.data ?? null },
    );
    return value;
  }
}

async function readUpload(
  req: AnyReq,
): Promise<{ name: string; size: number }> {
  const raw = req.raw ?? req;
  const contentType = raw.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    throw new BadRequestException("expected multipart/form-data");
  }
  const form = await new Response(
    Readable.toWeb(raw) as ReadableStream<Uint8Array>,
    { headers: { "content-type": contentType } },
  ).formData();
  for (const value of form.values()) {
    if (typeof value !== "string")
      return { name: value.name, size: value.size };
  }
  throw new BadRequestException("no file in the form");
}

@Controller("probe")
export class ProbeController {
  @Get("ctx")
  @UseGuards(ProbeMethodGuard)
  async ctx(
    @Headers("x-probe") probe: string,
    @Query("q") _q: string,
  ): Promise<{ ok: true }> {
    record("handler", probe);
    await sleep(5);
    record("handler:after-timer", probe);
    await stat(import.meta.dirname);
    record("handler:after-fs", probe);
    await new Promise((r) => setImmediate(r));
    record("handler:after-immediate", probe);
    return { ok: true };
  }

  /** Slow handler: 300 ms before it answers, for aborts before the response starts. */
  @Get("slow")
  async slow(@Headers("x-probe") probe: string): Promise<{ ok: true }> {
    record("handler", probe);
    await sleep(300);
    record("handler:after-sleep", probe);
    return { ok: true };
  }

  /** 201 with a 16 MiB body, ended in one call: for a delivery cut after the app finished. */
  @Get("big")
  @HttpCode(201)
  big(@Headers("x-probe") probe: string): Buffer {
    record("handler", probe);
    return Buffer.alloc(16 * 1024 * 1024, 97);
  }

  @Post("echo")
  async echo(
    @Body() body: unknown,
    @Headers("x-probe") probe: string,
  ): Promise<unknown> {
    record("handler", probe);
    await sleep(5);
    record("handler:after-timer", probe);
    return body;
  }

  @Post("upload")
  async upload(
    @Req() req: AnyReq,
    @Headers("x-probe") probe: string,
  ): Promise<{ name: string; size: number }> {
    record("handler", probe);
    const file = await readUpload(req);
    record("handler:after-parse", probe);
    return file;
  }
}

/** Request-scoped: constructed per request, so its constructor runs inside the request. */
@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {
  private readonly probe: string | undefined;
  constructor(@Inject(REQUEST) req: AnyReq) {
    this.probe = probeOf(req);
    record("request-scoped:ctor", this.probe);
  }
  async work(): Promise<void> {
    record("request-scoped:method", this.probe);
    await sleep(2);
    record("request-scoped:after-await", this.probe);
  }
}

/** Becomes request-scoped through its dependency. */
@Controller("probe-scoped")
export class ScopedController {
  constructor(private readonly service: RequestScopedService) {
    record("scoped-controller:ctor");
  }
  @Get()
  async get(@Headers("x-probe") probe: string): Promise<{ ok: true }> {
    record("handler", probe);
    await this.service.work();
    return { ok: true };
  }
}

/** Q3: a controller path with parameters. */
@Controller("orgs/:orgId/items")
export class ItemsController {
  @Get(":itemId")
  get(@Param("itemId") itemId: string): { itemId: string } {
    record("handler:items");
    return { itemId };
  }
}

/** Q3: two versions of one route. Only mounted when versioning is enabled. */
@Controller({ path: "ver", version: "1" })
export class VersionOneController {
  @Get(":id")
  get(): string {
    record("handler:v1");
    return "v1";
  }
}

@Controller({ path: "ver", version: "2" })
export class VersionTwoController {
  @Get(":id")
  get(): string {
    record("handler:v2");
    return "v2";
  }
}

export interface SpikeModuleOptions {
  /** The app module whose routes are exercised (the fixture `AppModule` by default). */
  app?: Type;
  /** Extra controllers, e.g. the Express-only multer probe. */
  controllers?: Type[];
  /** Mount the two-version controllers (only valid with versioning enabled). */
  versioned?: boolean;
  /** Leave out the global probe guard/interceptor/pipe. */
  noEnhancers?: boolean;
}

/**
 * The module under test: the fixture app, plus `HooksModule` (whose provider sets
 * the hooks in its constructor), plus the probes.
 */
export function buildSpikeModule(options: SpikeModuleOptions = {}): Type {
  const imports: Type[] = [HooksModule];
  if (options.app) imports.push(options.app);
  const controllers: Type[] = [
    ProbeController,
    ScopedController,
    ItemsController,
    ...(options.controllers ?? []),
  ];
  if (options.versioned) {
    controllers.push(VersionOneController, VersionTwoController);
  }
  const providers = [
    ProbeMethodGuard,
    RequestScopedService,
    ...(options.noEnhancers
      ? []
      : [
          { provide: APP_GUARD, useClass: ProbeGlobalGuard },
          { provide: APP_INTERCEPTOR, useClass: ProbeInterceptor },
          { provide: APP_PIPE, useClass: ProbePipe },
        ]),
  ];
  class SpikeModule {}
  Module({ imports, controllers, providers })(SpikeModule);
  return SpikeModule;
}
