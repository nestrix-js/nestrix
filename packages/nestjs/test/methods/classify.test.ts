// Class markers, roles and entry methods (backlog P3-02 "Method span shape"), checked against the
// installed @nestjs/schedule and @nestjs/bullmq (their key strings are written out in src because
// those packages must not be imported at runtime).
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Processor } from "@nestjs/bullmq";
import {
  type CallHandler,
  Catch,
  Controller,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Cron, Interval, Timeout } from "@nestjs/schedule";
import { describe, expect, it } from "vitest";
import {
  BULLMQ_PROCESSOR_METADATA,
  classKind,
  entryKind,
  isMarkedClass,
  isScheduledMethod,
  SCHEDULE_METADATA_KEYS,
} from "../../src/methods/classify.js";

const require = createRequire(import.meta.url);
function constants(pkg: string, file: string): Record<string, string> {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  const text = readFileSync(join(dir, "dist", file), "utf8");
  return Object.fromEntries(
    [...text.matchAll(/export const (\w+) = '([^']+)'/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

describe("metadata keys match the installed packages", () => {
  it("@nestjs/schedule", () => {
    const c = constants("@nestjs/schedule", "schedule.constants.js");
    expect(SCHEDULE_METADATA_KEYS).toEqual([
      c.SCHEDULER_TYPE,
      c.SCHEDULE_CRON_OPTIONS,
      c.SCHEDULE_INTERVAL_OPTIONS,
      c.SCHEDULE_TIMEOUT_OPTIONS,
    ]);
  });

  it("@nestjs/bullmq", () => {
    expect(BULLMQ_PROCESSOR_METADATA).toBe(
      constants("@nestjs/bullmq", "bull.constants.js").PROCESSOR_METADATA,
    );
  });
});

class Jobs {
  @Cron("* * * * * *")
  cron(): void {}
  @Interval(1000)
  interval(): void {}
  @Timeout(1000)
  timeout(): void {}
  plain(): void {}
}

@Processor("q")
class QueueProcessor {
  process(): void {}
  other(): void {}
}

describe("entry methods", () => {
  it("@Cron, @Interval and @Timeout are scheduled entries", () => {
    for (const m of ["cron", "interval", "timeout"] as const) {
      expect(isScheduledMethod(Jobs.prototype[m])).toBe(true);
      expect(entryKind("service", m, Jobs.prototype[m])).toBe("scheduled");
    }
    expect(entryKind("service", "plain", Jobs.prototype.plain)).toBeUndefined();
  });

  it("a processor's process is a job entry; its other methods are not", () => {
    expect(isMarkedClass(QueueProcessor)).toBe(true);
    const kind = classKind(
      QueueProcessor,
      QueueProcessor.prototype,
      "QueueProcessor",
    );
    expect(kind).toBe("processor");
    expect(entryKind(kind, "process", QueueProcessor.prototype.process)).toBe(
      "job",
    );
    expect(
      entryKind(kind, "other", QueueProcessor.prototype.other),
    ).toBeUndefined();
    // `process` on a non-processor is ordinary.
    expect(
      entryKind("service", "process", QueueProcessor.prototype.process),
    ).toBeUndefined();
  });
});

describe("class kind", () => {
  @Controller()
  class C {}
  @Catch()
  class F {
    catch(): void {}
  }
  @Injectable()
  class G {
    canActivate(): boolean {
      return true;
    }
  }
  @Injectable()
  class I implements NestInterceptor {
    intercept(_c: unknown, n: CallHandler) {
      return n.handle();
    }
  }
  @Injectable()
  class P {
    transform(v: unknown): unknown {
      return v;
    }
  }
  @Injectable()
  class UsersRepository {}
  @Injectable()
  class UsersService {}
  @Injectable()
  class Mailer {}
  class Thenable {
    catch(): void {}
    // biome-ignore lint/suspicious/noThenProperty: a thenable is not a filter
    then(): void {}
  }
  const kind = (c: { prototype: object; name: string }) =>
    classKind(c, c.prototype, c.name);

  it("by marker, then by the method Nest calls, then by name", () => {
    expect(kind(C)).toBe("controller");
    expect(kind(F)).toBe("filter");
    expect(kind(G)).toBe("guard");
    expect(kind(I)).toBe("interceptor");
    expect(kind(P)).toBe("pipe");
    expect(kind(UsersRepository)).toBe("repository");
    expect(kind(UsersService)).toBe("service");
    expect(kind(Mailer)).toBe("provider");
    expect(kind(Thenable)).toBe("provider");
  });

  it("markers: controller, injectable, filter and processor; not a plain class", () => {
    for (const c of [C, F, G, QueueProcessor])
      expect(isMarkedClass(c)).toBe(true);
    expect(isMarkedClass(Thenable)).toBe(false);
    expect(isMarkedClass(undefined)).toBe(false);
  });
});
