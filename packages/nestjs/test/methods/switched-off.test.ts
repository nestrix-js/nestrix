// Issue #41, D-99: with Nestrix switched off, `NestrixInstrument` leaves every instance untouched
// (no own wrapper properties), and the package entry does not load the OpenTelemetry SDK, the
// exporters or the dashboard.
//
// The registry counts `NestrixModule` definitions per process (here: per test file, Vitest
// isolates files), so the order of the blocks matters: the fault test runs before any module is
// defined, and no module that can turn Nestrix on is defined until the last block (the control).
import "reflect-metadata";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type Type,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NestrixCore } from "../../src/core.js";
import {
  NestrixInstrument,
  nestrixInstrumentIf,
} from "../../src/methods/instrument.js";
import {
  nestrixInstanceDecorator,
  resetMethodsForTests,
} from "../../src/methods/registry.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import { NESTRIX_RUNTIME } from "../../src/tokens.js";
import { startReceiver } from "../otel-helpers.js";
import { ADAPTERS, BASE_OPTIONS, bootInstrumented } from "./helpers.js";

const pkgDir = fileURLToPath(new URL("../..", import.meta.url));

@Injectable()
class OffService {
  greet(): string {
    return "hi";
  }
  other(): number {
    return 1;
  }
}

@Controller("off")
class OffController {
  constructor(@Inject(OffService) private readonly service: OffService) {}
  @Get()
  get(): string {
    return this.service.greet();
  }
  @Get("x")
  x(): string {
    return "x";
  }
}

function appWith(nestrix: unknown[]): Type {
  @Module({
    imports: nestrix as never[],
    controllers: [OffController],
    providers: [OffService],
  })
  class App {}
  return App;
}

/** Own property names of the controller and the service of a booted app. */
async function ownNames(
  adapter: (typeof ADAPTERS)[number],
  module: Type,
  instrument?: { instanceDecorator: (i: unknown) => unknown },
): Promise<{ controller: string[]; service: string[] }> {
  const booted = await bootInstrumented(adapter, module, instrument);
  try {
    expect((await booted.get("/off")).body).toBe("hi");
    return {
      controller: Object.getOwnPropertyNames(booted.app.get(OffController)),
      service: Object.getOwnPropertyNames(booted.app.get(OffService)),
    };
  } finally {
    await booted.close();
  }
}

const savedEnv = process.env.NESTRIX_ENABLED;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NESTRIX_ENABLED;
  else process.env.NESTRIX_ENABLED = savedEnv;
  resetMethodsForTests();
});

describe("fault injection (rule 1)", () => {
  it("a decorator call that cannot read process.env still returns the instance (rule 1)", () => {
    const saved = Object.getOwnPropertyDescriptor(process, "env");
    // No module is defined yet, so the decorator reads the environment: make that read throw.
    const instance = new OffService();
    Object.defineProperty(process, "env", {
      configurable: true,
      get() {
        throw new Error("env fault");
      },
    });
    try {
      expect(nestrixInstanceDecorator(instance)).toBe(instance);
    } finally {
      if (saved) Object.defineProperty(process, "env", saved);
    }
  });
});

describe("before any NestrixModule is defined: the environment alone decides", () => {
  it("NestrixInstrument without a module, NESTRIX_ENABLED unset: (switched-off) wrappers, as before", async () => {
    delete process.env.NESTRIX_ENABLED;
    const names = await ownNames("express", appWith([]), NestrixInstrument);
    expect(names.service).toEqual(expect.arrayContaining(["greet", "other"]));
  });

  it("NestrixInstrument without a module, NESTRIX_ENABLED=false: instances untouched", async () => {
    process.env.NESTRIX_ENABLED = "FALSE";
    const plain = await ownNames("express", appWith([]));
    const off = await ownNames("express", appWith([]), NestrixInstrument);
    expect(off).toEqual(plain);
  });
});

describe("NESTRIX_ENABLED=false (#41)", () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter}: NestrixInstrument adds no own properties; instances match a plain app`, async () => {
      process.env.NESTRIX_ENABLED = "false";
      const plain = await ownNames(adapter, appWith([]));
      const off = await ownNames(
        adapter,
        appWith([NestrixModule.forRoot(BASE_OPTIONS)]),
        NestrixInstrument,
      );
      expect(off).toEqual(plain);
      // The controller keeps only its injected field; no wrapper names.
      expect(off.controller).not.toContain("get");
      expect(off.service).not.toContain("greet");
    });
  }

  it("forRootAsync under NESTRIX_ENABLED=false: instances untouched too", async () => {
    process.env.NESTRIX_ENABLED = "0";
    const plain = await ownNames("node", appWith([]));
    const off = await ownNames(
      "node",
      appWith([NestrixModule.forRootAsync({ useFactory: () => BASE_OPTIONS })]),
      NestrixInstrument,
    );
    expect(off).toEqual(plain);
  });
});

describe("forRoot({ enabled: false }) (#41)", () => {
  it("only disabled modules defined: NestrixInstrument adds no own properties", async () => {
    const plain = await ownNames("express", appWith([]));
    const off = await ownNames(
      "express",
      appWith([NestrixModule.forRoot({ ...BASE_OPTIONS, enabled: false })]),
      NestrixInstrument,
    );
    expect(off).toEqual(plain);
  });

  it("nestrixInstrumentIf: the instrument when true, undefined when false", () => {
    expect(nestrixInstrumentIf(true)).toBe(NestrixInstrument);
    expect(nestrixInstrumentIf(false)).toBeUndefined();
  });
});

describe("the package entry with NESTRIX_ENABLED=false (#41)", () => {
  beforeAll(() => {
    // Nestrix from `dist`, current with `src` (incremental; a no-op when already built).
    const tsc = createRequire(join(pkgDir, "../../package.json")).resolve(
      "typescript/bin/tsc",
    );
    execFileSync(process.execPath, [tsc, "-b"], { cwd: pkgDir });
  });

  const script = (entry: string) => `
    const { registerHooks } = await import("node:module");
    const seen = new Set();
    registerHooks({ load(u, c, next) { seen.add(u); return next(u, c); } });
    await import(${JSON.stringify(entry)});
    const pkgs = new Set();
    for (const u of seen) {
      const m = /node_modules\\/(@opentelemetry\\/[^/]+)/.exec(u);
      if (m) pkgs.add(m[1]);
      if (/\\/dist\\/(runtime|otel\\/setup|dashboard\\/mount)\\.js$/.test(u)) pkgs.add(u.replace(/.*\\/dist\\//, "dist/"));
    }
    process.stdout.write(JSON.stringify([...pkgs].sort()));`;

  it("loads @opentelemetry/api and semantic-conventions only: no SDK, exporter or dashboard code", () => {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script(join(pkgDir, "dist", "index.js"))],
      {
        cwd: pkgDir,
        encoding: "utf8",
        env: { ...process.env, NESTRIX_ENABLED: "false" },
      },
    );
    expect(JSON.parse(out)).toEqual([
      "@opentelemetry/api",
      "@opentelemetry/semantic-conventions",
    ]);
  });

  it("still loads from CommonJS with require() (rule 4)", () => {
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const m = require(${JSON.stringify(join(pkgDir, "dist", "index.js"))}); process.stdout.write(typeof m.nestrixInstrumentIf + " " + typeof m.NestrixModule);`,
      ],
      {
        cwd: pkgDir,
        encoding: "utf8",
        env: { ...process.env, NESTRIX_ENABLED: "false" },
      },
    );
    expect(out).toBe("function function");
  });
});

describe("enabled, with the runtime loaded lazily (D-99)", () => {
  for (const mode of ["forRoot", "async"] as const) {
    it(`CommonJS app, ${mode}: Nestrix owns the provider and the first request's spans are exported`, async () => {
      const receiver = await startReceiver();
      try {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            join(pkgDir, "test", "fixtures", "lazy-runtime-app.cjs"),
            receiver.url.replace(/\/v1\/traces$/, ""),
            mode,
          ],
          { cwd: pkgDir, env: { ...process.env, NESTRIX_ENABLED: "" } },
        );
        expect(JSON.parse(stdout)).toEqual({ status: 200, body: "hello" });
        const spans = await receiver.waitForSpans(1);
        const server = spans.find((s) => s.name === "GET /hello");
        expect(server, spans.map((s) => s.name).join(", ")).toBeDefined();
        // Level 2 is on too: the controller and service methods are children of the request.
        const names = spans.map((s) => s.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "HelloController.hello",
            "HelloService.greet",
          ]),
        );
        for (const s of spans) expect(s.traceId).toBe(server?.traceId);
      } finally {
        await receiver.close();
      }
    });
  }
});

describe("the runtime module fails to load (D-99, rule 1)", () => {
  it("CommonJS app with a load hook that throws for dist/runtime.js: boots, serves, logs the failure at error level", async () => {
    const receiver = await startReceiver();
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          pathToFileURL(
            join(pkgDir, "test", "fixtures", "fail-runtime-hook.mjs"),
          ).href,
          join(pkgDir, "test", "fixtures", "lazy-runtime-app.cjs"),
          receiver.url.replace(/\/v1\/traces$/, ""),
          "forRoot",
          "log",
        ],
        {
          cwd: pkgDir,
          env: { ...process.env, NESTRIX_ENABLED: "", NO_COLOR: "1" },
        },
      );
      const lines = stdout.trim().split("\n");
      expect(JSON.parse(lines[lines.length - 1] as string)).toEqual({
        status: 200,
        body: "hello",
      });
      const output = `${stdout}\n${stderr}`;
      // Visible with `logger: ['error', 'warn']`: both lines are error level.
      expect(output).toContain('"core.runtime-load"');
      expect(output).toContain("injected: dist/runtime.js failed to load");
      expect(output).toContain(
        "Nestrix could not load its OpenTelemetry setup",
      );
      expect(output).toMatch(
        /ERROR \[Nestrix\] Nestrix could not load its runtime module \("core\.runtime-load"\)/,
      );
      expect(output).toMatch(
        /ERROR \[Nestrix\] Nestrix could not load its OpenTelemetry setup/,
      );
      // Nothing was set up, so nothing is exported.
      expect(receiver.posts).toBe(0);
    } finally {
      await receiver.close();
    }
  });
});

// Last: defines an enabled module, which switches the "only disabled modules" rule off for the
// rest of this file.
describe("control: an enabled module still gets wrappers", () => {
  it("own wrapper properties are present with NestrixInstrument and forRoot(BASE_OPTIONS)", async () => {
    const on = await ownNames(
      "express",
      appWith([NestrixModule.forRoot(BASE_OPTIONS)]),
      NestrixInstrument,
    );
    expect(on.controller).toEqual(expect.arrayContaining(["get", "x"]));
    expect(on.service).toEqual(expect.arrayContaining(["greet", "other"]));
  });

  it("the runtime failed to load (NESTRIX_RUNTIME resolves to undefined): the app boots and serves; Nestrix is inert (rule 1)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [appWith([NestrixModule.forRoot(BASE_OPTIONS)])],
    })
      .overrideProvider(NESTRIX_RUNTIME)
      .useValue(undefined)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    try {
      const { port } = app.getHttpServer().address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/off`);
      expect(await res.text()).toBe("hi");
      const core = app.get(NestrixCore, { strict: false });
      expect(core.telemetry).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
