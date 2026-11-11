/**
 * The `@nestrix/ui` build, served by the standalone server at `/` (backlog P5-04). Mirrors the
 * embedded dashboard's loader (`packages/nestjs/src/dashboard/assets.ts`, internal to that
 * package): the package directory is found with `createRequire().resolve()`, `manifest.json`
 * lists every file, and only `index.html` and single-segment files under `assets/` are read,
 * each checked against the manifest's size and SHA-256 and kept in memory. Nothing is ever read
 * from disk per request, so no request path can reach the file system.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const UI_PACKAGE = "@nestrix/ui";
export const BASE_HREF_PLACEHOLDER = "__NESTRIX_BASE_HREF__";
export const CONFIG_PLACEHOLDER = '"__NESTRIX_CONFIG__"';
/** The query-API protocol version the server speaks (`@nestrix/protocol`'s `PROTOCOL_VERSION`; a test keeps them equal). */
export const PROTOCOL_VERSION = 1;

export interface UiAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface UiBundle {
  /** `index.html`, placeholders filled in for the server. */
  readonly index: Buffer;
  /** `assets/<file>` → file. */
  readonly assets: ReadonlyMap<string, UiAsset>;
}

const ASSET_PATH = /^assets\/[A-Za-z0-9._-]+$/;
const CONTENT_TYPE = /^[\x20-\x7e]{1,200}$/;

interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** The directory of the built UI, or `undefined` when `@nestrix/ui` cannot be resolved. */
export function resolveUiDirectory(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(UI_PACKAGE));
  } catch {
    return undefined;
  }
}

function readManifest(directory: string): ManifestEntry[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new Error("manifest.json has no files list");
  return files.map((f) => {
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
    return e as ManifestEntry;
  });
}

function readChecked(directory: string, entry: ManifestEntry): Buffer {
  const body = readFileSync(join(directory, ...entry.path.split("/")));
  if (body.length !== entry.size) {
    throw new Error(`${entry.path} does not match manifest.json (size)`);
  }
  if (createHash("sha256").update(body).digest("hex") !== entry.sha256) {
    throw new Error(`${entry.path} does not match manifest.json (sha256)`);
  }
  return body;
}

function countOf(text: string, token: string): number {
  return text.split(token).length - 1;
}

/**
 * `index.html` for the server: `<base href="/">` and the config block
 * `{"apiBase":"/api/v1","path":"","protocolVersion":1}` (every `<` escaped, so the block cannot
 * close its `<script type="application/json">`). Replacement functions take `$` literally.
 */
export function renderIndex(template: string): string {
  const json = JSON.stringify({
    apiBase: "/api/v1",
    path: "",
    protocolVersion: PROTOCOL_VERSION,
  }).replace(/</g, "\\u003c");
  return template
    .replace(BASE_HREF_PLACEHOLDER, () => "/")
    .replace(CONFIG_PLACEHOLDER, () => json);
}

/**
 * Reads and checks the build. Throws (naming the file, never its contents) when it is incomplete
 * or does not match its manifest.
 */
export function loadUi(directory: string): UiBundle {
  let template: string | undefined;
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
    if (isIndex) template = body.toString("utf8");
    else assets.set(entry.path, { body, contentType: entry.contentType });
  }
  if (template === undefined) {
    throw new Error("index.html is missing from manifest.json");
  }
  if (
    countOf(template, BASE_HREF_PLACEHOLDER) !== 1 ||
    countOf(template, CONFIG_PLACEHOLDER) !== 1
  ) {
    throw new Error("index.html does not have its two placeholders");
  }
  return { index: Buffer.from(renderIndex(template), "utf8"), assets };
}
