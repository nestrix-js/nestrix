// The own-class rule (D-58): what the static module metadata yields, and when NestrixCore computes
// it in a real app.
import "reflect-metadata";
import {
  Controller,
  type DynamicModule,
  forwardRef,
  Get,
  Inject,
  Injectable,
  Module,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ModulesContainer } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestrixCore } from "../../src/core.js";
import { NestrixInterceptor } from "../../src/http/interceptor.js";
import {
  composeInstrument,
  NestrixInstrument,
} from "../../src/methods/instrument.js";
import { computeOwnSet, findRootModules } from "../../src/methods/own-set.js";
import { currentOwnClasses, planOf } from "../../src/methods/registry.js";
import { isWrapper } from "../../src/methods/wrap.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  type Instrumented,
  methodSpans,
  resetSpans,
  setupTracing,
  waitFor,
} from "./helpers.js";

setupTracing();

// ---- a small app: root -> feature (static) -> nested (static), forwardRef cycle, a dynamic library
@Injectable()
class NestedService {
  value(): string {
    return "nested";
  }
}
@Module({ providers: [NestedService], exports: [NestedService] })
class NestedModule {}

@Injectable()
class CycleBService {
  b(): string {
    return "b";
  }
}
@Module({
  imports: [forwardRef(() => CycleAModule)],
  providers: [CycleBService],
  exports: [CycleBService],
})
class CycleBModule {}

@Injectable()
class CycleAService {
  constructor(@Inject(CycleBService) private readonly cb: CycleBService) {}
  a(): string {
    return `a${this.cb.b()}`;
  }
}
@Module({
  imports: [forwardRef(() => CycleBModule)],
  providers: [CycleAService],
  exports: [CycleAService],
})
class CycleAModule {}

abstract class AbstractStore {
  abstract load(): string;
}
@Injectable()
class MemoryStore extends AbstractStore {
  load(): string {
    return "memory";
  }
}

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

@Controller("own")
class OwnController {
  constructor(
    @Inject(NestedService) private readonly nested: NestedService,
    @Inject(AbstractStore) private readonly store: AbstractStore,
    @Inject(LibClient) private readonly lib: LibClient,
    @Inject(CycleAService) private readonly cycle: CycleAService,
  ) {}
  @Get()
  get(): string {
    return [
      this.nested.value(),
      this.store.load(),
      this.lib.ping(),
      this.cycle.a(),
    ].join(",");
  }
}

@Module({
  imports: [NestedModule, ConfigModule, CycleAModule],
  controllers: [OwnController],
  providers: [{ provide: AbstractStore, useClass: MemoryStore }],
})
class FeatureModule {}

@Module({
  imports: [
    FeatureModule,
    LibModule.forRoot(),
    ConfigModule.forRoot({ ignoreEnvFile: true }),
    NestrixModule.forRoot(BASE_OPTIONS),
  ],
})
class AppModule {}

describe("computeOwnSet on static metadata", () => {
  it("follows static class imports and forwardRefs, collects classes and useClass, skips dynamic modules", () => {
    // A fake container: only the root matters for the walk; the others are "imported".
    const root = { metatype: AppModule, imports: [] };
    const set = computeOwnSet([root]);
    expect(set.roots).toEqual(["AppModule"]);
    expect(set.modules).toEqual([
      "AppModule",
      "FeatureModule",
      "NestedModule",
      "CycleAModule",
      "CycleBModule",
    ]);
    for (const c of [
      OwnController,
      MemoryStore,
      NestedService,
      CycleAService,
      CycleBService,
    ]) {
      expect(set.classes.has(c)).toBe(true);
    }
    // Registered by dynamic modules (forRoot): not own.
    expect(set.classes.has(LibClient)).toBe(false);
    expect(set.classes.has(ConfigService)).toBe(false);
  });

  it("evidence for the dynamic-module-factory adjustment: ConfigModule's static chain reaches ConfigService", () => {
    // Under the rule as written in D-58, FeatureModule's plain `imports: [ConfigModule]` would be
    // followed: ConfigModule -> ConfigHostModule -> { provide: CONFIG_SERVICE, useClass: ConfigService }.
    const hostModule = (
      Reflect.getMetadata("imports", ConfigModule) as unknown[]
    )[0] as {
      name: string;
    };
    expect(hostModule.name).toBe("ConfigHostModule");
    const hostProviders = Reflect.getMetadata(
      "providers",
      hostModule,
    ) as Array<{
      useClass?: unknown;
    }>;
    expect(hostProviders.some((p) => p.useClass === ConfigService)).toBe(true);
    // ConfigModule defines forRoot/forFeature, so the walk does not enter it.
    expect(
      typeof (ConfigModule as unknown as { forRoot?: unknown }).forRoot,
    ).toBe("function");
    expect(
      computeOwnSet([{ metatype: AppModule, imports: [] }]).classes.has(
        ConfigService,
      ),
    ).toBe(false);
  });

  it("root modules: modules no other module imports", () => {
    const a = { metatype: class A {}, imports: [] as unknown[] };
    const b = { metatype: class B {}, imports: [] as unknown[] };
    const core = { metatype: class Core {}, imports: [] as unknown[] };
    a.imports.push(b, core);
    b.imports.push(core);
    expect(findRootModules([core, a, b])).toEqual([a]);
  });

  it("never throws on hostile metadata", () => {
    class Hostile {}
    Reflect.defineMetadata(
      "imports",
      [
        {
          forwardRef: () => {
            throw new Error("x");
          },
        },
        null,
        3,
      ],
      Hostile,
    );
    Reflect.defineMetadata(
      "providers",
      [null, { useClass: 5 }, "token"],
      Hostile,
    );
    const throwing = {
      get metatype(): never {
        throw new Error("no");
      },
      imports: [],
    };
    expect(() =>
      computeOwnSet([{ metatype: Hostile, imports: [] }, throwing]),
    ).not.toThrow();
    expect(
      computeOwnSet([{ metatype: Hostile, imports: [] }]).classes.size,
    ).toBe(0);
  });
});

describe("own set in a real app (express)", () => {
  let booted: Instrumented;
  const order: string[] = [];
  beforeAll(async () => {
    // Records the order in which Nest hands instances to the decorators. NestrixCore arrives right
    // after its constructor, which is where the own set is computed.
    const recorder = {
      instanceDecorator(i: unknown) {
        const name = (i as { constructor?: { name?: string } } | null)
          ?.constructor?.name;
        if (name) order.push(name);
        return i;
      },
    };
    booted = await bootInstrumented(
      "express",
      AppModule,
      composeInstrument(NestrixInstrument, recorder),
    );
  });
  afterAll(async () => {
    await booted.close();
  });

  it("ModulesContainer is populated when NestrixCore is constructed: the own set is the static graph", () => {
    const own = currentOwnClasses();
    expect(own).toBeDefined();
    const names = [...(own ?? [])]
      .map((c) => (c as { name: string }).name)
      .sort();
    console.log(
      `own set computed in NestrixCore's constructor: ${names.join(", ")}`,
    );
    expect(names).toEqual(
      [
        "CycleAService",
        "CycleBService",
        "MemoryStore",
        "NestedService",
        "OwnController",
      ].sort(),
    );
    const roots = findRootModules(booted.app.get(ModulesContainer).values());
    expect(roots.map((r) => (r.metatype as { name: string }).name)).toEqual([
      "AppModule",
    ]);
  });

  it("instances decorated before NestrixCore are switched on afterwards; Nestrix's own classes are never wrapped", async () => {
    const coreAt = order.indexOf("NestrixCore");
    const before = order.slice(0, coreAt);
    console.log(
      `decorated before NestrixCore (${before.length}): ${before.join(", ")}`,
    );
    console.log(
      `decorated after NestrixCore (${order.length - coreAt - 1}): ${order.slice(coreAt + 1).join(", ")}`,
    );
    expect(coreAt).toBeGreaterThan(-1);
    resetSpans();
    const r = await booted.get("/own");
    expect(r.body).toBe("nested,memory,pong,ab");
    await waitFor(() => methodSpans().length >= 5);
    expect(
      methodSpans()
        .map((s) => s.name)
        .sort(),
    ).toEqual([
      "CycleAService.a",
      // CycleBModule is reached only through a forwardRef import.
      "CycleBService.b",
      "MemoryStore.load",
      "NestedService.value",
      "OwnController.get",
    ]);
    // Own classes that arrived before NestrixCore got their wrappers at decoration and were
    // switched on afterwards (measured: in this app, every provider arrives before it).
    const ownBefore = [
      NestedService,
      MemoryStore,
      CycleAService,
      CycleBService,
    ].filter((c) => before.includes(c.name));
    expect(ownBefore.length).toBeGreaterThan(0);
    for (const c of ownBefore) expect(planOf(c)?.on).toBe(true);
    expect(planOf(NestrixCore)).toBeUndefined();
    expect(planOf(NestrixInterceptor)).toBeUndefined();
    expect(isWrapper(booted.app.get(NestrixCore).onApplicationShutdown)).toBe(
      false,
    );
  });

  it("a provider of a dynamic module (library-like) is switched off: its wrappers call straight through", async () => {
    // Decorated before NestrixCore (see the order above), so it carries disabled wrappers.
    const lib = booted.app.get(LibClient);
    expect(planOf(LibClient)?.on).toBe(false);
    expect(planOf(ConfigService)?.on).toBe(false);
    resetSpans();
    expect(lib.ping()).toBe("pong");
    expect(booted.app.get(ConfigService).get("NOPE", "fallback")).toBe(
      "fallback",
    );
    expect(methodSpans()).toEqual([]);
  });

  it("an off class decorated after the config is known gets no wrappers at all", async () => {
    @Injectable()
    class LateLibrary {
      m(): number {
        return 1;
      }
    }
    const late = new LateLibrary();
    NestrixInstrument.instanceDecorator(late);
    expect(Object.getOwnPropertyNames(late)).toEqual([]);
    expect(planOf(LateLibrary)?.on).toBe(false);
  });
});
