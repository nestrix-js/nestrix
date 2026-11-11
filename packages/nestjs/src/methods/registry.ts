// The level 2 instance decorator and the process-wide state behind it (D-58).
//
// Nest calls the decorator for every instance its injector creates, with the instance alone. A
// marked class (controller, injectable, filter, processor) gets wrappers installed at once, in a
// disabled state, all sharing one per-class plan. `NestrixCore`'s constructor computes the own set
// and calls `configureMethods`, which switches each plan on or off. Instances decorated after that
// are planned immediately, and get no wrappers at all when their plan is off.
import { diagnostics } from "../diagnostics.js";
import type { ClassMatcher } from "../options.js";
import {
  classKind,
  entryKind,
  isEnhancerKind,
  isMarkedClass,
} from "./classify.js";
import { computeOwnSet, type ModuleRefLike } from "./own-set.js";
import type { ResolvedMethods } from "./resolved.js";
import type { MethodClassKind } from "./sink.js";
import {
  copyFunctionShape,
  type Fn,
  listMethods,
  makeWrapper,
  type PlanSwitch,
} from "./wrap.js";

interface MethodsConfig {
  readonly enabled: boolean;
  readonly own: ReadonlySet<unknown>;
  readonly include: readonly ClassMatcher[];
  readonly exclude: readonly ClassMatcher[];
  readonly enhancers: ReadonlySet<string>;
}

export interface ClassPlan extends PlanSwitch {
  readonly ctor: unknown;
  readonly methods: ReadonlyArray<readonly [string, Fn]>;
}

let config: MethodsConfig | undefined;
let decoratedAny = false;
/** Plans by class prototype. A prototype with no wrappable method maps to `null`. */
const plans = new WeakMap<object, ClassPlan | null>();
/** Every plan built, so `configureMethods` can switch the ones built before it. */
const allPlans = new Set<ClassPlan>();
/** Unmarked classes known not to be included under the current config; replaced on configure. */
let notIncluded = new WeakSet<object>();
/** Nestrix's own classes (`NestrixCore`, `NestrixInterceptor`): never wrapped. */
const internal = new WeakSet<object>();

/** Registers Nestrix's own classes, which are never wrapped. Never throws. */
export function markNestrixInternal(...classes: unknown[]): void {
  for (const c of classes) {
    try {
      if (typeof c === "function") internal.add(c);
    } catch {
      // nothing to mark
    }
  }
}

function className(ctor: unknown): string {
  try {
    const n = (ctor as { name?: unknown } | undefined)?.name;
    return typeof n === "string" && n ? n : "anonymous";
  } catch {
    return "anonymous";
  }
}

function matches(
  matchers: readonly ClassMatcher[],
  ctor: unknown,
  name: string,
): boolean {
  for (const m of matchers) {
    try {
      if (typeof m === "function") {
        if (m === ctor) return true;
      } else if (typeof m === "string") {
        if (m === name) return true;
      } else if (m instanceof RegExp) {
        m.lastIndex = 0;
        if (m.test(name)) return true;
      }
    } catch (error) {
      diagnostics.countFailure("methods.matcher", error);
    }
  }
  return false;
}

/**
 * Whether a class is traced under `c`: never Nestrix's own; `exclude` wins; then `include`; an
 * enhancer follows `methods.enhancers`; otherwise the own set decides (D-57, D-58).
 */
function decide(
  c: MethodsConfig,
  ctor: unknown,
  name: string,
  kind: MethodClassKind,
): boolean {
  try {
    if (!c.enabled) return false;
    if (typeof ctor === "function" && internal.has(ctor)) return false;
    if (matches(c.exclude, ctor, name)) return false;
    if (matches(c.include, ctor, name)) return true;
    if (isEnhancerKind(kind)) return c.enhancers.has(kind);
    return c.own.has(ctor);
  } catch (error) {
    diagnostics.countFailure("methods.decide", error);
    return false;
  }
}

function buildPlan(proto: object, ctor: unknown): ClassPlan | null {
  const name = className(ctor);
  const kind = classKind(ctor, proto, name);
  const methods: Array<readonly [string, Fn]> = [];
  const plan: ClassPlan = {
    ctor,
    className: name,
    kind,
    on: config ? decide(config, ctor, name, kind) : false,
    methods,
  };
  for (const [method, fn] of listMethods(proto)) {
    try {
      const w = makeWrapper(
        plan,
        proto,
        method,
        fn,
        entryKind(kind, method, fn),
      );
      copyFunctionShape(fn, w);
      methods.push([method, w]);
    } catch (error) {
      // Leave this method unwrapped rather than install a wrapper that lost metadata.
      diagnostics.countFailure("methods.wrap", error);
    }
  }
  if (methods.length === 0) return null;
  allPlans.add(plan);
  return plan;
}

function constructorOf(proto: object): unknown {
  const own = Object.getOwnPropertyDescriptor(proto, "constructor");
  return own ? own.value : (proto as { constructor?: unknown }).constructor;
}

/**
 * The plan for `proto`, building it on first sight. Unmarked classes get a plan only when the
 * current config includes them by name or class (they cannot be planned before the config exists).
 */
function planFor(proto: object): ClassPlan | null {
  const cached = plans.get(proto);
  if (cached !== undefined) return cached;
  if (notIncluded.has(proto)) return null;
  const ctor = constructorOf(proto);
  if (typeof ctor === "function" && internal.has(ctor)) {
    plans.set(proto, null);
    return null;
  }
  if (!isMarkedClass(ctor)) {
    if (!config || !matches(config.include, ctor, className(ctor))) {
      // Not cached before the config exists: an `include` may name it.
      if (config) notIncluded.add(proto);
      return null;
    }
  }
  const plan = buildPlan(proto, ctor);
  plans.set(proto, plan);
  return plan;
}

/**
 * `instrument.instanceDecorator` for `NestFactory.create(AppModule, { instrument })`. Returns the
 * instance it was given, always; never throws (Nest would log a warning and carry on, but rule 1).
 */
export function nestrixInstanceDecorator(instance: unknown): unknown {
  try {
    decoratedAny = true;
    if (config && !config.enabled) return instance;
    // Functions (plain middleware, factory results) and primitives pass untouched.
    if (instance === null || typeof instance !== "object") return instance;
    const proto = Object.getPrototypeOf(instance) as object | null;
    // Plain objects (value providers, `{ ... }` factory results) have no class to wrap.
    if (proto === null || proto === Object.prototype) return instance;
    const plan = planFor(proto);
    if (plan === null) return instance;
    // Planned off under a known config: install nothing.
    if (config && !plan.on) return instance;
    if (!Object.isExtensible(instance)) return instance;
    for (const [method, w] of plan.methods) {
      // A class field of that name, or an earlier decoration (the same instance arrives again for
      // `useExisting`): leave it.
      if (Object.hasOwn(instance, method)) continue;
      Object.defineProperty(instance, method, {
        value: w,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    return instance;
  } catch (error) {
    diagnostics.countFailure("methods.decorate", error);
    return instance;
  }
}

/**
 * Computes the own set from `modules` (a `ModulesContainer`'s values) and switches every plan.
 * Returns a disposer that switches them all off again (the app closed). Never throws.
 */
export function configureMethods(
  options: ResolvedMethods,
  modules: Iterable<ModuleRefLike> | undefined,
): () => void {
  let mine: MethodsConfig | undefined;
  try {
    const own = options.enabled
      ? computeOwnSet(modules ?? []).classes
      : new Set<unknown>();
    mine = {
      enabled: options.enabled,
      own,
      include: options.include,
      exclude: options.exclude,
      enhancers: new Set(options.enhancers),
    };
    config = mine;
    notIncluded = new WeakSet();
    for (const plan of allPlans) {
      plan.on = decide(mine, plan.ctor, plan.className, plan.kind);
    }
  } catch (error) {
    diagnostics.countFailure("methods.configure", error);
  }
  return () => {
    try {
      if (!mine || config !== mine) return;
      config = undefined;
      notIncluded = new WeakSet();
      for (const plan of allPlans) plan.on = false;
    } catch (error) {
      diagnostics.countFailure("methods.dispose", error);
    }
  };
}

/**
 * For the class statistics (P3-04): true when `NestrixInstrument` has decorated at least one
 * instance and the current configuration has `methods.enabled` on.
 */
export function methodsEnabled(): boolean {
  return decoratedAny && config?.enabled === true;
}

/** Internal, for tests only: the classes the current config traces by the own-set rule. */
export function currentOwnClasses(): ReadonlySet<unknown> | undefined {
  return config?.own;
}

/** Internal, for tests only: the plan of a class, if one was built. */
export function planOf(ctor: { prototype: object }): ClassPlan | undefined {
  return plans.get(ctor.prototype) ?? undefined;
}

/** Internal, for tests only: forget the configuration and the "decorated" flag (plans stay). */
export function resetMethodsForTests(): void {
  config = undefined;
  decoratedAny = false;
  notIncluded = new WeakSet();
  for (const plan of allPlans) plan.on = false;
}
