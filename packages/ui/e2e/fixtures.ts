import { fileURLToPath } from "node:url";

import type { ErrorListResponse, RouteStatsResponse } from "@nestrix/protocol";

/**
 * The protocol fixtures, loaded by path: they sit outside this package's TypeScript root and
 * are test data only (the production bundle must hold none, see dashboard.pw.ts).
 */
export async function loadFixtures() {
  return (await import(
    fileURLToPath(new URL("../../protocol/fixtures/index.ts", import.meta.url))
  )) as { errorList: ErrorListResponse; routes: RouteStatsResponse };
}
