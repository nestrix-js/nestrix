// Global state: no host SDK. Nestrix owns the provider (dashboard on, export off).
// P3-03: the `service.version` chain (D-63), the version on the Nestrix-owned resource and in
// `meta`, and `release`, `user` and `type` end to end through `GET api/v1/traces` on a real app.
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  UseGuards,
} from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildResource } from "../src/otel/resource.js";
import {
  resolveOptions,
  resolveServiceVersion,
} from "../src/resolve-options.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  TOKEN,
} from "./dashboard-fixture.js";

describe("service.version chain (D-63)", () => {
  const all = {
    OTEL_RESOURCE_ATTRIBUTES: "team=core,service.version=from-otel-env",
    GIT_SHA: "abc1234",
    npm_package_version: "1.2.3",
  };

  it("takes the first set value: option, resourceAttributes, OTEL_RESOURCE_ATTRIBUTES, GIT_SHA, npm_package_version", () => {
    const attrs = { "service.version": "from-attributes" };
    expect(
      resolveServiceVersion(
        { serviceVersion: "from-option", resourceAttributes: attrs },
        all,
      ),
    ).toBe("from-option");
    expect(resolveServiceVersion({ resourceAttributes: attrs }, all)).toBe(
      "from-attributes",
    );
    expect(resolveServiceVersion({}, all)).toBe("from-otel-env");
    expect(
      resolveServiceVersion(
        {},
        { ...all, OTEL_RESOURCE_ATTRIBUTES: "team=core" },
      ),
    ).toBe("abc1234");
    expect(
      resolveServiceVersion(
        {},
        { npm_package_version: "1.2.3", GIT_SHA: undefined },
      ),
    ).toBe("1.2.3");
    expect(resolveServiceVersion({}, {})).toBeUndefined();
  });

  it("skips blank values and a malformed OTEL_RESOURCE_ATTRIBUTES", () => {
    expect(
      resolveServiceVersion(
        { serviceVersion: "  ", resourceAttributes: { "service.version": "" } },
        { OTEL_RESOURCE_ATTRIBUTES: "service.version=", GIT_SHA: " sha " },
      ),
    ).toBe("sha");
    expect(
      resolveServiceVersion(
        {},
        { OTEL_RESOURCE_ATTRIBUTES: "service.version=x,broken", GIT_SHA: "g" },
      ),
    ).toBe("g");
    expect(
      resolveServiceVersion(
        {},
        { OTEL_RESOURCE_ATTRIBUTES: "service.version=1%2E0", GIT_SHA: "g" },
      ),
    ).toBe("1.0");
  });

  it("rejects a serviceVersion that is not a string at forRoot", () => {
    expect(() =>
      resolveOptions({ serviceVersion: 3 as unknown as string }, {}),
    ).toThrow(/serviceVersion must be a string/);
    expect(resolveOptions({}, { GIT_SHA: "g" }).serviceVersion).toBe("g");
  });

  it("accepts a numeric or boolean resourceAttributes service.version over GIT_SHA", () => {
    const resolved = resolveOptions(
      { resourceAttributes: { "service.version": 2 } },
      { GIT_SHA: "abc" },
    );
    expect(resolved.serviceVersion).toBe("2");
    expect(buildResource(resolved).attributes["service.version"]).toBe("2");
    expect(
      resolveServiceVersion(
        { resourceAttributes: { "service.version": true } },
        { GIT_SHA: "abc" },
      ),
    ).toBe("true");
  });

  it("rejects a serviceVersion longer than 255 characters at forRoot", () => {
    expect(() =>
      resolveOptions({ serviceVersion: "v".repeat(256) }, {}),
    ).toThrow(/serviceVersion must be at most 255 characters/);
    expect(
      resolveOptions({ serviceVersion: "v".repeat(255) }, {}).serviceVersion,
    ).toHaveLength(255);
  });

  it("puts the resolved version on the owned resource, over OTEL_RESOURCE_ATTRIBUTES", () => {
    const env = {
      OTEL_RESOURCE_ATTRIBUTES: "service.version=from-otel-env",
      GIT_SHA: "abc1234",
    };
    const resolved = resolveOptions({}, env);
    expect(buildResource(resolved).attributes["service.version"]).toBe(
      "from-otel-env",
    );
    const withOption = resolveOptions({ serviceVersion: "2.0.0" }, env);
    expect(buildResource(withOption).attributes["service.version"]).toBe(
      "2.0.0",
    );
    const none = resolveOptions({}, {});
    expect(buildResource(none).attributes["service.version"]).toBeUndefined();
  });
});

@Injectable()
class SetUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    request.user = { id: "u-17" };
    return true;
  }
}

@Controller("r")
class ReleaseController {
  @Get("me")
  @UseGuards(SetUserGuard)
  me(): string {
    return "me";
  }

  @Get("anon")
  anon(): string {
    return "anon";
  }
}

interface Item {
  traceId: string;
  route?: string;
  type: string;
  release?: string;
  user?: string;
}

describe("end to end with a Nestrix-owned provider (Express)", () => {
  let booted: DashboardApp;
  let api: string;

  beforeAll(async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      controllers: [ReleaseController],
      nestrix: {
        serviceName: "release-test",
        serviceVersion: "9.9.9-test",
        user: (request) => (request as { user?: { id?: string } }).user?.id,
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    api = `${booted.baseUrl}/_nestrix/api/v1`;
  });
  afterAll(async () => {
    await booted.close();
  });

  async function items(query = ""): Promise<Item[]> {
    const r = await get(`${api}/traces${query}`, BEARER);
    expect(r.status).toBe(200);
    return (r.json() as { items: Item[] }).items;
  }

  it("meta reports the resolved service.version", async () => {
    const meta = (await get(`${api}/meta`, BEARER)).json() as {
      service: { name?: string; version?: string };
      sampling: { owner: string };
    };
    expect(meta.sampling.owner).toBe("nestrix");
    expect(meta.service).toMatchObject({
      name: "release-test",
      version: "9.9.9-test",
    });
  });

  it("lists traces with type, release and user, and filters by each", async () => {
    expect((await fetch(`${booted.baseUrl}/r/me`)).status).toBe(200);
    expect((await fetch(`${booted.baseUrl}/r/anon`)).status).toBe(200);
    let listed: Item[] = [];
    const poll = async () => {
      listed = await items();
      return listed;
    };
    for (let i = 0; i < 100 && (await poll()).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const me = listed.find((i) => i.route === "/r/me");
    const anon = listed.find((i) => i.route === "/r/anon");
    expect(me).toMatchObject({
      type: "http",
      release: "9.9.9-test",
      user: "u-17",
    });
    expect(anon).toMatchObject({ type: "http", release: "9.9.9-test" });
    expect(anon && "user" in anon).toBe(false);

    expect((await items("?user=u-17")).map((i) => i.route)).toEqual(["/r/me"]);
    expect(await items("?user=u-18")).toEqual([]);
    expect((await items("?release=9.9.9-test")).length).toBe(2);
    expect(await items("?release=9.9.8")).toEqual([]);
    expect((await items("?type=http")).length).toBe(2);
    expect(await items("?type=job")).toEqual([]);
    const bad = await get(`${api}/traces?type=cron`, BEARER);
    expect(bad.status).toBe(400);
  });
});

@Injectable()
class SetRedactedUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    request.user = { id: "u-redacted" };
    return true;
  }
}

@Controller("q")
class RedactedUserController {
  @Get("me")
  @UseGuards(SetRedactedUserGuard)
  me(): string {
    return "me";
  }
}

// The store is process-global, so this block uses its own route and user id.
describe("user.id removed by redact (Express)", () => {
  let booted: DashboardApp;
  let api: string;

  beforeAll(async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      controllers: [RedactedUserController],
      nestrix: {
        serviceName: "release-redact-test",
        user: (request) => (request as { user?: { id?: string } }).user?.id,
        redact: (span) => {
          delete span.attributes["user.id"];
          return undefined;
        },
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    api = `${booted.baseUrl}/_nestrix/api/v1`;
  });
  afterAll(async () => {
    await booted.close();
  });

  it("stores no user on the trace and the user filter finds nothing", async () => {
    expect((await fetch(`${booted.baseUrl}/q/me`)).status).toBe(200);
    let me: Item | undefined;
    for (let i = 0; i < 100 && me === undefined; i++) {
      const r = await get(`${api}/traces`, BEARER);
      me = (r.json() as { items: Item[] }).items.find(
        (item) => item.route === "/q/me",
      );
      if (me === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(me).toBeDefined();
    expect(me && "user" in me).toBe(false);
    const r = await get(`${api}/traces?user=u-redacted`, BEARER);
    expect(r.status).toBe(200);
    expect((r.json() as { items: Item[] }).items).toEqual([]);
  });
});
