// P7-02: the profiler core (src/profiler/) without HTTP. A fake `node:v8` drives the slot, the
// end timer, the buffer cap and every failure path; one test takes a real capture.
//
// Global state: the process-wide slot `Symbol.for("nestrix.profiler")`, reset after each test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostics } from "../src/diagnostics.js";
import {
  FLAME_MAX_DEPTH,
  normalizeProfile,
  normalizeUrl,
} from "../src/profiler/normalize.js";
import {
  bufferSizeFor,
  type CpuProfileHandleLike,
  getProfiler,
  PROFILE_LIMITS,
  Profiler,
  profilerRuntime,
  resetProfilerForTests,
  runningCapture,
  STALE_SLOT_GRACE_MS,
  type V8Like,
} from "../src/profiler/profiler.js";

const SLOT = Symbol.for("nestrix.profiler");
const realRuntime = { ...profilerRuntime };

/** A tiny but realistic profile: root → (program), (idle), main → hot (CommonJS path), main → cold. */
function sampleProfile(): string {
  return JSON.stringify({
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: 0,
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        hitCount: 0,
        children: [2, 3, 4],
      },
      {
        id: 2,
        callFrame: {
          functionName: "(program)",
          scriptId: 0,
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        hitCount: 1,
      },
      {
        id: 3,
        callFrame: {
          functionName: "(idle)",
          scriptId: 0,
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        hitCount: 5,
      },
      {
        id: 4,
        callFrame: {
          functionName: "main",
          scriptId: 12,
          url: "file:///app/main.mjs",
          lineNumber: 3,
          columnNumber: 0,
        },
        hitCount: 1,
        children: [5, 6],
      },
      {
        id: 5,
        callFrame: {
          functionName: "hot",
          scriptId: 13,
          url: "/app/hot.cjs",
          lineNumber: 9,
          columnNumber: 4,
        },
        hitCount: 6,
      },
      {
        id: 6,
        callFrame: {
          functionName: "",
          scriptId: 13,
          url: "/app/hot.cjs",
          lineNumber: 20,
          columnNumber: 0,
        },
        hitCount: 2,
      },
    ],
    startTime: 1_000_000,
    endTime: 1_015_000,
    samples: [5, 5, 5, 5, 5, 5, 6, 6, 4, 2, 3, 3, 3, 3, 3],
    timeDeltas: Array(15).fill(1000),
  });
}

interface FakeV8 extends V8Like {
  calls: { sampleInterval: number; maxBufferSize: number }[];
  disposed: number;
  stops: number;
}

function fakeV8(
  over: {
    start?: () => CpuProfileHandleLike;
    stop?: () => string | undefined;
  } = {},
): FakeV8 {
  const v8: FakeV8 = {
    calls: [],
    disposed: 0,
    stops: 0,
    startCpuProfile(options) {
      v8.calls.push(options);
      if (over.start) return over.start();
      return {
        stop: () => {
          v8.stops++;
          return over.stop ? over.stop() : sampleProfile();
        },
        [Symbol.dispose]: () => {
          v8.disposed++;
        },
      };
    },
  };
  return v8;
}

function recording(): Diagnostics & {
  logs: string[];
  failures: string[];
} {
  const logs: string[] = [];
  const failures: string[] = [];
  return {
    logs,
    failures,
    logOnce: (_key, message) => logs.push(message),
    countFailure: (where) => failures.push(where),
  };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  now = 1_700_000_000_000;
  profilerRuntime.now = () => now;
  profilerRuntime.defer = (work) => work();
});
afterEach(() => {
  resetProfilerForTests();
  Object.assign(profilerRuntime, realRuntime);
  vi.useRealTimers();
});

describe("buffer cap", () => {
  it("is one sample per millisecond of the duration plus 1,000", () => {
    expect(bufferSizeFor(30_000)).toBe(31_000);
    expect(bufferSizeFor(120_000)).toBe(121_000);
    expect(bufferSizeFor(1_000)).toBe(2_000);
  });

  it("is what startCpuProfile receives, at a 1 ms interval", () => {
    const v8 = fakeV8();
    profilerRuntime.loadV8 = () => v8;
    const p = new Profiler(recording());
    expect(p.start(45_000, {}).outcome).toBe("started");
    expect(v8.calls).toEqual([{ sampleInterval: 1, maxBufferSize: 46_000 }]);
  });
});

describe("nothing is loaded before the first capture", () => {
  it("does not load node:v8 for list, get, meta or download", () => {
    const load = vi.fn(() => fakeV8());
    profilerRuntime.loadV8 = load;
    const p = new Profiler(recording());
    p.list();
    p.get("0123456789abcdef");
    p.download("0123456789abcdef");
    p.meta(true);
    expect(load).not.toHaveBeenCalled();
    p.start(1000, {});
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("the process-wide slot", () => {
  it("lets one capture run per process, across profiler instances (package copies)", () => {
    profilerRuntime.loadV8 = () => fakeV8();
    const a = new Profiler(recording());
    const b = new Profiler(recording());
    const first = a.start(5000, {});
    expect(first.outcome).toBe("started");
    const second = b.start(5000, {});
    expect(second.outcome).toBe("busy");
    if (second.outcome === "busy" && first.outcome === "started") {
      expect(second.running).toEqual(first.running);
    }
    expect(a.start(5000, {}).outcome).toBe("busy");
    // The slot is on globalThis under the registered symbol, not enumerable.
    expect(Object.keys(globalThis)).not.toContain(String(SLOT));
    expect(
      (globalThis as unknown as Record<symbol, { running: unknown }>)[SLOT]
        ?.running,
    ).toEqual(runningCapture());
  });

  it("is freed when the capture ends, and the next start succeeds", () => {
    profilerRuntime.loadV8 = () => fakeV8();
    const a = new Profiler(recording());
    const b = new Profiler(recording());
    a.start(2000, {});
    vi.advanceTimersByTime(2000);
    expect(runningCapture()).toBeNull();
    expect(b.start(2000, {}).outcome).toBe("started");
  });

  it("reclaims a slot left behind by another copy long after its end", () => {
    profilerRuntime.loadV8 = () => fakeV8();
    getProfiler().list(); // creates the slot
    const s = (globalThis as unknown as Record<symbol, { running: unknown }>)[
      SLOT
    ] as { running: unknown };
    const p = new Profiler(recording());
    // Another copy's capture, ended a second ago: still within the grace, so busy.
    s.running = {
      id: "ffffffffffffffff",
      startedAtUnixMs: now - 2000,
      durationMs: 1000,
      endsAtUnixMs: now - 1000,
      startPauseMs: 1,
    };
    expect(p.start(1000, {}).outcome).toBe("busy");
    now += STALE_SLOT_GRACE_MS + 1000;
    expect(p.start(1000, {}).outcome).toBe("started");
  });
});

describe("the end timer", () => {
  it("is unref'd, stops after the duration, and keeps the profile", () => {
    const v8 = fakeV8();
    profilerRuntime.loadV8 = () => v8;
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      const t = realSetTimeout(fn, ms);
      const original = t.unref.bind(t);
      t.unref = () => {
        unref();
        return original();
      };
      return t;
    }) as typeof setTimeout);
    const p = new Profiler(recording());
    const r = p.start(3000, {});
    spy.mockRestore();
    expect(unref).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("started");
    vi.advanceTimersByTime(2999);
    expect(v8.stops).toBe(0);
    expect(p.list().running).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(v8.stops).toBe(1);
    const list = p.list();
    expect(list.running).toBeNull();
    expect(list.profiles).toHaveLength(1);
    expect(list.profiles[0]).toMatchObject({
      durationMs: 3000,
      samples: 15,
      actualDurationMs: 15,
    });
  });

  it("keeps only the last three profiles, newest first", () => {
    profilerRuntime.loadV8 = () => fakeV8();
    const p = new Profiler(recording());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = p.start(1000, {});
      if (r.outcome === "started") ids.push(r.running.id);
      vi.advanceTimersByTime(1000);
    }
    expect(p.list().profiles.map((s) => s.id)).toEqual(ids.slice(-3).reverse());
    expect(p.get(ids[0] as string)).toBeUndefined();
    expect(p.download(ids[4] as string)?.json).toContain('"scriptId":"13"');
    expect(PROFILE_LIMITS.kept).toBe(3);
  });

  it("discard() by the owner disposes the handle, frees the slot, keeps nothing", () => {
    const v8 = fakeV8();
    profilerRuntime.loadV8 = () => v8;
    const p = new Profiler(recording());
    const owner = {};
    p.start(5000, owner);
    p.discard({}); // not the owner: nothing happens
    expect(runningCapture()).not.toBeNull();
    p.discard(owner);
    expect(v8.disposed).toBe(1);
    expect(runningCapture()).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(v8.stops).toBe(0);
    expect(p.list().profiles).toHaveLength(0);
  });
});

describe("faults (rule 1): every call into V8 is guarded", () => {
  it("startCpuProfile throws: failed, slot free, logged once, shown in the list", () => {
    profilerRuntime.loadV8 = () =>
      fakeV8({
        start: () => {
          throw Object.assign(new Error("ERR_CPU_PROFILE_TOO_MANY"), {});
        },
      });
    const d = recording();
    const p = new Profiler(d);
    expect(p.start(1000, {})).toEqual({
      outcome: "failed",
      message: "ERR_CPU_PROFILE_TOO_MANY",
    });
    expect(runningCapture()).toBeNull();
    expect(p.list().lastError?.message).toBe("ERR_CPU_PROFILE_TOO_MANY");
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toContain("Nestrix profiler: a CPU capture failed");
  });

  it("stop() returns undefined: failure recorded, nothing kept", () => {
    profilerRuntime.loadV8 = () => fakeV8({ stop: () => undefined });
    const p = new Profiler(recording());
    p.start(1000, {});
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(runningCapture()).toBeNull();
    expect(p.list().profiles).toHaveLength(0);
    expect(p.list().lastError?.message).toContain("no profile");
  });

  it("stop() throws: failure recorded, slot free", () => {
    profilerRuntime.loadV8 = () =>
      fakeV8({
        stop: () => {
          throw new Error("stop boom");
        },
      });
    const p = new Profiler(recording());
    p.start(1000, {});
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(runningCapture()).toBeNull();
    expect(p.list().lastError?.message).toBe("stop boom");
  });

  it("an unreadable profile: failure recorded, nothing kept", () => {
    profilerRuntime.loadV8 = () => fakeV8({ stop: () => "{not json" });
    const p = new Profiler(recording());
    p.start(1000, {});
    vi.advanceTimersByTime(1000);
    expect(p.list().profiles).toHaveLength(0);
    expect(p.list().lastError).not.toBeNull();
  });

  it("dispose throws on discard: counted, never thrown", () => {
    profilerRuntime.loadV8 = () =>
      fakeV8({
        start: () => ({
          stop: () => sampleProfile(),
          [Symbol.dispose]: () => {
            throw new Error("dispose boom");
          },
        }),
      });
    const d = recording();
    const p = new Profiler(d);
    const owner = {};
    p.start(1000, owner);
    expect(() => p.discard(owner)).not.toThrow();
    expect(d.failures).toContain("profiler.discard");
    expect(runningCapture()).toBeNull();
  });

  it("node:v8 unavailable or loading throws: failed, never thrown", () => {
    profilerRuntime.loadV8 = () => undefined;
    expect(new Profiler(recording()).start(1000, {}).outcome).toBe("failed");
    profilerRuntime.loadV8 = () => {
      throw new Error("load boom");
    };
    expect(new Profiler(recording()).start(1000, {})).toEqual({
      outcome: "failed",
      message: "load boom",
    });
    expect(runningCapture()).toBeNull();
  });

  it("refuses durations outside 1 s to 120 s, or not whole milliseconds", () => {
    const v8 = fakeV8();
    profilerRuntime.loadV8 = () => v8;
    const p = new Profiler(recording());
    for (const ms of [0, 999, 120_001, 1500.5, Number.NaN]) {
      expect(p.start(ms, {}).outcome).toBe("failed");
    }
    expect(v8.calls).toHaveLength(0);
    expect(p.start(120_000, {}).outcome).toBe("started");
  });
});

describe("normalisation", () => {
  it("turns scriptId into a string and absolute paths into file:// URLs", () => {
    const n = normalizeProfile(sampleProfile());
    const parsed = JSON.parse(n.json) as {
      nodes: { callFrame: { scriptId: unknown; url: string } }[];
    };
    for (const node of parsed.nodes) {
      expect(typeof node.callFrame.scriptId).toBe("string");
    }
    expect(parsed.nodes[4]?.callFrame.url).toBe("file:///app/hot.cjs");
    expect(parsed.nodes[3]?.callFrame.url).toBe("file:///app/main.mjs");
    expect(n.samples).toBe(15);
    expect(n.actualDurationMs).toBe(15);
  });

  it("normalizeUrl keeps URLs and node: ids, converts POSIX and Windows paths", () => {
    expect(normalizeUrl("node:internal/timers")).toBe("node:internal/timers");
    expect(normalizeUrl("file:///a.js")).toBe("file:///a.js");
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl(undefined)).toBe("");
    expect(normalizeUrl("/srv/app/a b.js")).toBe("file:///srv/app/a%20b.js");
    expect(normalizeUrl("C:\\app\\x.js")).toMatch(/^file:\/\/\//);
  });

  it("ranks top functions by self time, with 1-based lines, without (idle) and (root)", () => {
    const { topFunctions } = normalizeProfile(sampleProfile());
    expect(topFunctions.map((f) => f.functionName)).toEqual([
      "hot",
      "(anonymous)",
      "main",
      "(program)",
    ]);
    expect(topFunctions[0]).toEqual({
      functionName: "hot",
      url: "file:///app/hot.cjs",
      line: 10,
      column: 5,
      selfSamples: 6,
      totalSamples: 6,
    });
    expect(topFunctions[2]).toMatchObject({ selfSamples: 1, totalSamples: 9 });
  });

  it("builds a flame tree without (idle), whose root counts non-idle samples", () => {
    const { flame } = normalizeProfile(sampleProfile());
    expect(flame.functionName).toBe("(root)");
    expect(flame.totalSamples).toBe(10);
    expect(flame.children.map((c) => c.functionName)).toEqual([
      "main",
      "(program)",
    ]);
    expect(flame.children[0]?.children.map((c) => c.functionName)).toEqual([
      "hot",
      "(anonymous)",
    ]);
  });

  it("counts a recursive function's total once per stack", () => {
    const frame = (name: string) => ({
      functionName: name,
      scriptId: 1,
      url: "file:///r.js",
      lineNumber: 0,
      columnNumber: 0,
    });
    const n = normalizeProfile(
      JSON.stringify({
        nodes: [
          { id: 1, callFrame: { ...frame("(root)"), url: "" }, children: [2] },
          { id: 2, callFrame: frame("rec"), children: [3] },
          { id: 3, callFrame: frame("rec"), children: [] },
        ],
        startTime: 0,
        endTime: 3000,
        samples: [2, 3, 3],
        timeDeltas: [1000, 1000, 1000],
      }),
    );
    expect(n.topFunctions[0]).toMatchObject({
      functionName: "rec",
      selfSamples: 3,
      totalSamples: 3,
    });
  });

  it("survives a cycle and a very deep stack (pruned at the depth limit)", () => {
    const deep = 400;
    const nodes = [];
    for (let i = 1; i <= deep; i++) {
      nodes.push({
        id: i,
        callFrame: {
          functionName: `f${i}`,
          scriptId: 1,
          url: "",
          lineNumber: i,
          columnNumber: 0,
        },
        children: i < deep ? [i + 1] : [1], // the last points back at the root
      });
    }
    const n = normalizeProfile(
      JSON.stringify({
        nodes,
        startTime: 0,
        endTime: 1,
        samples: [deep],
        timeDeltas: [1],
      }),
    );
    let depth = 0;
    let node = n.flame;
    while (node.children[0]) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBe(FLAME_MAX_DEPTH);
  });

  it("throws on JSON that is not a CPU profile (the caller catches)", () => {
    expect(() => normalizeProfile("{}")).toThrow();
    expect(() => normalizeProfile("[]")).toThrow();
  });
});

describe("a real capture (node:v8)", () => {
  it("returns a valid profile in node --cpu-prof's form", async () => {
    vi.useRealTimers();
    Object.assign(profilerRuntime, realRuntime);
    const p = new Profiler(recording());
    const r = p.start(1000, {});
    expect(r.outcome).toBe("started");
    if (r.outcome !== "started") return;
    expect(r.running.id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.running.startPauseMs).toBeGreaterThanOrEqual(0);
    const until = Date.now() + 1100;
    let x = 0;
    while (Date.now() < until) x += Math.sqrt(x + 1);
    expect(x).toBeGreaterThan(0);
    await vi.waitFor(() => expect(p.list().profiles).toHaveLength(1), {
      timeout: 3000,
    });
    const file = p.download(r.running.id);
    const profile = JSON.parse(file?.json ?? "{}") as {
      nodes: { id: number; callFrame: { scriptId: unknown; url: string } }[];
      samples: number[];
      timeDeltas: number[];
      startTime: number;
      endTime: number;
    };
    expect(Object.keys(profile).sort()).toEqual(
      ["endTime", "nodes", "samples", "startTime", "timeDeltas"].sort(),
    );
    expect(profile.samples.length).toBe(profile.timeDeltas.length);
    expect(profile.samples.length).toBeGreaterThan(100);
    const ids = new Set(profile.nodes.map((n) => n.id));
    expect(profile.samples.every((id) => ids.has(id))).toBe(true);
    for (const node of profile.nodes) {
      expect(typeof node.callFrame.scriptId).toBe("string");
      expect(node.callFrame.url).not.toMatch(/^\//);
    }
    expect(p.get(r.running.id)?.topFunctions.length).toBeGreaterThan(0);
  }, 10_000);
});
