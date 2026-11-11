// Several apps in one process (a plan is on when any live configuration traces it), a `@Global()`
// root module, and methods called with no active span (D-67).
import "reflect-metadata";
import { Global, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { planOf } from "../../src/methods/registry.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  BASE_OPTIONS,
  contextInstrumented,
  inParent,
  methodSpans,
  recordingSink,
  resetSpans,
  setupTracing,
} from "./helpers.js";

setupTracing();

@Injectable()
class SharedService {
  work(): number {
    return 1;
  }
}
@Injectable()
class OnlyAService {
  work(): number {
    return 2;
  }
}
@Injectable()
class OnlyBService {
  work(): number {
    return 3;
  }
}

@Module({
  imports: [NestrixModule.forRoot(BASE_OPTIONS)],
  providers: [SharedService, OnlyAService],
})
class AppA {}
@Module({
  imports: [NestrixModule.forRoot(BASE_OPTIONS)],
  providers: [SharedService, OnlyBService],
})
class AppB {}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
  resetSpans();
});

const names = () => methodSpans().map((s) => s.name);

describe("two apps in one process", () => {
  it("both keep their classes on, and closing one does not switch off what the other traces", async () => {
    const a = await contextInstrumented(AppA, NestrixInstrument);
    open.push(a);
    const b = await contextInstrumented(AppB, NestrixInstrument);
    open.push(b);

    expect(planOf(OnlyAService)?.on).toBe(true);
    expect(planOf(OnlyBService)?.on).toBe(true);
    expect(planOf(SharedService)?.on).toBe(true);
    inParent(() => {
      a.get(OnlyAService).work();
      b.get(OnlyBService).work();
      b.get(SharedService).work();
    });
    expect(names().sort()).toEqual([
      "OnlyAService.work",
      "OnlyBService.work",
      "SharedService.work",
    ]);

    await a.close();
    open.splice(open.indexOf(a), 1);
    expect(planOf(OnlyAService)?.on).toBe(false);
    expect(planOf(OnlyBService)?.on).toBe(true);
    // A class both apps own stays on while the second app lives.
    expect(planOf(SharedService)?.on).toBe(true);
    resetSpans();
    inParent(() => {
      b.get(OnlyBService).work();
      b.get(SharedService).work();
    });
    expect(names().sort()).toEqual(["OnlyBService.work", "SharedService.work"]);

    await b.close();
    open.splice(open.indexOf(b), 1);
    expect(planOf(SharedService)?.on).toBe(false);
    expect(planOf(OnlyBService)?.on).toBe(false);
  });
});

describe("a @Global() root module", () => {
  @Injectable()
  class GlobalRootService {
    work(): number {
      return 1;
    }
  }
  @Global()
  @Module({
    imports: [NestrixModule.forRoot(BASE_OPTIONS)],
    providers: [GlobalRootService],
  })
  class GlobalAppModule {}

  it("is still found as the root: its providers are traced", async () => {
    const app = await contextInstrumented(GlobalAppModule, NestrixInstrument);
    open.push(app);
    expect(planOf(GlobalRootService)?.on).toBe(true);
    inParent(() => app.get(GlobalRootService).work());
    expect(names()).toEqual(["GlobalRootService.work"]);
  });
});

describe("services named like enhancers", () => {
  @Injectable()
  class MapperService {
    transform(v: number): number {
      return v + 1;
    }
  }
  @Injectable()
  class FeatureFlagService {
    canActivate(): boolean {
      return true;
    }
  }
  @Module({
    imports: [NestrixModule.forRoot(BASE_OPTIONS)],
    providers: [MapperService, FeatureFlagService],
  })
  class NamedApp {}

  it("an own MapperService.transform and FeatureFlagService.canActivate are traced as services", async () => {
    const app = await contextInstrumented(NamedApp, NestrixInstrument);
    open.push(app);
    inParent(() => {
      app.get(MapperService).transform(1);
      app.get(FeatureFlagService).canActivate();
    });
    expect(
      methodSpans().map((s) => [s.name, s.attributes["nestrix.component"]]),
    ).toEqual([
      ["MapperService.transform", "service"],
      ["FeatureFlagService.canActivate", "service"],
    ]);
  });

  function NestrixApp() {
    return NamedApp;
  }
});

describe("a method called with no valid active span (D-67)", () => {
  @Injectable()
  class StartupWork {
    work(): number {
      return 7;
    }
  }
  @Injectable()
  class Boot implements OnModuleInit {
    static result = 0;
    constructor(private readonly w: StartupWork) {}
    onModuleInit(): void {
      Boot.result = this.w.work();
    }
  }
  @Module({
    imports: [NestrixModule.forRoot(BASE_OPTIONS)],
    providers: [StartupWork, Boot],
  })
  class BootApp {}

  it("an own service called from onModuleInit gets no span but is counted by the sink", async () => {
    const { calls, dispose } = recordingSink();
    try {
      const app = await contextInstrumented(BootApp, NestrixInstrument);
      open.push(app);
      expect(Boot.result).toBe(7);
      expect(planOf(StartupWork)?.on).toBe(true);
      expect(methodSpans()).toEqual([]);
      expect(
        calls.filter(
          (c) => c.className === "StartupWork" && c.method === "work",
        ),
      ).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
