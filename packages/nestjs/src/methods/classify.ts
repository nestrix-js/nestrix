// What level 2 can learn about a class from the class alone: whether Nest marks it as a
// controller, injectable, exception filter or BullMQ processor, its role (backlog P3-02, "Method
// span shape"), and which of its methods are entry points (D-62).
//
// Nest's watermark keys come from `@nestjs/common`'s public `constants` entry. The keys of
// `@nestjs/schedule` and `@nestjs/bullmq` are written out: those packages are optional and must not
// be imported at runtime (`test/methods/classify.test.ts` checks the strings against the installed
// packages).
import "reflect-metadata";
import {
  CATCH_WATERMARK,
  CONTROLLER_WATERMARK,
  INJECTABLE_WATERMARK,
} from "@nestjs/common/constants.js";
import type { MethodClassKind } from "./sink.js";

/** `@nestjs/bullmq`'s `PROCESSOR_METADATA`, set on a `@Processor()` class. */
export const BULLMQ_PROCESSOR_METADATA = "bullmq:processor_metadata";

/**
 * `@nestjs/schedule` metadata keys set on a `@Cron`, `@Interval` or `@Timeout` method (on the
 * function itself, through `SetMetadata`). `SCHEDULER_TYPE` is set by all three; the options keys
 * are checked too in case a future version drops it.
 */
export const SCHEDULE_METADATA_KEYS: readonly string[] = [
  "SCHEDULER_TYPE",
  "SCHEDULE_CRON_OPTIONS",
  "SCHEDULE_INTERVAL_OPTIONS",
  "SCHEDULE_TIMEOUT_OPTIONS",
];

export type EntryKind = "scheduled" | "job";

const ENHANCER_KINDS: ReadonlySet<MethodClassKind> = new Set([
  "guard",
  "pipe",
  "interceptor",
  "filter",
]);

export function isEnhancerKind(
  kind: MethodClassKind,
): kind is "guard" | "pipe" | "interceptor" | "filter" {
  return ENHANCER_KINDS.has(kind);
}

function ownMeta(key: string, target: unknown): unknown {
  try {
    return typeof target === "function"
      ? Reflect.getMetadata(key, target)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the class carries a Nest or BullMQ class marker: `@Controller`, `@Injectable`, `@Catch`
 * or `@Processor`. Only such classes get wrappers before the own set is known (D-58).
 */
export function isMarkedClass(ctor: unknown): boolean {
  return (
    ownMeta(CONTROLLER_WATERMARK, ctor) === true ||
    ownMeta(INJECTABLE_WATERMARK, ctor) === true ||
    ownMeta(CATCH_WATERMARK, ctor) !== undefined ||
    ownMeta(BULLMQ_PROCESSOR_METADATA, ctor) !== undefined
  );
}

/**
 * Finds a method by name along the prototype chain, reading descriptors only, so no getter runs.
 * Returns undefined for an accessor or a non-function.
 */
function findMethod(proto: object, name: string): unknown {
  for (
    let o: object | null = proto;
    o && o !== Object.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return typeof d.value === "function" ? d.value : undefined;
  }
  return undefined;
}

/**
 * The role of a class, in the order of the backlog's method span shape: controller, processor,
 * enhancer (by the method Nest calls: `canActivate`, `transform`, `intercept`, `catch`), then by name.
 * Never throws: an unreadable class is a `provider`.
 */
export function classKind(
  ctor: unknown,
  proto: object,
  className: string,
): MethodClassKind {
  try {
    if (ownMeta(CONTROLLER_WATERMARK, ctor) === true) return "controller";
    if (ownMeta(BULLMQ_PROCESSOR_METADATA, ctor) !== undefined)
      return "processor";
    const has = (n: string) => findMethod(proto, n) !== undefined;
    if (
      ownMeta(CATCH_WATERMARK, ctor) !== undefined ||
      // A class with `catch` and `then` is a thenable, not a filter.
      (has("catch") && !has("then"))
    )
      return "filter";
    if (has("canActivate")) return "guard";
    if (has("intercept")) return "interceptor";
    if (has("transform")) return "pipe";
    if (className.endsWith("Repository")) return "repository";
    if (className.endsWith("Service")) return "service";
  } catch {
    // fall through
  }
  return "provider";
}

/** Whether `fn` carries `@nestjs/schedule` metadata. Never throws. */
export function isScheduledMethod(fn: unknown): boolean {
  try {
    if (typeof fn !== "function") return false;
    for (const key of SCHEDULE_METADATA_KEYS) {
      if (Reflect.getMetadata(key, fn) !== undefined) return true;
    }
  } catch {
    // not readable: not an entry method
  }
  return false;
}

/** The entry kind of a method (D-62), or undefined for an ordinary method. */
export function entryKind(
  kind: MethodClassKind,
  name: string,
  fn: unknown,
): EntryKind | undefined {
  if (isScheduledMethod(fn)) return "scheduled";
  if (kind === "processor" && name === "process") return "job";
  return undefined;
}
