// Review F1: the direction of the mysql2/ioredis behaviour change in a default app
// (no uncaughtException / unhandledRejection handlers, default
// --unhandled-rejections=throw).
//   node scripts/crash-direction.mjs <ioredis|mysql2> <none|plain-start>
// Prints __CRASH__{"survived":true} if the process is still alive after the failure.
import dc from "node:diagnostics_channel";
import { Redis } from "ioredis";
import mysql from "mysql2";

const [lib, sub] = process.argv.slice(2);
const channel = lib === "ioredis" ? "ioredis:command" : "mysql2:query";
if (sub === "plain-start") dc.subscribe(`tracing:${channel}:start`, () => {});

const finish = (cleanup) =>
  setTimeout(() => {
    process.stdout.write(`__CRASH__${JSON.stringify({ survived: true })}\n`);
    cleanup();
  }, 1500);

if (lib === "ioredis") {
  const r = new Redis(process.env.REDIS_URL);
  r.once("ready", async () => {
    await r.set("nestrix:crash:str", "x");
    r.lpush("nestrix:crash:str", "y"); // WRONGTYPE, not awaited
    finish(() => r.disconnect());
  });
} else {
  const conn = mysql.createConnection({ uri: process.env.MYSQL_URL });
  conn.query("SELECT * FROM nestrix_missing_table"); // event-emitter mode, no 'error' listener
  finish(() => conn.destroy());
}
