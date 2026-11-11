// Run as a child process by test/q7-testing.test.ts: an HttpAdapterHost.init$
// subscriber that throws, with no uncaughtException handler. Prints whether the
// setter that emitted returned normally; the process is expected to die.
import "reflect-metadata";
import { HttpAdapterHost } from "@nestjs/core";

const host = new HttpAdapterHost();
host.init$.subscribe(() => {
  throw new Error("init$ subscriber threw");
});
try {
  host.httpAdapter = {};
  console.log("setter returned normally");
} catch (error) {
  console.log(`setter threw: ${error.message}`);
}
setTimeout(() => console.log("still alive after 100 ms"), 100);
