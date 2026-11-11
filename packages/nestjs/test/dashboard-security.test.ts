// P2-07: one named test per rule of the dashboard's security model (architecture §4.7, D-30, D-46,
// backlog P2 "Public API"), each on Express, Fastify and platform-node, against a listening
// server. Raw TCP wherever the exact header bytes matter (Host, duplicates, HTTP/1.0, forwarding
// headers).
//
// Method: every negative case is paired with a control that differs in exactly the variable under
// test, so a test cannot pass because something else denied the request. In 'auto' the negative
// cases carry a valid startup cookie, so the startup-token rule is not what answers.
//
// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// `NODE_ENV` is stubbed per test because vitest runs with NODE_ENV=test, which turns 'auto' off.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { type INestApplication, Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAccess } from "../src/dashboard/access.js";
import { uiPackage } from "../src/dashboard/assets.js";
import { getProcessStartupToken } from "../src/dashboard/startup-token.js";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import { resolveUi } from "../src/resolve-options.js";
import {
  ADAPTERS,
  BEARER,
  bootDashboardApp,
  corsHeaders,
  type DashboardApp,
  EVIL_ORIGIN,
  type Fetched,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import {
  externalIPv4,
  http10,
  http11,
  type RawReply,
  rawRequest,
  startSameHostProxy,
} from "./dashboard-security-fixture.js";

const realResolve = uiPackage.resolveDirectory;
let booted: DashboardApp | undefined;
let logs: string[];
let errors: string[];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  resetDiagnosticsForTests();
  logs = [];
  errors = [];
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => {
    logs.push(String(m));
  });
  vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => {
    errors.push(String(m));
  });
});
afterEach(async () => {
  uiPackage.resolveDirectory = realResolve;
  for (const c of cleanups.splice(0)) await c();
  await booted?.close();
  booted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const BASE = { export: { otlp: false as const } };
/** 'auto' with the startup token (the default). */
const AUTO = { ...BASE };
/** 'auto' without the startup token (the explicit opt-out). */
const AUTO_NO_TOKEN = { ...BASE, ui: { startupToken: false } };
/** Explicit mode with the built-in token authenticator. */
const ENABLED = { ...BASE, ui: { enabled: true, auth: { token: TOKEN } } };

const PATH = "/_nestrix";
const API = `${PATH}/api/v1/meta`;
const DASHBOARD_CSP_FRAGMENT = "default-src 'none'";

async function boot(
  adapter: (typeof ADAPTERS)[number],
  nestrix: Record<string, unknown>,
  more: {
    cors?: boolean;
    filter?: boolean;
    configure?: (app: INestApplication) => void;
  } = {},
): Promise<DashboardApp> {
  booted = await bootDashboardApp({ adapter, nestrix, ...more });
  return booted;
}

/** Exchanges the startup token for the session cookie, as the logged link does; returns `name=value`. */
async function signIn(app: DashboardApp): Promise<string> {
  const token = getProcessStartupToken().token;
  const r = await get(`${app.baseUrl}${PATH}/auth?token=${token}`);
  expect(r.status, "startup exchange").toBe(303);
  return (r.headers.get("set-cookie") as string).split(";")[0] as string;
}

/** A request on raw TCP with a loopback `Host`, plus `extra` header lines. */
function local(
  app: DashboardApp,
  path: string,
  extra: string[] = [],
  method = "GET",
): string {
  return http11(path, [`Host: localhost:${app.port}`, ...extra], method);
}

/** A denied request is a bare 404: nothing that fingerprints the dashboard (Public API, "Denied requests"). */
/** No LAN address: a silent skip hides the rule in CI, so CI fails; locally the unit test covers it. */
function lanAddressOrSkip(ctx: { skip(): never }): string {
  const ext = externalIPv4();
  if (ext) return ext;
  if (process.env.CI) {
    throw new Error(
      "CI is set but this machine has no non-loopback IPv4 address, so the non-loopback peer rules cannot be tested over a real socket. Fix the runner's network; do not skip.",
    );
  }
  return ctx.skip();
}

function expectBare404(r: RawReply | Fetched, label: string): void {
  const headers: Record<string, string | null | undefined> =
    "get" in r.headers
      ? Object.fromEntries((r.headers as Headers).entries())
      : (r.headers as Record<string, string>);
  const body = "body" in r && typeof r.body === "string" ? r.body : "";
  const bodyLength =
    typeof r.body === "string" ? r.body.length : (r.body as Buffer).length;
  expect(r.status, `${label}: status`).toBe(404);
  expect(bodyLength, `${label}: body ${body}`).toBe(0);
  for (const name of [
    "content-type",
    "content-security-policy",
    "x-robots-tag",
    "x-frame-options",
    "referrer-policy",
    "location",
    "set-cookie",
  ]) {
    expect(headers[name], `${label}: ${name}`).toBeUndefined();
  }
  expect(headers["cache-control"], `${label}: cache-control`).toBe("no-store");
  expect(headers["x-content-type-options"], `${label}: nosniff`).toBe(
    "nosniff",
  );
  expect(
    Object.keys(headers).filter((k) => k.startsWith("access-control-")),
    `${label}: cors`,
  ).toEqual([]);
}

/** Nest's own 404 for a route nobody registered: the dashboard is not there at all. */
function expectNotRegistered(r: Fetched, label: string): void {
  expect(r.status, label).toBe(404);
  expect(r.headers.get("x-robots-tag"), `${label}: robots`).toBeNull();
  expect(r.headers.get("content-security-policy"), `${label}: csp`).toBeNull();
  // Not the dashboard's own denial either: that is an empty body with `Cache-Control: no-store`.
  // Nest's 404 (verified on Express, Fastify and platform-node) is a JSON body naming the route.
  expect(r.body.length, `${label}: Nest's 404 has a body`).toBeGreaterThan(0);
  expect(r.headers.get("content-type"), `${label}: content-type`).toContain(
    "application/json",
  );
  expect(r.headers.get("cache-control"), `${label}: cache-control`).not.toBe(
    "no-store",
  );
}

describe.each(ADAPTERS)("dashboard security on %s", (adapter) => {
  // ---------------------------------------------------------------------------------------------
  // When the dashboard exists at all
  // ---------------------------------------------------------------------------------------------

  it("'auto' is off outside development: NODE_ENV production or staging registers nothing", async () => {
    for (const env of ["production", "staging", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      const app = await boot(adapter, AUTO);
      for (const path of [`${PATH}/`, API, `${PATH}/auth`]) {
        expectNotRegistered(
          await get(`${app.baseUrl}${path}`),
          `${env} ${path}`,
        );
      }
      expect((await get(`${app.baseUrl}/h/ok`)).text).toBe("ok");
      expect(
        logs.some((l) => l.includes(`NODE_ENV is "${env}"`)),
        `${env}: log line`,
      ).toBe(true);
      await app.close();
      booted = undefined;
      logs.length = 0;
    }
    // Control: development serves it (to a local request with the startup cookie).
    vi.stubEnv("NODE_ENV", "development");
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    expect((await get(`${app.baseUrl}${API}`, { cookie })).status).toBe(200);
  });

  it("'auto' is on when NODE_ENV is unset", async () => {
    vi.stubEnv("NODE_ENV", "");
    delete process.env.NODE_ENV;
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    expect((await get(`${app.baseUrl}${API}`, { cookie })).status).toBe(200);
  });

  it("@nestrix-js/ui absent: the dashboard is off in 'auto' and in 'enabled', and the app starts", async () => {
    uiPackage.resolveDirectory = () => undefined;
    for (const nestrix of [AUTO_NO_TOKEN, ENABLED]) {
      const app = await boot(adapter, nestrix);
      for (const path of [`${PATH}/`, API]) {
        expectNotRegistered(
          await get(`${app.baseUrl}${path}`, BEARER),
          `ui missing ${path}`,
        );
      }
      expect((await get(`${app.baseUrl}/h/ok`)).text).toBe("ok");
      expect(logs.some((l) => l.includes("npm install @nestrix-js/ui"))).toBe(
        true,
      );
      await app.close();
      booted = undefined;
      logs.length = 0;
    }
  });

  it("'enabled: true' without auth stays off, logs an error, and the app starts", async () => {
    const app = await boot(adapter, { ...BASE, ui: { enabled: true } });
    expect((await get(`${app.baseUrl}/h/ok`)).text).toBe("ok");
    for (const path of [`${PATH}/`, API]) {
      expectNotRegistered(await get(`${app.baseUrl}${path}`, BEARER), path);
    }
    expect(errors.some((e) => e.includes("ui.auth is missing"))).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // 'auto': the per-request local-only rule
  // ---------------------------------------------------------------------------------------------

  it("'auto' denies a non-loopback peer", async (ctx) => {
    // Locally without a LAN address: covered by the 'checkAccess denies a non-loopback socket peer' test below.
    const ext = lanAddressOrSkip(ctx);
    // Bind every interface; connect to the machine's own LAN address, so the socket peer is not
    // loopback, while the Host header stays loopback so only the peer is under test.
    booted = await bootDashboardApp({
      adapter,
      nestrix: AUTO,
      listen: false,
    });
    await booted.app.listen(0, "0.0.0.0");
    const port = (booted.app.getHttpServer().address() as AddressInfo).port;
    const app = { ...booted, port, baseUrl: `http://127.0.0.1:${port}` };
    const cookie = await signIn(app);
    const ask = (host: string): Promise<RawReply> =>
      rawRequest(
        port,
        http11(API, [`Host: localhost:${port}`, `Cookie: ${cookie}`]),
        host,
      );
    // Control: the same bytes from a loopback peer are served.
    expect((await ask("127.0.0.1")).status).toBe(200);
    expectBare404(await ask(ext), "peer is the LAN address");
    // Not even the token exchange is honoured for a non-loopback peer.
    const token = getProcessStartupToken().token;
    const exchange = await rawRequest(
      port,
      http11(`${PATH}/auth?token=${token}`, [`Host: localhost:${port}`]),
      ext,
    );
    expectBare404(exchange, "token exchange from the LAN address");
  });

  it("'enabled' with auth has no loopback check: a non-loopback peer and Host are served on auth alone", async (ctx) => {
    const ext = lanAddressOrSkip(ctx);
    booted = await bootDashboardApp({
      adapter,
      nestrix: ENABLED,
      listen: false,
    });
    await booted.app.listen(0, "0.0.0.0");
    const port = (booted.app.getHttpServer().address() as AddressInfo).port;
    const withToken = await rawRequest(
      port,
      http11(API, [`Host: ${ext}:${port}`, `Authorization: Bearer ${TOKEN}`]),
      ext,
    );
    expect(withToken.status).toBe(200);
    const without = await rawRequest(
      port,
      http11(API, [`Host: ${ext}:${port}`]),
      ext,
    );
    expectBare404(without, "enabled, no credentials");
  });

  it("'auto' denies a foreign Host, and only the Host differs from the served control", async () => {
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    const ask = (host: string): Promise<RawReply> =>
      rawRequest(app.port, http11(API, [`Host: ${host}`, `Cookie: ${cookie}`]));
    for (const ok of [
      `localhost:${app.port}`,
      `127.0.0.1:${app.port}`,
      `LOCALHOST:${app.port}`,
    ]) {
      expect((await ask(ok)).status, ok).toBe(200);
    }
    for (const bad of [
      "evil.example",
      `evil.example:${app.port}`,
      `localhost.evil.example:${app.port}`,
      `localhost.:${app.port}`,
      `foo.localhost:${app.port}`,
      `localhost@evil.example`,
      "192.168.1.5",
      "[::2]",
      "",
    ]) {
      expectBare404(await ask(bad), `Host: "${bad}"`);
    }
  });

  it("'auto' denies a request with no Host header (HTTP/1.0)", async () => {
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    const noHost = await rawRequest(
      app.port,
      http10(API, [`Cookie: ${cookie}`]),
    );
    expectBare404(noHost, "HTTP/1.0 without Host");
    // Control: the same HTTP/1.0 request with a loopback Host is served.
    const withHost = await rawRequest(
      app.port,
      http10(API, [`Host: localhost:${app.port}`, `Cookie: ${cookie}`]),
    );
    expect(withHost.status).toBe(200);
    // And an HTTP/1.0 request with a foreign Host is denied like any foreign Host.
    expectBare404(
      await rawRequest(
        app.port,
        http10(API, ["Host: evil.example", `Cookie: ${cookie}`]),
      ),
      "HTTP/1.0 with foreign Host",
    );
  });

  it("'auto' denies a request with two Host headers when either names a foreign host", async () => {
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    const ask = (...hosts: string[]): Promise<RawReply> =>
      rawRequest(
        app.port,
        http11(API, [...hosts.map((h) => `Host: ${h}`), `Cookie: ${cookie}`]),
      );
    const one = await ask(`localhost:${app.port}`);
    expect(one.status, "control: one loopback Host").toBe(200);
    for (const [label, hosts] of [
      [
        "loopback first, foreign second",
        [`localhost:${app.port}`, "evil.example"],
      ],
      [
        "foreign first, loopback second",
        ["evil.example", `localhost:${app.port}`],
      ],
    ] as const) {
      const r = await ask(...hosts);
      // Node (26) hands both lines to the app and keeps only the first in `headers`; the raw
      // header list is what catches the second.
      expectBare404(r, label);
    }
  });

  it("'auto' denies each forwarding header, with any value and when empty", async () => {
    const app = await boot(adapter, AUTO);
    const cookie = await signIn(app);
    const ask = (...extra: string[]): Promise<RawReply> =>
      rawRequest(app.port, local(app, API, [`Cookie: ${cookie}`, ...extra]));
    expect((await ask()).status, "control: no forwarding header").toBe(200);
    for (const header of [
      "Forwarded: for=203.0.113.9",
      "X-Forwarded-For: 203.0.113.9",
      "X-Forwarded-Host: dash.example",
      "X-Forwarded-Proto: https",
      "X-Real-IP: 203.0.113.9",
      "Via: 1.1 proxy",
      // Spelled differently, empty, and a loopback-looking value: presence is what counts.
      "X-FORWARDED-FOR: 127.0.0.1",
      "x-forwarded-for:",
      "Via:",
    ]) {
      expectBare404(await ask(header), header);
    }
    // The exchange is refused too, so a forwarded request cannot even collect the cookie.
    const token = getProcessStartupToken().token;
    const exchange = await rawRequest(
      app.port,
      local(app, `${PATH}/auth?token=${token}`, [
        "X-Forwarded-For: 203.0.113.9",
      ]),
    );
    expectBare404(exchange, "exchange with X-Forwarded-For");
  });

  // ---------------------------------------------------------------------------------------------
  // Every mode: cross-site
  // ---------------------------------------------------------------------------------------------

  it("rejects Sec-Fetch-Site: cross-site in 'auto', in 'enabled' with a token and in 'enabled' with authorize", async () => {
    const authorizeCalls: unknown[] = [];
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["auto", AUTO, true],
      ["auto without startup token", AUTO_NO_TOKEN, false],
      ["enabled token", ENABLED, false],
      [
        "enabled authorize",
        {
          ...BASE,
          ui: {
            enabled: true,
            auth: {
              authorize: (request: unknown) => {
                authorizeCalls.push(request);
                return true;
              },
            },
          },
        },
        false,
      ],
    ];
    for (const [label, nestrix, needsCookie] of cases) {
      const app = await boot(adapter, nestrix);
      const creds: string[] = [];
      if (needsCookie) creds.push(`Cookie: ${await signIn(app)}`);
      if (nestrix === ENABLED) creds.push(`Authorization: Bearer ${TOKEN}`);
      const ask = (fetchSite?: string): Promise<RawReply> =>
        rawRequest(
          app.port,
          local(app, API, [
            ...creds,
            ...(fetchSite ? [`Sec-Fetch-Site: ${fetchSite}`] : []),
          ]),
        );
      // Controls: every other value, and none, is served.
      for (const ok of [undefined, "same-origin", "same-site", "none"]) {
        expect((await ask(ok)).status, `${label}: ${ok}`).toBe(200);
      }
      authorizeCalls.length = 0;
      for (const bad of [
        "cross-site",
        "Cross-Site",
        "same-origin, cross-site",
      ]) {
        expectBare404(await ask(bad), `${label}: ${bad}`);
      }
      // Cross-site is decided before authorize runs.
      expect(authorizeCalls, `${label}: authorize not consulted`).toEqual([]);
      // The token exchange refuses it too, even with the right token: no 303, no cookie.
      const secret =
        nestrix === AUTO
          ? getProcessStartupToken().token
          : nestrix === ENABLED
            ? TOKEN
            : undefined;
      if (secret !== undefined) {
        const exchange = (fetchSite: string): Promise<RawReply> =>
          rawRequest(
            app.port,
            local(app, `${PATH}/auth?token=${secret}`, [
              `Sec-Fetch-Site: ${fetchSite}`,
            ]),
          );
        // Control: the same exchange from the same origin is honoured.
        const same = await exchange("same-origin");
        expect(same.status, `${label}: same-origin exchange`).toBe(303);
        expect(same.headers["set-cookie"], `${label}: control cookie`).toMatch(
          /^nestrix_(session|auth)_\d+=/,
        );
        for (const bad of ["cross-site", "Cross-Site"]) {
          const r = await exchange(bad);
          expectBare404(r, `${label}: exchange ${bad}`);
          expect(r.headers["set-cookie"], `${label}: ${bad} cookie`).toBe(
            undefined,
          );
        }
      }
      await app.close();
      booted = undefined;
    }
  });

  // ---------------------------------------------------------------------------------------------
  // The startup token (D-46)
  // ---------------------------------------------------------------------------------------------

  it("startup token missing: 403 page for the dashboard and a JSON error for the API, no data", async () => {
    const app = await boot(adapter, AUTO);
    const page = await get(`${app.baseUrl}${PATH}/`);
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.text).toContain("startup link");
    expect(page.text).not.toContain("<script");
    expect(page.text).not.toContain(getProcessStartupToken().token);
    expect(headerProblems(page)).toEqual([]);
    for (const path of [
      "meta",
      "traces",
      "errors",
      "routes",
      "trace?id=0af7651916cd43dd8448eb211c80319c",
    ]) {
      const api = await get(`${app.baseUrl}${PATH}/api/v1/${path}`);
      expect(api.status, path).toBe(403);
      expect(api.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(api.json(), path).toEqual({
        error: { code: "forbidden", message: expect.any(String) },
      });
      expect(headerProblems(api), path).toEqual([]);
    }
    // The assets are behind the same rule.
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(
        `${uiPackage.resolveDirectory()}/manifest.json`,
        "utf8",
      ),
    ) as { files: { path: string }[] };
    const asset = manifest.files.find((f) => f.path.startsWith("assets/"));
    expect(asset).toBeDefined();
    expect((await get(`${app.baseUrl}${PATH}/${asset?.path}`)).status).toBe(
      403,
    );
  });

  it("startup token wrong: denied, no cookie set, and a token in the query of any other path admits nothing", async () => {
    const app = await boot(adapter, AUTO);
    const good = getProcessStartupToken().token;
    const wrong = [
      "wrong",
      "",
      good.slice(0, -1),
      `${good}x`,
      good.toUpperCase(),
    ];
    for (const token of wrong) {
      const r = await get(`${app.baseUrl}${PATH}/auth?token=${token}`);
      expect(r.status, `token "${token}"`).toBe(403);
      expect(r.headers.get("set-cookie"), `token "${token}"`).toBeNull();
    }
    // A token parameter is only read at <path>/auth.
    const sneaky = await get(`${app.baseUrl}${API}?token=${good}`);
    expect(sneaky.status).toBe(403);
    expect(sneaky.headers.get("set-cookie")).toBeNull();
  });

  it("startup cookie wrong or forged: still needs the token", async () => {
    const app = await boot(adapter, AUTO);
    const good = await signIn(app);
    const [name, value] = good.split("=") as [string, string];
    expect((await get(`${app.baseUrl}${API}`, { cookie: good })).status).toBe(
      200,
    );
    for (const cookie of [
      `${name}=forged`,
      `${name}=${value.slice(0, -1)}`,
      `${name}=`,
      `nestrix_session_1=${value}`, // another listener's cookie name
      `nestrix_auth_${app.port}=${value}`, // a token-cookie name never stands in for the startup cookie
      "x=y",
    ]) {
      const r = await get(`${app.baseUrl}${API}`, { cookie });
      expect(r.status, cookie).toBe(403);
    }
  });

  it("startup token right: the exchange sets an HttpOnly SameSite=Strict cookie and 303s to <path>/, then the data loads", async () => {
    const app = await boot(adapter, AUTO);
    const token = getProcessStartupToken().token;
    const exchange = await get(`${app.baseUrl}${PATH}/auth?token=${token}`);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe(`${PATH}/`);
    expect(exchange.body.length).toBe(0);
    const setCookie = exchange.headers.get("set-cookie") as string;
    expect(setCookie).toMatch(
      new RegExp(
        `^nestrix_session_${app.port}=[A-Za-z0-9_-]+; Path=${PATH}; HttpOnly; SameSite=Strict$`,
      ),
    );
    // The token never appears in the redirect or the cookie.
    expect(exchange.headers.get("location")).not.toContain(token);
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(";")[0] as string;
    const index = await get(`${app.baseUrl}${PATH}/`, { cookie });
    expect(index.status).toBe(200);
    for (const route of ["meta", "traces", "errors", "routes"]) {
      const r = await get(`${app.baseUrl}${PATH}/api/v1/${route}`, { cookie });
      expect(r.status, route).toBe(200);
    }
    // Without the cookie the same request is still refused.
    expect((await get(`${app.baseUrl}${API}`)).status).toBe(403);
  });

  it("a same-host reverse proxy that rewrites Host and adds no forwarding header is refused without the startup cookie", async () => {
    const app = await boot(adapter, AUTO);
    const proxy = await startSameHostProxy(app.port);
    cleanups.push(() => proxy.close());
    const viaProxy = (path: string, headers: Record<string, string> = {}) =>
      get(`http://127.0.0.1:${proxy.port}${path}`, {
        host: "dashboard.public.example",
        ...headers,
      });
    const denied = await viaProxy(API);
    // What the app saw is exactly the nginx-default shape: loopback Host, no forwarding header.
    const seen = proxy.lastUpstreamHeaders();
    expect(seen.host).toBe(`127.0.0.1:${app.port}`);
    for (const h of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "via",
    ]) {
      expect(seen[h], h).toBeUndefined();
    }
    // Every per-request loopback check passed; the missing cookie is what refuses it.
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain('"traces"');
    expect((await viaProxy(`${PATH}/`)).status).toBe(403);
    const wrongToken = await viaProxy(`${PATH}/auth?token=nope`);
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.headers.get("set-cookie")).toBeNull();
    // Control: the visitor who holds the cookie (the developer) passes through the same proxy,
    // which is why the cookie is the barrier and why the link must stay private.
    const cookie = await signIn(app);
    expect((await viaProxy(API, { cookie })).status).toBe(200);
  });

  it("startupToken: false admits the same-host reverse proxy (documented limit of 'auto'), but not a foreign peer's headers", async () => {
    const app = await boot(adapter, AUTO_NO_TOKEN);
    const proxy = await startSameHostProxy(app.port);
    cleanups.push(() => proxy.close());
    const viaProxy = await get(`http://127.0.0.1:${proxy.port}${API}`, {
      host: "dashboard.public.example",
    });
    expect(viaProxy.status).toBe(200);
    // The opt-out removes the token requirement only; every per-request rule still applies.
    expectBare404(
      await rawRequest(app.port, http11(API, ["Host: evil.example"])),
      "foreign Host",
    );
    expectBare404(
      await rawRequest(app.port, local(app, API, ["X-Forwarded-For: 1.2.3.4"])),
      "forwarded",
    );
    expect(
      (await rawRequest(app.port, local(app, API))).status,
      "control",
    ).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // 'enabled' with auth
  // ---------------------------------------------------------------------------------------------

  it("token auth: Authorization: Bearer admits, a wrong or missing token does not", async () => {
    const app = await boot(adapter, ENABLED);
    expect((await get(`${app.baseUrl}${API}`, BEARER)).status).toBe(200);
    const bad: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(1)}` },
      { authorization: "Bearer " },
      { authorization: TOKEN }, // no scheme
      { authorization: `Basic ${TOKEN}` },
    ];
    for (const headers of bad) {
      expectBare404(
        await get(`${app.baseUrl}${API}`, headers),
        JSON.stringify(headers),
      );
    }
    // The token in a query string is not credentials outside the exchange path.
    expectBare404(
      await get(`${app.baseUrl}${API}?token=${TOKEN}`),
      "?token= on the API",
    );
  });

  it("token auth: the exchange sets a cookie that admits, a wrong token and a forged cookie do not", async () => {
    const app = await boot(adapter, ENABLED);
    const wrong = await get(
      `${app.baseUrl}${PATH}/auth?token=${"y".repeat(40)}`,
    );
    expectBare404(wrong, "wrong token at the exchange");
    const exchange = await get(`${app.baseUrl}${PATH}/auth?token=${TOKEN}`);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe(`${PATH}/`);
    const setCookie = exchange.headers.get("set-cookie") as string;
    expect(setCookie).toMatch(
      new RegExp(
        `^nestrix_auth_${app.port}=[A-Za-z0-9_-]+; Path=${PATH}; HttpOnly; SameSite=Strict$`,
      ),
    );
    // The browser never stores the configured token itself.
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(";")[0] as string;
    expect((await get(`${app.baseUrl}${API}`, { cookie })).status).toBe(200);
    const [name] = cookie.split("=") as [string];
    for (const forged of [`${name}=forged`, `${name}=${TOKEN}`, `${name}=`]) {
      expectBare404(
        await get(`${app.baseUrl}${API}`, { cookie: forged }),
        forged,
      );
    }
  });

  it("authorize receives the adapter's raw request before any Nest guard; only `true` admits; a throw or a rejection denies", async () => {
    const seen: Record<string, unknown>[] = [];
    const app = await boot(adapter, {
      ...BASE,
      ui: {
        enabled: true,
        auth: {
          authorize: (request: Record<string, unknown>) => {
            seen.push(request);
            const raw = (request.raw ?? request) as {
              headers: Record<string, string>;
            };
            const mode = raw.headers["x-mode"];
            if (mode === "throw") throw new Error("authorize fault");
            if (mode === "reject") return Promise.reject(new Error("no"));
            if (mode === "truthy") return "yes";
            if (mode === "undefined") return undefined;
            if (mode === "false") return false;
            return mode === "allow";
          },
        },
      },
    });
    const ask = (mode: string) =>
      get(`${app.baseUrl}${API}`, { "x-mode": mode });
    expect((await ask("allow")).status).toBe(200);
    for (const mode of ["throw", "reject", "truthy", "undefined", "false"]) {
      expectBare404(await ask(mode), `authorize ${mode}`);
    }
    expect(seen).toHaveLength(6);
    // The adapter's own request object: Fastify's wraps the raw one, Express and platform-node
    // hand over the IncomingMessage. No Nest guard has run, so nothing is attached.
    const first = seen[0] as Record<string, unknown>;
    if (adapter === "fastify") expect(first).toHaveProperty("raw");
    else expect(first).toHaveProperty("socket");
    expect(first.user).toBeUndefined();
  });

  it("authorize runs before any Nest guard: a global guard never runs for dashboard paths, and authorize sees nothing it attached", async () => {
    const guardRan: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const guard = {
      canActivate(context: {
        switchToHttp(): { getRequest(): Record<string, unknown> };
      }): boolean {
        const req = context.switchToHttp().getRequest();
        req.user = { id: "from-the-guard" };
        guardRan.push(String(req.url));
        return true;
      },
    };
    const app = await boot(
      adapter,
      {
        ...BASE,
        ui: {
          enabled: true,
          auth: {
            authorize: (request: Record<string, unknown>) => {
              seen.push(request);
              return true;
            },
          },
        },
      },
      { configure: (a) => a.useGlobalGuards(guard) },
    );
    for (const path of [`${PATH}/`, API, `${PATH}/api/v1/traces`]) {
      expect((await get(`${app.baseUrl}${path}`)).status, path).toBe(200);
    }
    expect(seen.length, "authorize ran for each dashboard request").toBe(3);
    for (const request of seen) {
      expect(request.user, "authorize saw a user a guard attached").toBe(
        undefined,
      );
      // Fastify's `Request` wraps the raw one; look at both.
      expect((request.raw as { user?: unknown } | undefined)?.user).toBe(
        undefined,
      );
    }
    expect(guardRan, "no guard ran for a dashboard path").toEqual([]);
    // Control: the guard is live, and it runs for the host's own route.
    expect((await get(`${app.baseUrl}/h/ok`)).text).toBe("ok");
    expect(guardRan, "control: guard ran for /h/ok").toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Read-only
  // ---------------------------------------------------------------------------------------------

  it("the dashboard is read-only: POST, PUT, PATCH and DELETE with valid credentials reach no dashboard handler", async () => {
    const app = await boot(adapter, ENABLED);
    const send = (method: string): Promise<RawReply> =>
      rawRequest(
        app.port,
        local(
          app,
          API,
          [`Authorization: Bearer ${TOKEN}`, "Content-Length: 0"],
          method,
        ),
      );
    // Control: the same credentials on GET are served by the dashboard.
    const ok = await send("GET");
    expect(ok.status).toBe(200);
    expect(ok.headers["x-robots-tag"]).toBe("noindex");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await send(method);
      expect(r.status, method).toBe(404);
      expect(r.headers["x-robots-tag"], `${method}: robots`).toBeUndefined();
      expect(
        r.headers["content-security-policy"],
        `${method}: csp`,
      ).toBeUndefined();
      expect(r.headers["cache-control"], `${method}: cache`).not.toBe(
        "no-store",
      );
      // Nest's own "Cannot <METHOD> ..." 404, not the dashboard's.
      expect(r.body, method).toContain(`Cannot ${method}`);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------------------------

  it("emits no Access-Control-* header with permissive host CORS, on success and error paths", async () => {
    const app = await boot(adapter, ENABLED, { cors: true });
    // Control: the host's CORS is really on, for the host's own routes.
    const host = await get(`${app.baseUrl}/h/json`, { origin: EVIL_ORIGIN });
    expect(host.headers.get("access-control-allow-origin")).toBe(EVIL_ORIGIN);
    expect(host.headers.get("access-control-allow-credentials")).toBe("true");

    const ask = { ...BEARER, origin: EVIL_ORIGIN };
    const responses: [string, Fetched][] = [
      ["index", await get(`${app.baseUrl}${PATH}/`, ask)],
      ["meta", await get(`${app.baseUrl}${API}`, ask)],
      ["traces", await get(`${app.baseUrl}${PATH}/api/v1/traces`, ask)],
      ["400", await get(`${app.baseUrl}${PATH}/api/v1/traces?limit=0`, ask)],
      [
        "unknown id",
        await get(
          `${app.baseUrl}${PATH}/api/v1/trace?id=${"a".repeat(32)}`,
          ask,
        ),
      ],
      [
        "denied 404",
        await get(`${app.baseUrl}${API}`, { origin: EVIL_ORIGIN }),
      ],
      [
        "exchange 303",
        await get(`${app.baseUrl}${PATH}/auth?token=${TOKEN}`, {
          origin: EVIL_ORIGIN,
        }),
      ],
      [
        "cross-site 404",
        await get(`${app.baseUrl}${API}`, {
          ...ask,
          "sec-fetch-site": "cross-site",
        }),
      ],
    ];
    expect(responses[0]?.[1].status).toBe(200);
    expect(responses[1]?.[1].status).toBe(200);
    expect(responses[3]?.[1].status).toBe(400);
    expect(responses[4]?.[1].status).toBe(404);
    expect(responses[5]?.[1].status).toBe(404);
    expect(responses[6]?.[1].status).toBe(303);
    for (const [label, r] of responses) {
      expect(corsHeaders(r.headers), label).toEqual([]);
    }

    // And in 'auto', where the 403 page is an error path of its own.
    await app.close();
    booted = undefined;
    const auto = await boot(adapter, AUTO, { cors: true });
    for (const path of [`${PATH}/`, API]) {
      const r = await get(`${auto.baseUrl}${path}`, { origin: EVIL_ORIGIN });
      expect(r.status, path).toBe(403);
      expect(corsHeaders(r.headers), path).toEqual([]);
    }
  });

  it("preflight (OPTIONS) for a dashboard path is answered by the host's CORS layer: the documented limit", async () => {
    const app = await boot(adapter, ENABLED, { cors: true });
    const preflight = (path: string) =>
      rawRequest(
        app.port,
        local(
          app,
          path,
          [
            `Origin: ${EVIL_ORIGIN}`,
            "Access-Control-Request-Method: GET",
            "Access-Control-Request-Headers: authorization",
          ],
          "OPTIONS",
        ),
      );
    const host = await preflight("/h/json");
    expect(host.status).toBeLessThan(300);
    expect(host.headers["access-control-allow-origin"]).toBe(EVIL_ORIGIN);
    const dash = await preflight(API);
    // Recorded behaviour (architecture §4.7): the preflight never reaches a dashboard handler (the
    // routes are GET only), so the host's allow headers are what answers it. The dashboard does
    // not claim to control this. The protection is that the real GET carries no allow header, so
    // the cross-origin page cannot read it; the dashboard API is read-only.
    expect(dash.headers["access-control-allow-origin"]).toBe(EVIL_ORIGIN);
    expect(dash.headers["content-security-policy"]).toBeUndefined();
    // ... and the actual GET from that origin, with no credentials the page could not know, is
    // refused with no allow header.
    const actual = await get(`${app.baseUrl}${API}`, { origin: EVIL_ORIGIN });
    expectBare404(actual, "the actual request after the preflight");
  });

  // ---------------------------------------------------------------------------------------------
  // What served responses carry
  // ---------------------------------------------------------------------------------------------

  it("every served response carries X-Robots-Tag, the CSP and nosniff (and the rest of the set)", async () => {
    const app = await boot(adapter, ENABLED);
    const index = await get(`${app.baseUrl}${PATH}/`, BEARER);
    const meta = await get(`${app.baseUrl}${API}`, BEARER);
    const bad = await get(
      `${app.baseUrl}${PATH}/api/v1/traces?limit=0`,
      BEARER,
    );
    const exchange = await get(`${app.baseUrl}${PATH}/auth?token=${TOKEN}`);
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(
        `${uiPackage.resolveDirectory()}/manifest.json`,
        "utf8",
      ),
    ) as { files: { path: string }[] };
    const assetPath = manifest.files.find((f) => f.path.startsWith("assets/"))
      ?.path as string;
    const asset = await get(`${app.baseUrl}${PATH}/${assetPath}`, BEARER);
    for (const [label, r, cache] of [
      ["index", index, undefined],
      ["meta", meta, undefined],
      ["400", bad, undefined],
      ["303", exchange, undefined],
      ["asset", asset, "public, max-age=31536000, immutable"],
    ] as const) {
      expect(r.headers.get("x-robots-tag"), label).toBe("noindex");
      expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(r.headers.get("content-security-policy"), label).toContain(
        DASHBOARD_CSP_FRAGMENT,
      );
      expect(headerProblems(r, cache), label).toEqual([]);
    }
    // The CSP has no way to run inline script or load from another origin.
    const csp = index.headers.get("content-security-policy") as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("frame-ancestors 'none'");

    // The 403 page of 'auto' carries them too.
    await app.close();
    booted = undefined;
    const auto = await boot(adapter, AUTO);
    const page = await get(`${auto.baseUrl}${PATH}/`);
    expect(page.status).toBe(403);
    expect(headerProblems(page)).toEqual([]);
  });

  it("no inline executable script: the config block is application/json and every other script is an external same-origin file", async () => {
    const app = await boot(adapter, ENABLED);
    const index = await get(`${app.baseUrl}${PATH}/`, BEARER);
    expect(index.status).toBe(200);
    const scripts = [
      ...index.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    const configs = scripts.filter((s) =>
      /id="nestrix-config"/.test(s[1] ?? ""),
    );
    expect(configs).toHaveLength(1);
    const config = configs[0] as RegExpMatchArray;
    expect(config[1]).toMatch(/type="application\/json"/);
    expect(JSON.parse(config[2] as string)).toEqual({
      apiBase: `${PATH}/api/v1`,
      path: PATH,
      protocolVersion: 1,
    });
    for (const s of scripts) {
      if (s === config) continue;
      // An executable script has a `src` and an empty body.
      expect(s[1], "script attributes").toMatch(/\bsrc="\.\/assets\//);
      expect((s[2] as string).trim(), "script body").toBe("");
    }
    // No inline event handlers or javascript: URLs.
    expect(index.text).not.toMatch(/\son[a-z]+\s*=/i);
    expect(index.text).not.toMatch(/javascript:/i);
    // The configured path cannot break out of the JSON block: a path is validated at resolution,
    // so a closing tag never reaches the page.
    expect(config[2]).not.toContain("</");
  });

  it("a denied request reveals nothing: a bare 404 with an empty body and no dashboard headers, on every route", async () => {
    const app = await boot(adapter, ENABLED);
    const cases: [string, Fetched][] = [];
    for (const path of [
      `${PATH}`,
      `${PATH}/`,
      `${PATH}/auth`,
      API,
      `${PATH}/api/v1/traces`,
      `${PATH}/api/v1/errors`,
      `${PATH}/api/v1/routes`,
      `${PATH}/api/v1/trace?id=${"a".repeat(32)}`,
      `${PATH}/api/v1/traces?limit=0`, // invalid parameters are not looked at before access
    ]) {
      cases.push([path, await get(`${app.baseUrl}${path}`)]);
    }
    for (const [path, r] of cases) expectBare404(r, path);
    // Control: with credentials the same API answers, so the 404 above is a decision, not a missing route.
    expect((await get(`${app.baseUrl}${API}`, BEARER)).status).toBe(200);
  });
});

// -------------------------------------------------------------------------------------------------
// Unit level: the rules that cannot always be driven over a socket in this environment
// -------------------------------------------------------------------------------------------------

describe("checkAccess, with fake requests", () => {
  const uiAuto = resolveUi({ startupToken: false }, {});

  it("checkAccess denies a non-loopback socket peer (covers the real-socket test when this machine has no LAN address)", async () => {
    const fake = (remoteAddress: string) => ({
      socket: { remoteAddress, localPort: 3000 },
      headers: { host: "localhost:3000" },
      rawHeaders: ["Host", "localhost:3000"],
      url: "/_nestrix/api/v1/meta",
    });
    // The resolver's own output decides the mode; assert it is the one under test.
    expect(uiAuto.mode).toBe("auto");
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.9.9.9"]) {
      expect(
        (await checkAccess(fake(peer), uiAuto, undefined)).outcome,
        peer,
      ).toBe("allow");
    }
    for (const peer of [
      "192.168.1.10",
      "10.0.0.1",
      "203.0.113.9",
      "::ffff:192.168.1.10",
      "fe80::1",
      "2001:db8::1",
      "128.0.0.1",
      "",
    ]) {
      expect(
        (await checkAccess(fake(peer), uiAuto, undefined)).outcome,
        peer,
      ).toBe("deny");
    }
  });
});
