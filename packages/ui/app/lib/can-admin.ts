import type { MetaResponse } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";

import { getMeta } from "@/lib/api";

/**
 * Whether a backend's `meta` lets the user change things (issue #34, D-104): everyone but a
 * `viewer`. `meta.access` is absent from the embedded dashboard and from servers before roles:
 * those users are admins, as before.
 */
export function canAdminOf(meta: Pick<MetaResponse, "access">): boolean {
  return meta.access?.role !== "viewer";
}

/**
 * Whether the signed-in user may change things (create, edit, delete, test, triage). Every write
 * control of the dashboard (the Alerts page, error triage) sits behind this one helper. False
 * until `meta` has loaded, so a viewer never sees a write button flash. The server refuses a
 * write from a viewer regardless: this only hides the controls.
 */
export function useCanAdmin(): boolean {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  return meta.data === undefined ? false : canAdminOf(meta.data);
}
