import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

// Packages whose code reaches dist/ through CSS or font files, which the JS module
// graph does not list.
const assetPackages = [
  "tailwindcss",
  "tw-animate-css",
  "uplot",
  "@fontsource-variable/geist-mono",
];

const SHADCN_NOTICE = `shadcn/ui (copied components under app/components/ui)
MIT License. Copyright (c) 2023 shadcn. https://github.com/shadcn-ui/ui/blob/main/LICENSE.md`;

// Components under app/components/data-table and app/components/relative-time-card.tsx
// follow the structure of these two projects (both MIT). The year is not stated here; the
// licence files are linked.
const SADMANN7_NOTICE = `tablecn (slim data table: app/components/data-table) and Dice UI (relative-time-card, faceted filter)
MIT License. Copyright (c) sadmann7.
https://github.com/sadmann7/tablecn/blob/main/LICENSE
https://github.com/sadmann7/diceui/blob/main/LICENSE.md`;

function packageRoot(file: string): string | undefined {
  const marker = "/node_modules/";
  const at = file.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = file.slice(at + marker.length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return name ? file.slice(0, at + marker.length) + name : undefined;
}

/** Writes THIRD_PARTY_NOTICES.txt: licence text of every package that ended up in dist/. */
function thirdPartyNotices(): Plugin {
  return {
    name: "nestrix-third-party-notices",
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        for (const id of Object.keys(item.modules)) {
          const dir = packageRoot(id.split("?")[0] ?? id);
          if (dir) dirs.add(dir);
        }
      }
      for (const name of assetPackages)
        dirs.add(join(root, "node_modules", name));

      const entries = new Map<string, string>();
      for (const dir of dirs) {
        const pkgFile = join(dir, "package.json");
        if (!existsSync(pkgFile)) continue;
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
          name: string;
          version: string;
          license?: string;
        };
        const licenseFile = readdirSync(dir).find((f) =>
          /^licen[cs]e(\.|$)/i.test(f),
        );
        const text = licenseFile
          ? readFileSync(join(dir, licenseFile), "utf8").trim()
          : "(no licence file in the package)";
        entries.set(
          `${pkg.name}@${pkg.version}`,
          `${pkg.name}@${pkg.version} (${pkg.license ?? "see below"})\n\n${text}`,
        );
      }
      const body = [...entries.keys()]
        .sort()
        .map((key) => entries.get(key))
        .concat(SHADCN_NOTICE, SADMANN7_NOTICE)
        .join("\n\n----------------------------------------\n\n");
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: `Third-party code bundled into the Nestrix dashboard.\n\n${body}\n`,
      });
    },
  };
}

interface Fixtures {
  meta: unknown;
  traceList: { items: Array<Record<string, unknown>> } & Record<
    string,
    unknown
  >;
  errorList: { items: Array<Record<string, unknown>> } & Record<
    string,
    unknown
  >;
  routes: unknown;
  trace: { traceId: string };
}

/**
 * `vite dev` only: fills the index.html placeholders the way the host does and serves the
 * protocol fixtures at the API paths, so the UI runs without a server. Filters are applied
 * to the fixtures; cursors are not (`after` answers an empty page, `before` the end of the
 * list). Never part of the build: the fixtures are loaded here, in Node, and no UI module
 * imports them.
 */
function devApi(): Plugin {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
  return {
    name: "nestrix-dev-api",
    apply: "serve",
    transformIndexHtml(html) {
      const config = JSON.stringify({
        service: "fixtures",
        apiBase: "api/v1/",
        path: "/",
        protocolVersion: 1,
      });
      return html
        .replace("__NESTRIX_BASE_HREF__", "/")
        .replace('"__NESTRIX_CONFIG__"', () => config);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = /^\/api\/v1\/(meta|traces|errors|routes|trace)$/.exec(
          url.pathname,
        );
        if (!match) return next();
        try {
          const fx = (await server.ssrLoadModule(
            join(root, "../protocol/fixtures/index.ts"),
          )) as unknown as Fixtures;
          const q = url.searchParams;
          const page = <T extends { items: Array<Record<string, unknown>> }>(
            list: T,
            keep: (item: Record<string, unknown>) => boolean,
          ) => {
            const items = list.items.filter(keep);
            if (q.has("after"))
              return { ...list, items: [], older: null, reset: false };
            if (q.has("before"))
              return { ...list, items: [], older: null, reset: false };
            return { ...list, items };
          };
          switch (match[1]) {
            case "meta":
              return json(res, 200, fx.meta);
            case "routes":
              return json(res, 200, fx.routes);
            case "trace":
              return q.get("id") === fx.trace.traceId
                ? json(res, 200, fx.trace)
                : json(res, 404, {
                    error: { code: "not_found", message: "Trace not found" },
                  });
            case "errors":
              return json(
                res,
                200,
                page(
                  fx.errorList,
                  (i) => !q.get("route") || i.route === q.get("route"),
                ),
              );
            default: {
              const status = q.get("status");
              const min = Number(q.get("minDurationMs") ?? 0);
              const search = (q.get("search") ?? "").toLowerCase();
              return json(
                res,
                200,
                page(fx.traceList, (i) => {
                  const code = Number(i.statusCode ?? 0);
                  return (
                    (!q.get("route") || i.route === q.get("route")) &&
                    (!q.get("method") || i.method === q.get("method")) &&
                    (!status ||
                      (status === "error" && i.error === true) ||
                      (status === "ok" && i.error !== true) ||
                      (status === "4xx" && code >= 400 && code < 500) ||
                      (status === "5xx" && code >= 500)) &&
                    Number(i.durationMs) >= min &&
                    (!search ||
                      String(i.name).toLowerCase().includes(search) ||
                      String(i.route ?? "")
                        .toLowerCase()
                        .includes(search))
                  );
                }),
              );
            }
          }
        } catch (error) {
          json(res, 500, {
            error: { code: "internal", message: String(error) },
          });
        }
      });
    },
  };
}

export default defineConfig({
  root: join(root, "app"),
  base: "./",
  plugins: [react(), tailwindcss(), thirdPartyNotices(), devApi()],
  resolve: { alias: { "@": join(root, "app") } },
  build: {
    outDir: join(root, "dist"),
    // dist/ also holds the Node entry written by tsc; scripts/build-assets.mjs
    // removes stale dist/assets and dist/index.html before this runs.
    emptyOutDir: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
