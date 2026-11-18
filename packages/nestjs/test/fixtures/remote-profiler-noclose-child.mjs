// Child process for profiler-remote-exit.test.ts (finding 3): the poller against a server that
// never answers, with no app.close() and no stop(). The host's own work ends after argv[3] ms; the
// process must then exit by itself, the check-in in flight notwithstanding. With argv[4] "stdin"
// the host's work ends when the parent writes a line on stdin instead of after argv[3] ms.
import { RemoteProfilerPoller } from "../../dist/profiler/remote.js";

const [url, waitMs, mode] = process.argv.slice(2);
const poller = new RemoteProfilerPoller({
  target: { baseUrl: url, headers: {}, timeoutMillis: 10_000 },
  identity: {
    service: "s",
    instanceId: "i",
    version: undefined,
    host: undefined,
  },
  diagnostics: { countFailure() {}, logOnce() {} },
  log: () => {},
  timing: { firstMinMs: 10, firstMaxMs: 10 },
});
poller.start();
const done = () =>
  process.stdout.write(`${JSON.stringify({ hostWorkDone: true })}\n`);
if (mode === "stdin") {
  process.stdin.once("data", () => {
    process.stdin.pause();
    done();
  });
} else {
  setTimeout(done, Number(waitMs));
}
