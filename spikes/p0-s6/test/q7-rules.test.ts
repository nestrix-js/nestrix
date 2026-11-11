// Q7 evidence: what each candidate default rule wraps in the fixture app, and what it costs in spans
// at boot and per request.
import "reflect-metadata";
import { WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import {
  DiscoveryService,
  ModuleRef,
  NestFactory,
  Reflector,
} from "@nestjs/core";
import { ScheduleExplorer, SchedulerRegistry } from "@nestjs/schedule";
import { context as otelContext, trace } from "@opentelemetry/api";
import { afterAll, describe, expect, it } from "vitest";
import { AppModule, ScheduleFixtureModule } from "../src/app/fixtures.ts";
import { boot } from "../src/boot.ts";
import { classify, ruleEverything, ruleMarkers } from "../src/rules.ts";
import { setupTracing } from "../src/tracing.ts";
import {
  type ClassInfo,
  createInstanceDecorator,
  type Fn,
  type WrapOptions,
} from "../src/wrap.ts";

const exporter = setupTracing();
const HTTP_SPAN = "HTTP request (stand-in)";

/** Framework classes reachable by identity through public exports. Not exhaustive by construction. */
const DENYLIST = new Set<unknown>([
  ConfigService,
  DiscoveryService,
  ModuleRef,
  Reflector,
  SchedulerRegistry,
  ScheduleExplorer,
]);

const ruleProposed = (info: ClassInfo) => {
  if (DENYLIST.has(info.ctor)) return false;
  const c = classify(info.instance);
  if (c.controller) return true;
  if (info.instance instanceof WorkerHost) return true; // @Processor carries no @Injectable watermark
  return c.injectable && c.role === "provider";
};

/** Entry points that may start a trace of their own: scheduled jobs and queue processors. */
const isEntryMethod = (name: string, fn: Fn, proto: object) =>
  Reflect.getMetadata("SCHEDULER_TYPE", fn) !== undefined ||
  Reflect.getMetadata("bullmq:worker_events_metadata", fn) !== undefined ||
  (name === "process" && proto instanceof WorkerHost);

const RULES: Record<
  string,
  { rule: (info: ClassInfo) => boolean; extra?: Partial<WrapOptions> }
> = {
  everything: { rule: ruleEverything },
  markers: { rule: ruleMarkers },
  proposed: { rule: ruleProposed },
  "proposed, child-only, entry roots": {
    rule: ruleProposed,
    extra: { childOnly: true, isEntryMethod },
  },
};
const report: string[] = [];

describe("Q7 candidate rules", () => {
  for (const [name, { rule, extra }] of Object.entries(RULES)) {
    it(`${name}`, async () => {
      const wrapped = new Set<string>();
      const decorator = createInstanceDecorator({
        strategy: "own",
        ...extra,
        shouldWrapClass: (info) => {
          const yes = rule(info);
          if (yes) wrapped.add((info.ctor as { name?: string })?.name ?? "?");
          return yes;
        },
      });
      exporter.reset();
      const b = await boot("express", AppModule, {
        instanceDecorator: decorator,
        // Stand-in for Nestrix's HTTP server span: the parent that child-only method spans need.
        configure: (app) =>
          app.use(
            (
              _req: unknown,
              res: { on(e: string, f: () => void): void },
              next: () => void,
            ) => {
              const span = trace.getTracer("http").startSpan(HTTP_SPAN);
              res.on("close", () => span.end());
              otelContext.with(trace.setSpan(otelContext.active(), span), next);
            },
          ),
      });
      const names = () =>
        exporter
          .getFinishedSpans()
          .map((s) => s.name)
          .filter((n) => n !== HTTP_SPAN);
      try {
        const bootSpans = names();
        exporter.reset();
        expect((await b.get("/users/7/async")).status).toBe(200);
        const req = names();
        exporter.reset();
        expect((await b.get("/users/db")).status).toBe(200);
        const db = names();

        exporter.reset();
        const sched = await NestFactory.createApplicationContext(
          ScheduleFixtureModule,
          {
            logger: false,
            abortOnError: false,
            instrument: { instanceDecorator: decorator },
          },
        );
        await sched.init();
        await new Promise((r) => setTimeout(r, 120));
        await sched.close();
        const all = exporter.getFinishedSpans().map((s) => s.name);
        const schedBoot = all.filter((n) => !n.startsWith("TickService."));
        const ticks = all.filter((n) => n === "TickService.tick").length;

        report.push(
          `#### ${name}\n\nclasses wrapped (${wrapped.size}): ${[...wrapped].sort().join(", ")}\n\n` +
            `spans during AppModule boot: ${bootSpans.length} ${JSON.stringify([...new Set(bootSpans)])}\n\n` +
            `spans during ScheduleModule boot and shutdown (excluding TickService): ${schedBoot.length} ${JSON.stringify([...new Set(schedBoot)])}\n\n` +
            `TickService.tick spans in 120 ms (@Interval 20 ms, root spans): ${ticks}\n\n` +
            `GET /users/7/async: ${req.length} spans ${JSON.stringify(req)}\n\n` +
            `GET /users/db: ${db.length} spans ${JSON.stringify(db)}\n`,
        );
        expect(bootSpans.length === 0).toBe(name.startsWith("proposed"));
        if (name.startsWith("proposed")) {
          expect(req).toEqual([
            "TransientService.which",
            "UsersService.find",
            "UsersService.findAsync",
            "UsersController.findAsync",
          ]);
        }
      } finally {
        await b.close();
      }
    });
  }

  afterAll(() => {
    console.log(
      `\n### Q7 rule comparison (express, strategy own)\n\n${report.join("\n")}`,
    );
  });
});
