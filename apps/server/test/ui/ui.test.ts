// The @nestrix-js/ui build served at / (backlog P5-04): manifest-based, CSP, caching, traversal.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION as PROTOCOL } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UI_CSP } from "../../src/auth/http.js";
import {
  loadUi,
  PROTOCOL_VERSION,
  resolveUiDirectory,
} from "../../src/ui/assets.js";
import { UiController, UiFiles } from "../../src/ui/ui.controller.js";
import { rawRequest, signedCookie, startAuthServer } from "../auth/helpers.js";
import type { TestServer } from "../ingest/helpers.js";

interface Entry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

const uiDir = resolveUiDirectory() as string;
const manifest = JSON.parse(
  readFileSync(join(uiDir, "manifest.json"), "utf8"),
) as { files: Entry[] };
const assets = manifest.files.filter((f) => f.path.startsWith("assets/"));

let server: TestServer;
beforeAll(async () => {
  server = await startAuthServer();
});
afterAll(async () => {
  await server?.close();
});

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    headers: { cookie: signedCookie(), ...headers },
    redirect: "manual",
  });
}

it("speaks the protocol version of @nestrix-js/protocol", () => {
  expect(PROTOCOL_VERSION).toBe(PROTOCOL);
});

describe("GET /", () => {
  it("serves index.html with the dashboard CSP, uncached, configured for the server", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain('<base href="/"');
    expect(html).toContain(
      `{"apiBase":"/api/v1","path":"","protocolVersion":${PROTOCOL_VERSION}}`,
    );
    expect(html).not.toContain("__NESTRIX_");
    // Every script and stylesheet the page loads is a served asset.
    const refs = [
      ...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g),
    ].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(assets.map((a) => a.path)).toContain(ref);
    }
  });

  it("answers HEAD", async () => {
    const res = await fetch(`${server.baseUrl}/`, {
      method: "HEAD",
      headers: { cookie: signedCookie() },
    });
    expect(res.status).toBe(200);
  });

  it("redirects to /login without a session", async () => {
    const res = await fetch(`${server.baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
  });
});

describe("GET /assets/<file>", () => {
  it("serves every asset in the manifest with its content type, immutable, under the CSP", async () => {
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const res = await get(`/${asset.path}`);
      expect(res.status, asset.path).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.contentType);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = Buffer.from(await res.arrayBuffer());
      expect(createHash("sha256").update(body).digest("hex")).toBe(
        asset.sha256,
      );
    }
  });

  it("requires a session", async () => {
    const res = await fetch(`${server.baseUrl}/${assets[0]?.path}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(303);
  });

  it("serves nothing outside the manifest's index.html and assets/, whatever the spelling", async () => {
    const asset = assets[0]?.path.slice("assets/".length) ?? "";
    const targets = [
      "/manifest.json",
      "/index.js",
      "/index.js.map",
      "/index.d.ts",
      "/THIRD_PARTY_NOTICES.txt",
      "/index.html",
      "/assets/",
      "/assets",
      "/assets/../manifest.json",
      "/assets/..%2Fmanifest.json",
      "/assets/%2e%2e%2fmanifest.json",
      "/assets/%2E%2E/manifest.json",
      "/assets/..%5Cmanifest.json",
      "/assets/....//manifest.json",
      "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/..%2F..%2F..%2F..%2Fetc%2Fpasswd",
      "/assets/%00",
      `/assets/${asset}%00.html`,
      `/assets/${asset}/x`,
      `/assets/${asset.toUpperCase()}`,
      "/assets/manifest.json",
      "/assets/.",
      "/assets/..",
    ];
    for (const target of targets) {
      const res = await rawRequest(server.baseUrl, "GET", target, {
        cookie: signedCookie(),
      });
      expect([400, 404], target).toContain(res.status);
      expect(res.body, target).not.toContain('"sha256"');
      expect(res.body, target).not.toContain("root:");
    }
  });
});

describe("loading the build", () => {
  function fakeBuild(
    files: Record<string, string>,
    manifestFiles?: Array<Partial<Entry>>,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "nestrix-ui-"));
    const entries: Entry[] = [];
    for (const [path, text] of Object.entries(files)) {
      const full = join(dir, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      entries.push({
        path,
        size: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        contentType: path.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "text/javascript; charset=utf-8",
      });
    }
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ files: manifestFiles ?? entries }),
    );
    return dir;
  }
  const index =
    '<base href="__NESTRIX_BASE_HREF__"><script type="application/json">"__NESTRIX_CONFIG__"</script>';

  it("reads only index.html and single-segment assets", () => {
    const dir = fakeBuild({
      "index.html": index,
      "assets/a.js": "a",
      "assets/sub/b.js": "b",
      "secret.txt": "nope",
    });
    const bundle = loadUi(dir);
    expect([...bundle.assets.keys()]).toEqual(["assets/a.js"]);
    expect(bundle.index.toString()).toContain('<base href="/">');
  });

  it("never reads a manifest path outside the build", () => {
    const dir = fakeBuild({ "index.html": index }, [
      {
        path: "index.html",
        size: Buffer.byteLength(index),
        sha256: createHash("sha256").update(index).digest("hex"),
        contentType: "text/html; charset=utf-8",
      },
      {
        path: "assets/../../../../etc/passwd",
        size: 1,
        sha256: "x",
        contentType: "text/plain",
      },
      {
        path: "../outside.js",
        size: 1,
        sha256: "x",
        contentType: "text/plain",
      },
    ]);
    expect([...loadUi(dir).assets.keys()]).toEqual([]);
  });

  it("refuses a build that does not match its manifest or lacks its placeholders", () => {
    const dir = fakeBuild({ "index.html": index, "assets/a.js": "a" });
    writeFileSync(join(dir, "assets", "a.js"), "b");
    expect(() => loadUi(dir)).toThrow(/assets\/a\.js does not match/);
    expect(() => loadUi(fakeBuild({ "index.html": "<html>" }))).toThrow(
      /placeholders/,
    );
    expect(() => loadUi(fakeBuild({ "assets/a.js": "a" }))).toThrow(
      /index\.html is missing/,
    );
  });

  it("answers 503 when the build is missing", () => {
    const files = new UiFiles();
    files.resolveDirectory = () => undefined;
    files.onModuleInit();
    expect(files.bundle).toBeUndefined();
    const controller = new UiController(files);
    const written: { status?: number } = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      statusCode: 0,
      getHeaderNames: () => [],
      setHeader: () => {},
      removeHeader: () => {},
      end() {
        written.status = this.statusCode;
      },
    };
    controller.index(res as never);
    expect(written.status).toBe(503);
  });
});
