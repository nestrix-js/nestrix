// Q2 follow-up: does a concurrent capture at 1 ms change the sampling rate of another profiler
// that asked for 10 ms? Profiler A (an in-process Session, like an APM agent, or a second v8
// handle) runs throughout; the work runs in three phases, each in its own function: A alone,
// A plus a v8 capture at 1 ms, A alone again. A's samples are counted per phase by the phase
// function on their stack.
//
//   node probes/q2-crosstalk.mjs [session|v8]
import { Session } from "node:inspector/promises";
import v8 from "node:v8";
import { esmHotLoop } from "../fixtures/hot.mjs";

const kind = process.argv[2] ?? "session";
const PHASE_MS = 600;

function phaseAlone() {
  esmHotLoop(PHASE_MS);
}
function phaseBoth() {
  esmHotLoop(PHASE_MS);
}
function phaseAfter() {
  esmHotLoop(PHASE_MS);
}

esmHotLoop(200);

let stopA;
if (kind === "session") {
  const s = new Session();
  s.connect();
  await s.post("Profiler.enable");
  await s.post("Profiler.setSamplingInterval", { interval: 10000 });
  await s.post("Profiler.start");
  stopA = async () => (await s.post("Profiler.stop")).profile;
} else {
  const h = v8.startCpuProfile({ sampleInterval: 10 });
  stopA = async () => JSON.parse(h.stop());
}

phaseAlone();
const ours = v8.startCpuProfile({ sampleInterval: 1 });
phaseBoth();
const oursProfile = JSON.parse(ours.stop());
phaseAfter();
const a = await stopA();

function perPhase(profile) {
  const parent = new Map();
  for (const n of profile.nodes)
    for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const phaseOf = (id) => {
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const name = byId.get(cur).callFrame.functionName;
      if (name.startsWith("phase")) return name;
    }
    return "other";
  };
  const counts = {};
  for (const s of profile.samples) {
    const p = phaseOf(s);
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}

console.log(
  JSON.stringify({
    kind,
    phaseMs: PHASE_MS,
    profilerA_10ms: perPhase(a),
    ours_1ms: perPhase(oursProfile),
  }),
);
