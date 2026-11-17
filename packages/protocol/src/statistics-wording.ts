/**
 * The sentences that say what route statistics count, shared by the dashboard (`@nestrix-js/ui`)
 * and the MCP server (`@nestrix-js/mcp`) so they cannot disagree (issue #45).
 *
 * The wording depends on `MetaResponse.mode`:
 * - embedded: the app's own counters see every request, before sampling;
 * - standalone: statistics are counted from the stored spans (D-61), so they reflect the sampling
 *   of the services that send them.
 *
 * Change the wording here and nowhere else. `@nestrix-js/mcp` is published without this private
 * package, so its build copies this file to `packages/mcp/src/render/statistics-wording.ts`
 * (`scripts/sync-statistics-wording.mjs`; a test fails when the copy is stale). This file must
 * stay free of imports for that reason.
 */

export type StatisticsMode = "embedded" | "standalone";

/** How the standalone server's statistics are counted: the one line to edit when that changes. */
const STANDALONE_COUNTED =
  "counted from the stored spans, so they reflect the sampling of the services that send them";

/** What route statistics count in each mode. */
export const STATISTICS_COUNTING = {
  embedded: "Route statistics count every request.",
  standalone: `Route statistics are ${STANDALONE_COUNTED}.`,
} as const;

/** The standalone sentence on pages that are not about routes (classes, dependencies, map). */
export const STANDALONE_STATISTICS_NOTE = `Statistics are ${STANDALONE_COUNTED}.`;

/**
 * The sentence for a given mode. With no mode (a static tool description, or a server that did not
 * answer `meta`), it states both cases.
 */
export function statisticsCounting(mode?: StatisticsMode): string {
  if (mode === "embedded") return STATISTICS_COUNTING.embedded;
  if (mode === "standalone") return STATISTICS_COUNTING.standalone;
  return `Route statistics count every request on an app's embedded dashboard; on the standalone server they are ${STANDALONE_COUNTED}.`;
}

/** The sentence under the routes heading; null when every request is stored. */
export function statisticsNote(
  sampling: { owner?: "nestrix" | "host"; rate: number | null },
  mode?: StatisticsMode,
): string | null {
  if (mode === "standalone") return STATISTICS_COUNTING.standalone;
  if (sampling.rate === null)
    return `${STATISTICS_COUNTING.embedded} The host application owns the sampler, so the request and error lists may hold fewer.`;
  if (sampling.rate < 1)
    return `${STATISTICS_COUNTING.embedded} The request and error lists are sampled (${Math.round(
      sampling.rate * 100,
    )}% of requests are stored), so they hold fewer than these counts.`;
  return null;
}
