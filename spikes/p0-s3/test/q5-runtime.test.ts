// Q5 runtime, against hosts installed by scripts/q5-install.sh (needs the network, so
// not part of a plain `pnpm test`): S3_Q5_DIR=<dir given to q5-install.sh>.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE, SPIKE_DIR } from "./helpers.ts";

const DIR = process.env.S3_Q5_DIR;
const ready = !!DIR && existsSync(join(DIR, "host-npm-designed"));

function run(host: string, which: string) {
  const out = execFileSync(
    NODE,
    [
      join(SPIKE_DIR, "scripts/q5-runtime.mjs"),
      join(DIR as string, host),
      which,
    ],
    {
      cwd: SPIKE_DIR,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
    },
  );
  const m = out.match(/RESULT (.*)\n/);
  if (!m) throw new Error(out);
  const r = JSON.parse(m[1]);
  console.log(`[Q5 ${host} ${which} node ${r.node}]`, JSON.stringify(r));
  return r;
}

describe.skipIf(!ready)("Q5: SDK 2.x host at runtime (S3_Q5_DIR)", () => {
  for (const host of ["host-npm-designed", "host-pnpm-designed"]) {
    it(`${host}: one api 1.9.1; Nestrix's spans reach the host's SDK 2 provider`, () => {
      const r = run(host, "host-sdk2");
      expect(r.hostApi).toBe("@opentelemetry/api@1.9.1");
      expect(r.nestrixApi).toBe("@opentelemetry/api@1.9.1");
      expect(r.sdk3).toBe("@opentelemetry/sdk-trace@3.1.1");
      expect(r.nestrixSetGlobalTracerProvider).toBe(false);
      expect(r.childParentMatches).toBe(true);
      expect(r.hostExporterSpans).toEqual(["child", "server"]);
    });

    it(`${host}: a Nestrix-owned api 1.10 next to a host 1.9 global fails silently`, () => {
      for (const which of ["mixed-api", "mixed-api-diag-only"]) {
        const r = run(host, which);
        expect(r.nestrixApi).toBe("@opentelemetry/api@1.10.0");
        expect(r.nestrixSees).toEqual({
          contextManager: false,
          propagatorFields: [],
        });
        expect(r.nestrixSetGlobalTracerProvider).toBe(false);
        expect(r.parentSpanValid).toBe(false);
        expect(r.nestrixExporterSpans).toEqual([]);
        expect(r.diag).toEqual([]);
      }
    });

    it(`${host}: reverse: Nestrix's api 1.10 registering first breaks the 1.9 host silently`, () => {
      const r = run(host, "reverse-cm");
      expect(r).toMatchObject({
        hostApi: "@opentelemetry/api@1.9.1",
        nestrixApi: "@opentelemetry/api@1.10.0",
        nxCm: true,
        diagSet: false,
        hostSpanValid: false,
        hostExported: [],
        diag: [],
      });
    });
  }
});

it.skipIf(ready)(
  "Q5 runtime skipped: set S3_Q5_DIR (see scripts/q5-install.sh)",
  () => {},
);
