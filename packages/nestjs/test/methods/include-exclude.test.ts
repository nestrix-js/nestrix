// P3-02 acceptance: a library-like provider registered by a dynamic module is not traced, and is
// when `include`d; `exclude` wins; enhancer spans follow `methods.enhancers`.
import "reflect-metadata";
import {
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
  Param,
  type PipeTransform,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { methodsEnabled } from "../../src/methods/registry.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import type { NestrixMethodOptions } from "../../src/options.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  type Instrumented,
  methodSpans,
  resetSpans,
  serverSpanOf,
  setupTracing,
  waitFor,
} from "./helpers.js";

setupTracing();

@Injectable()
class LibClient {
  ping(): string {
    return "pong";
  }
}

@Module({})
class LibModule {
  static forRoot(): DynamicModule {
    return {
      module: LibModule,
      global: true,
      providers: [LibClient],
      exports: [LibClient],
    };
  }
}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
class PassInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

@Injectable()
class UpperPipe implements PipeTransform {
  transform(value: unknown, _meta: ArgumentMetadata): unknown {
    return String(value).toUpperCase();
  }
}

@Injectable()
class HealthService {
  check(): string {
    return "ok";
  }
}

@Controller("lib")
class LibController {
  constructor(
    @Inject(LibClient) private readonly lib: LibClient,
    @Inject(HealthService) private readonly health: HealthService,
  ) {}
  @Get(":v")
  @UseGuards(AllowGuard)
  @UseInterceptors(PassInterceptor)
  get(@Param("v", UpperPipe) v: string): string {
    return `${this.lib.ping()}:${this.health.check()}:${v}`;
  }
}

function appWith(methods?: NestrixMethodOptions) {
  @Module({
    imports: [
      LibModule.forRoot(),
      NestrixModule.forRoot({ ...BASE_OPTIONS, methods }),
    ],
    controllers: [LibController],
    providers: [HealthService],
  })
  class App {}
  return App;
}

let booted: Instrumented | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

async function traced(methods?: NestrixMethodOptions): Promise<string[]> {
  // With two live apps a class is traced if either configuration says so: close the previous one.
  await booted?.close();
  booted = await bootInstrumented(
    "express",
    appWith(methods),
    NestrixInstrument,
  );
  resetSpans();
  const r = await booted.get("/lib/x");
  expect(r.body).toBe("pong:ok:X");
  await waitFor(() => serverSpanOf("/lib/x") !== undefined);
  return methodSpans()
    .map((s) => s.name)
    .sort();
}

describe("include / exclude / enhancers (express)", () => {
  it("default: the dynamic module's provider is not traced; own classes are", async () => {
    expect(await traced()).toEqual([
      "HealthService.check",
      "LibController.get",
    ]);
    expect(methodsEnabled()).toBe(true);
  });

  it("include by class traces it", async () => {
    expect(await traced({ include: [LibClient] })).toEqual([
      "HealthService.check",
      "LibClient.ping",
      "LibController.get",
    ]);
  });

  it("include by RegExp and by name traces it", async () => {
    expect(await traced({ include: [/Client$/] })).toContain("LibClient.ping");
    expect(await traced({ include: ["LibClient"] })).toContain(
      "LibClient.ping",
    );
  });

  it("exclude wins over include and over the own set", async () => {
    expect(
      await traced({
        include: [LibClient],
        exclude: ["HealthService", LibClient],
      }),
    ).toEqual(["LibController.get"]);
  });

  it("enhancers: true traces guards, interceptors and pipes; a list traces only those", async () => {
    const all = await traced({ enhancers: true });
    expect(all).toEqual(
      [
        "AllowGuard.canActivate",
        "HealthService.check",
        "LibController.get",
        "PassInterceptor.intercept",
        "UpperPipe.transform",
      ].sort(),
    );
    const guard = methodSpans().find(
      (s) => s.name === "AllowGuard.canActivate",
    );
    expect(guard?.attributes["nestrix.component"]).toBe("guard");
    expect(
      methodSpans().find((s) => s.name === "UpperPipe.transform")?.attributes[
        "nestrix.component"
      ],
    ).toBe("pipe");
    expect(await traced({ enhancers: ["guard"] })).toEqual([
      "AllowGuard.canActivate",
      "HealthService.check",
      "LibController.get",
    ]);
  });

  it("methods.enabled false: no method spans, methodsEnabled() false", async () => {
    expect(await traced({ enabled: false })).toEqual([]);
    expect(methodsEnabled()).toBe(false);
  });
});
