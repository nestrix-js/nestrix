import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Injectable,
  Module,
  type OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

/**
 * The store our request hook puts in AsyncLocalStorage. `probe` is the value of
 * the request's `x-probe` header (or a generated id), so every observation can be
 * matched to the request it was made for.
 */
export interface Store {
  probe: string;
}

export const als = new AsyncLocalStorage<Store>();

export interface Observation {
  seq: number;
  point: string;
  /** What the observer knows the request to be (from its own request object), if anything. */
  probe?: string;
  /** What `als.getStore()` returned at that point. */
  storeProbe?: string;
  data?: Record<string, unknown>;
}

export const observations: Observation[] = [];
let seq = 0;

export function record(
  point: string,
  probe?: string,
  data?: Record<string, unknown>,
): void {
  observations.push({
    seq: ++seq,
    point,
    probe,
    storeProbe: als.getStore()?.probe,
    data,
  });
}

export function resetObservations(): void {
  observations.length = 0;
}

/**
 * How the spike's request hook behaves. Read on every request, so a test can
 * switch it; `resetHookConfig()` puts it back (every test file calls it in
 * `afterEach`, so a throwing hook never outlives the test that set it).
 */
export type HookMode =
  | "normal"
  | "throw-sync"
  | "throw-after-done"
  | "promise-no-done"
  /** Fault injection: something inside the wrapped body throws; `done()` must still run once. */
  | "fault-in-body"
  /** Negative control: the store is created but `done()` is called outside `als.run()`. */
  | "done-outside-run";

export type InstallAt =
  /** Constructor if the adapter is there, otherwise when `HttpAdapterHost.init$` emits. */
  "ctor-or-init$" | "ctor-only" | "onModuleInit";

export interface HookConfig {
  mode: HookMode;
  installAt: InstallAt;
  /** Fault injection: the `init$` subscriber throws (inside its wrapped body) after installing. */
  initSubscriberFault: boolean;
}

export const hookConfig: HookConfig = {
  mode: "normal",
  installAt: "ctor-or-init$",
  initSubscriberFault: false,
};

export function resetHookConfig(): void {
  hookConfig.mode = "normal";
  hookConfig.installAt = "ctor-or-init$";
  hookConfig.initSubscriberFault = false;
}

/** Fastify hands the hook its own request/reply; the Node objects are on `.raw`. */
type HookReq = IncomingMessage & { raw?: IncomingMessage };
type HookRes = ServerResponse & { raw?: ServerResponse };

function headerProbe(req: IncomingMessage): string | undefined {
  const value = req.headers["x-probe"];
  return typeof value === "string" ? value : undefined;
}

let generated = 0;

/**
 * The request hook under test. In "normal" mode it is the shape the architecture
 * prescribes: synchronous, body wrapped, `done()` called exactly once, inside
 * `als.run()`.
 */
export function requestHook(
  req: HookReq,
  res: HookRes,
  done: (err?: Error) => void,
): void | Promise<void> {
  const mode = hookConfig.mode;
  if (mode === "throw-sync") {
    record("hook:throwing", undefined, { url: (req.raw ?? req).url });
    throw new Error("spike: request hook threw synchronously");
  }
  if (mode === "promise-no-done") {
    record("hook:promise-no-done", undefined, { url: (req.raw ?? req).url });
    return Promise.resolve();
  }
  let store: Store | undefined;
  try {
    const rawReq = req.raw ?? req;
    const rawRes = res.raw ?? res;
    store = { probe: headerProbe(rawReq) ?? `gen-${++generated}` };
    const probe = store.probe;
    record("hook", probe, { url: rawReq.url, method: rawReq.method });
    if (mode === "fault-in-body") {
      record("hook:fault", probe);
      throw new Error("spike: injected fault inside the wrapped hook body");
    }
    rawRes.once("close", () => {
      try {
        record("close", probe, {
          statusCode: rawRes.statusCode,
          writableFinished: rawRes.writableFinished,
          writableEnded: rawRes.writableEnded,
          headersSent: rawRes.headersSent,
          reqComplete: rawReq.complete,
          reqDestroyed: rawReq.destroyed,
          socketDestroyed: rawRes.socket?.destroyed ?? null,
          errored: rawRes.errored ? String(rawRes.errored) : null,
        });
      } catch {
        // never throw from an event listener
      }
    });
  } catch {
    store = undefined;
  }
  if (store && mode !== "done-outside-run") {
    als.run(store, done);
  } else {
    done();
  }
  if (mode === "throw-after-done") {
    throw new Error("spike: request hook threw after done()");
  }
}

function routeHook(method: RequestMethod, path: string): void {
  try {
    record("route", undefined, { method: RequestMethod[method], path });
  } catch {
    // never throw into the route handler
  }
}

export interface AdapterLike {
  setOnRequestHook?: (hook: typeof requestHook) => void;
  setOnRouteTriggered?: (hook: (m: RequestMethod, p: string) => void) => void;
  getOnRouteTriggered?: () =>
    | ((m: RequestMethod, p: string) => void)
    | undefined;
  getType?: () => string;
}

/** `"undefined"`, `"null"` or the adapter's `getType()`: Nest uses both empty values. */
function describeAdapter(adapter: unknown): string {
  if (adapter === undefined) return "undefined";
  if (adapter === null) return "null";
  const type = (adapter as AdapterLike).getType?.();
  return typeof type === "string" ? type : typeof adapter;
}

function install(adapter: AdapterLike | null | undefined, at: string): boolean {
  if (!adapter) return false;
  try {
    adapter.setOnRequestHook?.(requestHook);
    const previous = adapter.getOnRouteTriggered?.();
    adapter.setOnRouteTriggered?.((m, p) => {
      routeHook(m, p);
      previous?.(m, p);
    });
    record("installed", undefined, { at, type: adapter.getType?.() });
    return true;
  } catch (error) {
    record("install-error", undefined, { at, error: String(error) });
    return false;
  }
}

/** Sets the hooks from its constructor, as the architecture prescribes. */
@Injectable()
export class HooksService implements OnModuleInit {
  private installed = false;

  constructor(private readonly adapterHost: HttpAdapterHost) {
    const adapter = adapterHost.httpAdapter as AdapterLike | null | undefined;
    record("ctor", undefined, { adapter: describeAdapter(adapter) });
    const at = hookConfig.installAt;
    if (at === "onModuleInit") return;
    this.installed = install(adapter, "ctor");
    if (!this.installed && at === "ctor-or-init$") {
      try {
        adapterHost.init$.subscribe(() => {
          // The whole body is wrapped: rxjs rethrows a subscriber's error on a
          // timer, where it becomes an uncaughtException (the setter that
          // emitted returns normally), so a throw here would crash the host.
          try {
            record("init$", undefined, {
              adapter: describeAdapter(adapterHost.httpAdapter),
            });
            if (!this.installed) {
              this.installed = install(
                adapterHost.httpAdapter as AdapterLike | undefined,
                "init$",
              );
            }
            if (hookConfig.initSubscriberFault) {
              record("init$:fault");
              throw new Error("spike: injected fault in the init$ subscriber");
            }
          } catch {
            // never throw out of the subscriber
          }
        });
      } catch (error) {
        record("init$-error", undefined, { error: String(error) });
      }
    }
  }

  onModuleInit(): void {
    record("onModuleInit", undefined, {
      adapter: describeAdapter(this.adapterHost.httpAdapter),
    });
    if (hookConfig.installAt === "onModuleInit" && !this.installed) {
      this.installed = install(
        this.adapterHost.httpAdapter as AdapterLike | undefined,
        "onModuleInit",
      );
    }
  }
}

@Module({ providers: [HooksService] })
export class HooksModule {}
