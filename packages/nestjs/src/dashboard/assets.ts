/**
 * The built dashboard (`@nestrix/ui`): finding it, reading its files into memory, and templating
 * `index.html` (architecture §4.6 "Assets" and "Base path"; backlog P2-06).
 *
 * `@nestrix/ui` is an optional peer. It is located with `createRequire().resolve()`, which is
 * synchronous, so nothing here needs a top-level `await` (AGENTS.md rule 4) or a dynamic
 * `import()`: its Node entry is never loaded, only the directory it lives in, where
 * `manifest.json` lists every file (path, size, sha256, content type).
 *
 * Only `index.html` and the files under `assets/` are served (backlog P2-06, "Settled"): never
 * `index.js`, `.d.ts`, source maps or `THIRD_PARTY_NOTICES.txt`. Every served file is read once,
 * checked against the manifest's size and sha256, and kept in memory.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const UI_PACKAGE = "@nestrix/ui";
export const BASE_HREF_PLACEHOLDER = "__NESTRIX_BASE_HREF__";
/** With its quotes: the whole quoted token is replaced by the JSON. */
export const CONFIG_PLACEHOLDER = '"__NESTRIX_CONFIG__"';

/** A served file. */
export interface UiAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface UiBundle {
  /** `index.html` with its two placeholders. */
  readonly indexTemplate: string;
  /** Path relative to the dashboard path (`assets/index-abc.js`) to the file. */
  readonly assets: ReadonlyMap<string, UiAsset>;
}

/** Served asset paths: one segment under `assets/`, characters every adapter's router takes literally. */
const ASSET_PATH = /^assets\/[A-Za-z0-9._-]+$/;
/** A header value Node accepts and that cannot split a header. */
const CONTENT_TYPE = /^[\x20-\x7e]{1,200}$/;

/**
 * How `@nestrix/ui` is found. Replaceable for tests (a test sets `resolveDirectory` to simulate an
 * absent package). Internal; not exported from the package entry.
 */
export const uiPackage = {
  /** The directory holding the built dashboard, or `undefined` when `@nestrix/ui` is not installed. */
  resolveDirectory(): string | undefined {
    try {
      const require = createRequire(import.meta.url);
      return dirname(require.resolve(UI_PACKAGE));
    } catch {
      return undefined;
    }
  },
};

interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

function readManifest(directory: string): ManifestEntry[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new Error("manifest.json has no files list");
  const out: ManifestEntry[] = [];
  for (const f of files) {
    const e = f as Partial<ManifestEntry> | null;
    if (
      !e ||
      typeof e.path !== "string" ||
      typeof e.size !== "number" ||
      typeof e.sha256 !== "string" ||
      typeof e.contentType !== "string"
    ) {
      throw new Error("manifest.json has a malformed entry");
    }
    out.push(e as ManifestEntry);
  }
  return out;
}

function readChecked(directory: string, entry: ManifestEntry): Buffer {
  const body = readFileSync(join(directory, ...entry.path.split("/")));
  if (body.length !== entry.size) {
    throw new Error(`${entry.path} does not match manifest.json (size)`);
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`${entry.path} does not match manifest.json (sha256)`);
  }
  return body;
}

function countOf(text: string, token: string): number {
  return text.split(token).length - 1;
}

/**
 * Reads the manifest and every served file into memory. Throws (with a message naming the file,
 * never its contents) when the build is incomplete or does not match its manifest; the caller
 * turns that into "dashboard off" with an error line.
 */
export function loadUi(directory: string): UiBundle {
  let indexTemplate: string | undefined;
  const assets = new Map<string, UiAsset>();
  for (const entry of readManifest(directory)) {
    const isIndex = entry.path === "index.html";
    if (!isIndex && !ASSET_PATH.test(entry.path)) continue;
    if (!CONTENT_TYPE.test(entry.contentType)) {
      throw new Error(
        `${entry.path} has an invalid content type in manifest.json`,
      );
    }
    const body = readChecked(directory, entry);
    if (isIndex) indexTemplate = body.toString("utf8");
    else assets.set(entry.path, { body, contentType: entry.contentType });
  }
  if (indexTemplate === undefined) {
    throw new Error("index.html is missing from manifest.json");
  }
  if (
    countOf(indexTemplate, BASE_HREF_PLACEHOLDER) !== 1 ||
    countOf(indexTemplate, CONFIG_PLACEHOLDER) !== 1
  ) {
    throw new Error("index.html does not have its two placeholders");
  }
  return { indexTemplate, assets };
}

/** What the UI reads from the `nestrix-config` block. */
export interface DashboardConfig {
  /** Absolute path of the query API, no trailing slash: `<path>/api/v1`. */
  readonly apiBase: string;
  /** The dashboard path, no trailing slash. */
  readonly path: string;
  readonly protocolVersion: number;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * `index.html` for the dashboard at `path`: `<base href="<path>/">` (HTML-escaped) and the config
 * JSON with every `<` written as `<`, so the block cannot close its `<script>` element. The
 * block is `type="application/json"`: data, never executed (CSP `script-src 'self'`).
 * Replacement functions, so a `$` in either value is taken literally.
 */
export function renderIndex(template: string, config: DashboardConfig): string {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return template
    .replace(BASE_HREF_PLACEHOLDER, () => escapeHtml(`${config.path}/`))
    .replace(CONFIG_PLACEHOLDER, () => json);
}
