import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { renderProfile } from "../src/render/profile.js";
import { meta } from "./fixtures.js";
import { mockServer } from "./helpers.js";

const TOKEN = "k".repeat(40);

describe("loadConfig", () => {
  it("normalises the URL and defaults the timeout", () => {
    expect(
      loadConfig({
        NESTRIX_URL: "http://localhost:3000/_nestrix/",
        NESTRIX_TOKEN: TOKEN,
      }),
    ).toEqual({
      url: "http://localhost:3000/_nestrix",
      token: TOKEN,
      timeoutMs: 10_000,
    });
    expect(
      loadConfig({
        NESTRIX_URL: "https://nestrix.example.com//",
        NESTRIX_TOKEN: TOKEN,
        NESTRIX_TIMEOUT_MS: "2500",
      }),
    ).toEqual({
      url: "https://nestrix.example.com",
      token: TOKEN,
      timeoutMs: 2500,
    });
  });

  it("drops a query string and fragment from the URL", () => {
    expect(
      loadConfig({
        NESTRIX_URL: "http://h:1/p?token=abc#x",
        NESTRIX_TOKEN: TOKEN,
      }).url,
    ).toBe("http://h:1/p");
  });

  it.each([
    [{}, /NESTRIX_URL is not set/],
    [{ NESTRIX_URL: "not a url", NESTRIX_TOKEN: TOKEN }, /not a valid URL/],
    [
      { NESTRIX_URL: "ftp://h/", NESTRIX_TOKEN: TOKEN },
      /http:\/\/ or https:\/\//,
    ],
    [
      { NESTRIX_URL: "http://u:p@h/", NESTRIX_TOKEN: TOKEN },
      /user name or password/,
    ],
    [
      { NESTRIX_URL: "http://h/" },
      /NESTRIX_TOKEN is not set.*ui\.auth\.token/s,
    ],
    [
      { NESTRIX_URL: "http://h/", NESTRIX_TOKEN: "  " },
      /NESTRIX_TOKEN is not set/,
    ],
    [
      {
        NESTRIX_URL: "http://h/",
        NESTRIX_TOKEN: TOKEN,
        NESTRIX_TIMEOUT_MS: "5",
      },
      /NESTRIX_TIMEOUT_MS/,
    ],
  ])("rejects %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe("renderProfile", () => {
  const base = {
    id: "0123456789abcdef",
    startedAtUnixMs: 1,
    durationMs: 2000,
    actualDurationMs: 2001,
    startPauseMs: 12.5,
    samples: 100,
    bytes: 10,
  };
  const flame = {
    functionName: "(root)",
    url: "",
    line: 0,
    selfSamples: 0,
    totalSamples: 40,
    children: [],
  };

  it("lists functions with their share of non-idle samples and a short location", () => {
    const text = renderProfile({
      ...base,
      flame,
      topFunctions: [
        {
          functionName: "hot",
          url: "file:///app/dist/hot.js",
          line: 7,
          column: 1,
          selfSamples: 30,
          totalSamples: 30,
        },
        {
          functionName: "dep",
          url: "file:///home/me/proj/node_modules/.pnpm/x@1/node_modules/x/lib/a.js",
          line: 3,
          column: 1,
          selfSamples: 10,
          totalSamples: 12,
        },
      ],
    });
    expect(text).toContain("1. 75% hot /app/dist/hot.js:7 (self 30 samples");
    expect(text).toContain("2. 25% dep node_modules/x/lib/a.js:3");
    expect(text).toContain("paused the app for 12.5ms");
  });

  it("says so when nothing ran", () => {
    const text = renderProfile({
      ...base,
      topFunctions: [],
      flame: { ...flame, totalSamples: 0 },
    });
    expect(text).toContain("idle for the whole capture");
  });
});

describe("the nestrix-mcp program", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "nestrix-mcp-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("exits with a clear message on stderr and nothing on stdout when NESTRIX_URL is missing", () => {
    const result = spawnSync(process.execPath, [cli], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("nestrix-mcp: NESTRIX_URL is not set");
  });

  it("serves MCP over stdio, also when started through a symlink as npx does", async () => {
    const mock = await mockServer((_m, url, headers) =>
      headers.authorization === `Bearer ${TOKEN}` &&
      url.pathname === "/api/v1/meta"
        ? { status: 200, body: meta() }
        : {
            status: 401,
            body: { error: { code: "unauthorized", message: "no" } },
          },
    );
    const link = join(dir, "nestrix-mcp");
    symlinkSync(cli, link);
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [link],
      env: {
        PATH: process.env.PATH ?? "",
        NESTRIX_URL: `${mock.url}/`,
        NESTRIX_TOKEN: TOKEN,
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      // The server reports this package's own version, not a hard-coded one.
      const pkg = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(client.getServerVersion()).toEqual({
        name: "nestrix",
        version: pkg.version,
      });
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(9);
      const result = await client.callTool({ name: "overview", arguments: {} });
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain("Nestrix dashboard (embedded in one app)");
      expect(mock.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await client.close();
      await mock.close();
    }
  });
});
