import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spikeAppFor } from "../src/app-for.js";
import { ADAPTERS, type Booted, boot, NEST_LABEL } from "../src/boot.js";
import {
  hookConfig,
  observations,
  resetHookConfig,
  resetObservations,
} from "../src/probe.js";

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetHookConfig();
  resetObservations();
});

async function probeRequest(probe: string) {
  if (!booted) throw new Error("not booted");
  const res = await fetch(`${booted.baseUrl}/users/7`, {
    headers: { "x-probe": probe },
  });
  await res.arrayBuffer();
  await new Promise((r) => setTimeout(r, 30));
  return {
    status: res.status,
    hook: observations.some((o) => o.point === "hook" && o.probe === probe),
    route:
      observations.find((o) => o.point === "route" && o.storeProbe === probe)
        ?.data?.path ?? null,
    guardSawStore:
      observations.find((o) => o.point === "guard:global" && o.probe === probe)
        ?.storeProbe === probe,
  };
}

function lifecycle() {
  return observations
    .filter((o) =>
      ["ctor", "init$", "installed", "onModuleInit", "install-error"].includes(
        o.point,
      ),
    )
    .map((o) => `${o.point} ${JSON.stringify(o.data)}`);
}

describe.each(ADAPTERS)(
  `Q7 @nestjs/testing [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("NestFactory.create (reference): the adapter is there at construction", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const steps = lifecycle();
      const req = await probeRequest("nf");
      console.log(
        `[${adapter}] NestFactory.create`,
        JSON.stringify({ steps, req }, null, 1),
      );
      expect(observations.find((o) => o.point === "ctor")?.data?.adapter).toBe(
        adapter,
      );
      expect(observations.find((o) => o.point === "installed")?.data?.at).toBe(
        "ctor",
      );
      expect(req).toEqual({
        status: 200,
        hook: true,
        route: "/users/:id",
        guardSawStore: true,
      });
    });

    it("testing module: undefined at construction; HttpAdapterHost.init$ fires in createNestApplication, before routes are registered", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter), {
        testing: true,
      });
      const steps = lifecycle();
      const req = await probeRequest("tm");
      console.log(
        `[${adapter}] testing, ctor-or-init$`,
        JSON.stringify({ steps, req }, null, 1),
      );
      const ctor = observations.find((o) => o.point === "ctor");
      const init = observations.find((o) => o.point === "init$");
      const installed = observations.find((o) => o.point === "installed");
      const onInit = observations.find((o) => o.point === "onModuleInit");
      expect(ctor?.data?.adapter).toBe("undefined");
      expect(init?.data?.adapter).toBe(adapter);
      expect(installed?.data?.at).toBe("init$");
      // init$ fires before onModuleInit (createNestApplication runs before init())
      expect(init && onInit && init.seq < onInit.seq).toBe(true);
      // the route hook fires, so routes were registered after it was set
      expect(req).toEqual({
        status: 200,
        hook: true,
        route: "/users/:id",
        guardSawStore: true,
      });
    });

    it("testing module, constructor only (no fallback): nothing is installed", async () => {
      hookConfig.installAt = "ctor-only";
      booted = await boot(adapter, await spikeAppFor(adapter), {
        testing: true,
      });
      const req = await probeRequest("co");
      console.log(
        `[${adapter}] testing, ctor-only`,
        JSON.stringify({ steps: lifecycle(), req }, null, 1),
      );
      expect(observations.some((o) => o.point === "installed")).toBe(false);
      expect(req).toEqual({
        status: 200,
        hook: false,
        route: null,
        guardSawStore: false,
      });
    });

    it.each([false, true])(
      "set in onModuleInit (testing=%s): the request hook works, the route hook is too late",
      async (testing) => {
        hookConfig.installAt = "onModuleInit";
        booted = await boot(adapter, await spikeAppFor(adapter), { testing });
        const req = await probeRequest(`omi-${testing}`);
        console.log(
          `[${adapter}] onModuleInit testing=${testing}`,
          JSON.stringify({ steps: lifecycle(), req }, null, 1),
        );
        expect(
          observations.find((o) => o.point === "installed")?.data?.at,
        ).toBe("onModuleInit");
        expect(req).toEqual({
          status: 200,
          hook: true,
          route: null,
          guardSawStore: true,
        });
      },
    );
    it("testing module: a fault inside the wrapped init$ subscriber leaves the app and the hooks working", async () => {
      hookConfig.initSubscriberFault = true;
      booted = await boot(adapter, await spikeAppFor(adapter), {
        testing: true,
      });
      const req = await probeRequest("fault");
      expect(observations.some((o) => o.point === "init$:fault")).toBe(true);
      expect(req).toEqual({
        status: 200,
        hook: true,
        route: "/users/:id",
        guardSawStore: true,
      });
    });
  },
);

describe(`Q7 an init$ subscriber that throws, unwrapped [Nest 12.4.2, child process]`, () => {
  it("is rethrown by rxjs as an uncaughtException that kills the process; the setter returns normally", () => {
    const script = fileURLToPath(
      new URL("../scripts/init-subscriber-throws.mjs", import.meta.url),
    );
    const run = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 10_000,
    });
    console.log(
      "child",
      JSON.stringify(
        {
          status: run.status,
          stdout: run.stdout,
          stderr: run.stderr.split("\n").slice(0, 6),
        },
        null,
        1,
      ),
    );
    expect(run.stdout).toContain("setter returned normally");
    expect(run.stdout).not.toContain("still alive");
    expect(run.stderr).toContain("init$ subscriber threw");
    expect(run.status).toBe(1);
  });
});
