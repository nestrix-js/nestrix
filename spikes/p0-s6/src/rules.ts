// What the instance decorator can learn about a value from the value alone, and candidate default
// rules for open decision O-3. Watermark keys are the string constants from @nestjs/common
// (`INJECTABLE_WATERMARK`, `CONTROLLER_WATERMARK`, `CATCH_WATERMARK`), written out so this file
// imports nothing from Nest internals.
import "reflect-metadata";
import type { ClassInfo } from "./wrap.ts";

export const INJECTABLE = "__injectable__";
export const CONTROLLER = "__controller__";
export const CATCH = "__catch__";

function meta(key: string, target: unknown): unknown {
  try {
    return typeof target === "function"
      ? Reflect.getMetadata(key, target)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface Classified {
  kind: string; // typeof
  ctorName: string;
  isClassInstance: boolean; // prototype is neither null nor Object.prototype
  controller: boolean;
  injectable: boolean;
  catch: boolean;
  /** Duck-typed role, from method names on the prototype chain. */
  role:
    | "controller"
    | "guard"
    | "interceptor"
    | "pipe"
    | "filter"
    | "middleware"
    | "provider"
    | "function"
    | "plain"
    | "primitive";
}

export function classify(value: unknown): Classified {
  const kind = value === null ? "null" : typeof value;
  if (typeof value === "function") {
    return {
      kind,
      ctorName: value.name || "(anonymous fn)",
      isClassInstance: false,
      controller: false,
      injectable: false,
      catch: false,
      role: "function",
    };
  }
  if (value === null || typeof value !== "object") {
    return {
      kind,
      ctorName: "-",
      isClassInstance: false,
      controller: false,
      injectable: false,
      catch: false,
      role: "primitive",
    };
  }
  const proto = Object.getPrototypeOf(value) as Record<string, unknown> | null;
  let ctor: { name?: unknown } | undefined;
  for (let o: object | null = proto; o && !ctor; o = Object.getPrototypeOf(o)) {
    ctor = Object.getOwnPropertyDescriptor(o, "constructor")?.value;
  }
  const isClassInstance = proto !== null && proto !== Object.prototype;
  const controller = meta(CONTROLLER, ctor) === true;
  const injectable = meta(INJECTABLE, ctor) === true;
  const isCatch = meta(CATCH, ctor) !== undefined;
  // Read data-property descriptors along the chain, never the properties themselves, so no getter runs.
  const method = (n: string): ((...a: unknown[]) => unknown) | undefined => {
    for (
      let o: object | null = value;
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o)
    ) {
      const d = Object.getOwnPropertyDescriptor(o, n);
      if (d) return typeof d.value === "function" ? d.value : undefined;
    }
    return undefined;
  };
  const has = (n: string) => method(n) !== undefined;
  let role: Classified["role"] = isClassInstance ? "provider" : "plain";
  if (controller) role = "controller";
  else if (isCatch || (has("catch") && isClassInstance && !has("then")))
    role = "filter";
  else if (has("canActivate")) role = "guard";
  else if (has("intercept")) role = "interceptor";
  else if (has("transform") && isClassInstance) role = "pipe";
  else if (isClassInstance && (method("use")?.length ?? 0) >= 3)
    role = "middleware";
  return {
    kind,
    ctorName: (ctor?.name as string) || "(anonymous class)",
    isClassInstance,
    controller,
    injectable,
    catch: isCatch,
    role,
  };
}

/** R1: wrap anything that is a class instance. */
export const ruleEverything = (_: ClassInfo) => true;

/** R2: wrap classes carrying Nest's `@Controller` or `@Injectable` watermark. */
export const ruleMarkers = (info: ClassInfo) => {
  const c = classify(info.instance);
  return c.controller || c.injectable;
};

/**
 * R3 (proposed): controllers, plus `@Injectable` classes whose duck-typed role is "provider"
 * (not a guard, interceptor, pipe, filter or middleware), minus a denylist of framework classes.
 */
export function ruleProposed(denylist: ReadonlySet<unknown>) {
  return (info: ClassInfo) => {
    if (denylist.has(info.ctor)) return false;
    const c = classify(info.instance);
    if (c.controller) return true;
    return c.injectable && c.role === "provider";
  };
}
