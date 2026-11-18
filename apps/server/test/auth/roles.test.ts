/**
 * The role guard and the audit interceptor (issue #34, D-104): every state-changing route of the
 * server is `@AdminOnly()` (this test fails when a new one is not), audited routes carry the
 * interceptor, and both enhancers stay inside their contract when something inside them throws.
 */
import "reflect-metadata";
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  RequestMethod,
  type Type,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
} from "@nestjs/common/constants";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { firstValueFrom, of, throwError } from "rxjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { AUTH_STAMP } from "../../src/auth/admin-auth.js";
import { AuditLog, MemoryAuditStore } from "../../src/auth/audit.js";
import { AuthController } from "../../src/auth/auth.controller.js";
import {
  AUTH_PRINCIPAL,
  PASSWORD_PRINCIPAL,
  TOKEN_PRINCIPAL,
} from "../../src/auth/principal.js";
import {
  AdminRoleGuard,
  AUDIT_ACTION,
  AuditInterceptor,
  isAdminRequest,
} from "../../src/auth/roles.js";
import { IngestController } from "../../src/ingest/ingest.controller.js";
import { InstanceController } from "../../src/profiler/instance.controller.js";
import { testConfig } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";

const WRITE = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);
/** Write routes that are not the dashboard's: sign-in and ingest have their own credentials. */
const NOT_DASHBOARD: ReadonlySet<unknown> = new Set([
  AuthController,
  IngestController,
  InstanceController,
]);
/** Reads that are admin-only too. */
const ADMIN_READS = ["TokensController", "AuditController"];

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
}

// The whole module graph is compiled, which runs the migrations: it needs a database.
describe.skipIf(noDatabase)(`route coverage ${skipReason}`, () => {
  let controllers: Type[] = [];
  let close: () => Promise<void> = async () => {};
  let db: TestDb | undefined;

  beforeAll(async () => {
    db = await createTestDb("roles_cover");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig({ DATABASE_URL: db.url }))],
    }).compile();
    close = async () => {
      await moduleRef.close();
      await db?.drop();
    };
    const modules = moduleRef.get(ModulesContainer);
    controllers = [...modules.values()].flatMap((m) =>
      [...m.controllers.values()].map((w) => w.metatype as Type),
    );
  });
  afterAll(async () => {
    await close();
  });

  it("finds the server's controllers", () => {
    const names = controllers.map((c) => c.name);
    for (const name of [
      "AlertsController",
      "SlosController",
      "TokensController",
      "RemoteProfilesController",
      "AuditController",
      "QueryController",
    ])
      expect(names).toContain(name);
  });

  it("puts AdminRoleGuard on every dashboard write route and on the admin-only reads", () => {
    const missing: string[] = [];
    let writes = 0;
    for (const controller of controllers) {
      if (NOT_DASHBOARD.has(controller)) continue;
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        const handler = proto[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (method === undefined) continue;
        const needs =
          WRITE.has(method) || ADMIN_READS.includes(controller.name);
        if (!needs) continue;
        if (WRITE.has(method)) writes++;
        const guards = [...guardsOf(controller), ...guardsOf(handler)];
        if (!guards.includes(AdminRoleGuard))
          missing.push(`${controller.name}.${name}`);
        if (
          WRITE.has(method) &&
          (Reflect.getMetadata(AUDIT_ACTION, handler) === undefined ||
            !(
              (Reflect.getMetadata(
                INTERCEPTORS_METADATA,
                handler,
              ) as unknown[]) ?? []
            ).includes(AuditInterceptor))
        )
          missing.push(`${controller.name}.${name} (not audited)`);
      }
    }
    expect(missing).toEqual([]);
    // Alerts 4, SLOs 3, tokens 2, remote profiles 1, error triage 3.
    expect(writes).toBe(13);
  });
});

function context(
  req: unknown,
  options: { type?: string; response?: unknown; handler?: () => void } = {},
): ExecutionContext {
  return {
    getType: () => options.type ?? "http",
    getClass: () => Object,
    getHandler: () => options.handler ?? (() => undefined),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => options.response ?? { statusCode: 201 },
    }),
  } as unknown as ExecutionContext;
}

const session = (principal: unknown) => ({
  [AUTH_STAMP]: "session",
  [AUTH_PRINCIPAL]: principal,
});

describe("AdminRoleGuard", () => {
  const guard = new AdminRoleGuard();
  const statusOf = (ctx: ExecutionContext): number | "ok" => {
    try {
      return guard.canActivate(ctx) ? "ok" : 0;
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
  };
  const viewer = { kind: "oidc", role: "viewer", userId: 1, label: "v" };
  const admin = { kind: "oidc", role: "admin", userId: 2, label: "a" };

  it("lets an admin session through and refuses everyone else", () => {
    expect(statusOf(context(session(PASSWORD_PRINCIPAL)))).toBe("ok");
    expect(statusOf(context(session(admin)))).toBe("ok");
    expect(statusOf(context(session(viewer)))).toBe(403);
    expect(statusOf(context(session(undefined)))).toBe(403);
    expect(
      statusOf(
        context({ [AUTH_STAMP]: "token", [AUTH_PRINCIPAL]: TOKEN_PRINCIPAL }),
      ),
    ).toBe(401);
    expect(statusOf(context({}))).toBe(401);
    // A principal claiming admin by a string key is not the private symbol.
    expect(
      statusOf(context({ [AUTH_STAMP]: "session", principal: admin })),
    ).toBe(403);
  });

  it("refuses (401) when reading the request throws, and outside HTTP", () => {
    const throwing = {
      getType: () => "http",
      switchToHttp: () => {
        throw new Error("boom");
      },
    } as unknown as ExecutionContext;
    expect(statusOf(throwing)).toBe(401);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(statusOf(context(hostile))).toBe(401);
    expect(statusOf(context(session(admin), { type: "rpc" }))).toBe(401);
  });

  it("isAdminRequest agrees", () => {
    expect(isAdminRequest(session(PASSWORD_PRINCIPAL))).toBe(true);
    expect(isAdminRequest(session(viewer))).toBe(false);
    expect(isAdminRequest(null)).toBe(false);
  });
});

describe("AuditInterceptor", () => {
  const handler = () => undefined;
  Reflect.defineMetadata(AUDIT_ACTION, "token.create", handler);
  const config = testConfig();
  const make = (audit: AuditLog, reflector = new Reflector()) =>
    new AuditInterceptor(reflector, audit, config);
  const next = (value: unknown): CallHandler => ({ handle: () => of(value) });
  const req = {
    ...session(PASSWORD_PRINCIPAL),
    params: {},
    socket: { remoteAddress: "10.0.0.1" },
  };

  it("records a successful call with the created object's id, and passes the body through", async () => {
    const store = new MemoryAuditStore();
    const body = { token: { id: 7 }, secret: "nxt_x" };
    const out = await firstValueFrom(
      make(new AuditLog(store)).intercept(
        context(req, { handler }),
        next(body),
      ),
    );
    expect(out).toBe(body);
    expect(store.entries[0]).toMatchObject({
      action: "token.create",
      target: "7",
      actor: { kind: "password", label: "break-glass admin" },
      clientAddress: "10.0.0.1",
    });
    expect(JSON.stringify(store.entries)).not.toContain("nxt_x");
  });

  it("records nothing for an error, and passes the error through unchanged", async () => {
    const store = new MemoryAuditStore();
    const error = new HttpException("bad", 400);
    await expect(
      firstValueFrom(
        make(new AuditLog(store)).intercept(context(req, { handler }), {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(store.entries).toEqual([]);
  });

  it("never changes the answer when its store, the reflector or the request throws", async () => {
    const throwingStore = {
      insert: () => {
        throw new Error("sync");
      },
      list: async () => [],
      prune: async () => undefined,
    };
    const body = { id: 1 };
    expect(
      await firstValueFrom(
        make(new AuditLog(throwingStore)).intercept(
          context(req, { handler }),
          next(body),
        ),
      ),
    ).toBe(body);
    const rejecting = {
      ...throwingStore,
      insert: () => Promise.reject(new Error("async")),
    };
    expect(
      await firstValueFrom(
        make(new AuditLog(rejecting)).intercept(
          context(req, { handler }),
          next(body),
        ),
      ),
    ).toBe(body);
    const badReflector = {
      get: () => {
        throw new Error("reflector");
      },
    } as unknown as Reflector;
    expect(
      await firstValueFrom(
        make(new AuditLog(), badReflector).intercept(
          context(req, { handler }),
          next(body),
        ),
      ),
    ).toBe(body);
    const badResponse = {
      get statusCode(): number {
        throw new Error("response");
      },
    };
    expect(
      await firstValueFrom(
        make(new AuditLog()).intercept(
          context(req, { handler, response: badResponse }),
          next(body),
        ),
      ),
    ).toBe(body);
  });
});
