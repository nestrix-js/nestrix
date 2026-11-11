// Child process for process-errors.test.ts. Loads the built @nestrix/nestjs (dist), boots an
// application context with NestrixModule.forRoot(), prints the process listener counts, then
// raises the error named by argv[2]. With NO_NESTRIX=1 it skips Nestrix (the control).
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const mode = process.argv[2];
const imports = [];
if (process.env.NO_NESTRIX !== "1") {
  const { NestrixModule } = await import("../../dist/index.js");
  imports.push(NestrixModule.forRoot({ export: { otlp: false } }));
}
class App {}
Module({ imports })(App);
await NestFactory.createApplicationContext(App, { logger: false });

console.log(
  JSON.stringify({
    uncaughtExceptionMonitor: process.listenerCount("uncaughtExceptionMonitor"),
    uncaughtException: process.listenerCount("uncaughtException"),
    unhandledRejection: process.listenerCount("unhandledRejection"),
  }),
);
if (mode === "rejection") void Promise.reject(new Error("unhandled in child"));
if (mode === "throw") {
  setTimeout(() => {
    throw new Error("uncaught in child");
  });
}
setTimeout(() => console.log("STILL ALIVE"), 500);
