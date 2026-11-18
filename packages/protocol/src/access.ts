/**
 * Who is signed in, and the audit log (standalone server only; issue #34, D-104).
 */

/** What a signed-in request may do: `admin` changes things, `viewer` only reads. */
export type AccessRole = "admin" | "viewer";

/**
 * `MetaResponse.access`: who the request is, as the standalone server sees it. Absent from the
 * embedded dashboard and from servers before D-104: the UI then shows every action (the server
 * still decides).
 */
export interface MetaAccess {
  role: AccessRole;
  /**
   * `password`: the break-glass admin password; `oidc`: a user who signed in with single sign-on;
   * `token`: an API token (always `viewer`).
   */
  kind: "password" | "oidc" | "token";
  /** For `oidc`: the user's email, name or subject, as the identity provider gave it. */
  label?: string;
}

export type AuditAction =
  | "sign_in"
  | "sign_in_failed"
  | "sign_out"
  | "alert.create"
  | "alert.update"
  | "alert.delete"
  | "alert.test"
  | "slo.create"
  | "slo.update"
  | "slo.delete"
  | "token.create"
  | "token.revoke"
  | "remote_profile.start";

export interface AuditEntry {
  id: string;
  atUnixMs: number;
  actor: {
    /** `password`: the break-glass admin; `oidc`: a user; `anonymous`: a failed sign-in. */
    kind: "password" | "oidc" | "anonymous";
    /** "break-glass admin", the user's email, name or subject, or the subject of a refused sign-in. */
    label: string;
    userId?: string;
  };
  action: AuditAction;
  /** The changed object's id (alert rule, SLO, token, capture), when there is one. */
  target?: string;
  outcome: "ok" | "failed";
  /** For a failed sign-in: the reason code (`id_token_signature`, `not_allowed`, ...). */
  detail?: string;
  /** The client address (the socket peer, or the `X-Forwarded-For` client behind a trusted proxy). */
  clientAddress?: string;
}

/** `GET /api/v1/audit?limit=<1..200, default 100>&before=<id>`: newest first; admin only. */
export interface AuditListResponse {
  entries: AuditEntry[];
}
