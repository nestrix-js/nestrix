import { hashKey, type QueryKey } from "@tanstack/react-query";

/**
 * The query cache hash, with the selected environment in it (audit: a switch must never show
 * the previous environment's answer). `getJson` adds `environment` to the request at transport
 * time, so the keys the views write do not hold it; hashing it in here puts every query that
 * reads an environment-aware endpoint in its own cache entry per environment. `meta` lists the
 * environments themselves and does not depend on the selection.
 */
export function environmentQueryHash(
  key: QueryKey,
  environment: string | undefined,
): string {
  return key[0] === "meta"
    ? hashKey(key)
    : hashKey([{ environment: environment ?? null }, ...key]);
}
