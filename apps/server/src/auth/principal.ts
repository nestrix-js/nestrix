/**
 * Who a request is (issue #34, D-104), stamped by `AdminAuth.middleware()` next to the auth stamp
 * under a private symbol, so neither a client nor other code can forge it by name.
 */
import type { AccessRole, MetaAccess } from "@nestrix-js/protocol";
import type { AuditActor } from "./audit.js";

export type Principal =
  /** The break-glass admin password (`NESTRIX_ADMIN_PASSWORD`). */
  | { readonly kind: "password"; readonly role: "admin" }
  /** A user signed in with OIDC; the role was read from `dashboard_users` for this request. */
  | {
      readonly kind: "oidc";
      readonly role: AccessRole;
      readonly userId: number;
      readonly label: string;
    }
  /** An API token (P8-01): reads only. */
  | { readonly kind: "token"; readonly role: "viewer" };

export const AUTH_PRINCIPAL = Symbol("nestrix-server:auth-principal");

export const PASSWORD_PRINCIPAL: Principal = Object.freeze({
  kind: "password",
  role: "admin",
});
export const TOKEN_PRINCIPAL: Principal = Object.freeze({
  kind: "token",
  role: "viewer",
});

export function principalOf(req: unknown): Principal | undefined {
  if (req === null || typeof req !== "object") return undefined;
  const value = (req as Record<symbol, unknown>)[AUTH_PRINCIPAL];
  return value !== null && typeof value === "object"
    ? (value as Principal)
    : undefined;
}

export function stampPrincipal(req: object, principal: Principal): void {
  (req as Record<symbol, Principal>)[AUTH_PRINCIPAL] = principal;
}

/** `MetaResponse.access` for a request, or `undefined` when it has no principal. */
export function accessOf(req: unknown): MetaAccess | undefined {
  const p = principalOf(req);
  if (p === undefined) return undefined;
  if (p.kind === "oidc") return { role: p.role, kind: "oidc", label: p.label };
  return { role: p.role, kind: p.kind };
}

/** The audit log's actor for a principal (an API token never reaches an audited route). */
export function actorOf(p: Principal | undefined): AuditActor {
  if (p?.kind === "password") return { kind: "password" };
  if (p?.kind === "oidc")
    return { kind: "oidc", userId: p.userId, label: p.label };
  return { kind: "anonymous" };
}
