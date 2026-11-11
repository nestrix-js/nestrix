// "The app's own" classes (D-57, D-58): the controllers and providers that the app's modules list
// statically, found from the root module through static `@Module({ imports })` entries.
//
// Reads only what is public: the `ModulesContainer` values' `metatype` and `imports` getters, and
// the `@Module()` metadata through `MODULE_METADATA` from `@nestjs/common`'s `constants` entry.
import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants.js";

/** The public shape of a `ModulesContainer` value this file reads. */
export interface ModuleRefLike {
  readonly metatype?: unknown;
  readonly imports?: Iterable<unknown>;
}

export interface OwnSet {
  /** Controllers and providers (class entries and `useClass`) of the reached modules. */
  readonly classes: ReadonlySet<unknown>;
  /** Names of the root modules found, for diagnostics and tests. */
  readonly roots: readonly string[];
  /** Names of the modules whose static lists were read, in visiting order. */
  readonly modules: readonly string[];
}

/**
 * Static methods that make a module a dynamic-module factory. A module class that has one is
 * treated as a library module even when it is imported statically, so its static providers are
 * not "own" (adjustment to D-58, recorded in architecture §4.3): `ConfigModule` statically imports
 * `ConfigHostModule`, which lists `{ provide: CONFIG_SERVICE, useClass: ConfigService }`, and a
 * feature module's plain `imports: [ConfigModule]` (Nest's documented pattern without `isGlobal`)
 * would otherwise make `ConfigService` traced everywhere.
 */
export const DYNAMIC_MODULE_FACTORIES: readonly string[] = [
  "forRoot",
  "forRootAsync",
  "forFeature",
  "forFeatureAsync",
  "register",
  "registerAsync",
];

function staticList(key: string, metatype: unknown): readonly unknown[] {
  try {
    const value =
      typeof metatype === "function"
        ? Reflect.getMetadata(key, metatype)
        : undefined;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isDynamicModuleFactory(metatype: unknown): boolean {
  try {
    if (typeof metatype !== "function") return false;
    for (const name of DYNAMIC_MODULE_FACTORIES) {
      const d = Object.getOwnPropertyDescriptor(metatype, name);
      if (d && typeof d.value === "function") return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * An `imports` entry that is a class, or a `forwardRef(() => Class)` (adjustment to D-58: a
 * circular import between two of the app's own modules is still a static import). Dynamic-module
 * objects and promises are not followed.
 */
function importedClass(entry: unknown): unknown {
  try {
    if (typeof entry === "function") return entry;
    if (entry !== null && typeof entry === "object" && !("module" in entry)) {
      const ref = (entry as { forwardRef?: unknown }).forwardRef;
      if (typeof ref === "function") {
        const resolved = (ref as () => unknown)();
        return typeof resolved === "function" ? resolved : undefined;
      }
    }
  } catch {
    // a forwardRef that throws is not followed
  }
  return undefined;
}

/** A provider entry's class: the entry itself when it is a class, or its `useClass`. */
function providerClass(entry: unknown): unknown {
  try {
    if (typeof entry === "function") return entry;
    if (entry !== null && typeof entry === "object") {
      const useClass = (entry as { useClass?: unknown }).useClass;
      if (typeof useClass === "function") return useClass;
    }
  } catch {
    // unreadable entry
  }
  return undefined;
}

function nameOf(metatype: unknown): string {
  try {
    const n = (metatype as { name?: unknown } | undefined)?.name;
    return typeof n === "string" && n ? n : "(anonymous)";
  } catch {
    return "(anonymous)";
  }
}

/**
 * The root modules: modules no other module imports. Nest adds every global module (its own
 * `InternalCoreModule` included) to every other module's `imports`, so after the scan only the
 * module given to `NestFactory.create` is left.
 */
export function findRootModules(
  modules: Iterable<ModuleRefLike>,
): ModuleRefLike[] {
  const all = [...modules];
  const imported = new Set<unknown>();
  for (const m of all) {
    try {
      for (const i of m.imports ?? []) if (i !== m) imported.add(i);
    } catch {
      // unreadable imports: this module contributes none
    }
  }
  return all.filter((m) => !imported.has(m));
}

/**
 * Computes the own set from the modules Nest scanned (D-58, with the two adjustments above).
 * Never throws; an unreadable part contributes nothing.
 */
export function computeOwnSet(modules: Iterable<ModuleRefLike>): OwnSet {
  const classes = new Set<unknown>();
  const visited: string[] = [];
  const roots: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [];
  for (const root of findRootModules(modules)) {
    let metatype: unknown;
    try {
      metatype = root.metatype;
    } catch {
      continue;
    }
    if (typeof metatype !== "function" || seen.has(metatype)) continue;
    seen.add(metatype);
    roots.push(nameOf(metatype));
    queue.push(metatype);
  }
  while (queue.length > 0) {
    const metatype = queue.shift();
    visited.push(nameOf(metatype));
    for (const entry of staticList(MODULE_METADATA.CONTROLLERS, metatype)) {
      if (typeof entry === "function") classes.add(entry);
    }
    for (const entry of staticList(MODULE_METADATA.PROVIDERS, metatype)) {
      const cls = providerClass(entry);
      if (cls) classes.add(cls);
    }
    for (const entry of staticList(MODULE_METADATA.IMPORTS, metatype)) {
      const next = importedClass(entry);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      if (isDynamicModuleFactory(next)) continue;
      queue.push(next);
    }
  }
  return { classes, roots, modules: visited };
}
