/**
 * Ingest authentication: `Authorization: Bearer <key>` or `x-nestrix-key: <key>`, compared in
 * constant time against every configured key (docs/backlog/phase-5.md, "Ingest auth").
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { IngestConfig } from "../config.js";

export type AuthResult =
  /**
   * `principal` names the rate-limit bucket: `key:<n>` for a key, `ip:<address>` with auth off.
   * `owner` is the stable ownership identity of the key (a fingerprint of its digest), which survives a
   * reorder or rotation of the key list; `undefined` with auth off.
   */
  | { ok: true; principal: string; owner?: string }
  | { ok: false; message: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** First 16 hex characters of the key's SHA-256 digest: a stable name that does not reveal it. */
function fingerprint(keyDigest: Buffer): string {
  return keyDigest.subarray(0, 8).toString("hex");
}

/** The presented key, or `undefined` when the request carries none. */
export function presentedKey(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^\s*bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match) return match[1];
  }
  const key = headers["x-nestrix-key"];
  if (typeof key === "string" && key.trim() !== "") return key.trim();
  return undefined;
}

export class IngestAuth {
  /** SHA-256 of each key: equal lengths for `timingSafeEqual`, whatever the presented length. */
  private readonly digests: readonly Buffer[];

  constructor(private readonly config: IngestConfig) {
    this.digests = config.keys.map(digest);
  }

  check(headers: IncomingHttpHeaders, remoteAddress: string): AuthResult {
    if (this.config.auth === "none") {
      return { ok: true, principal: `ip:${remoteAddress}` };
    }
    if (this.config.auth === "unconfigured") {
      return {
        ok: false,
        message:
          "ingest is not configured: set NESTRIX_INGEST_KEYS on the server (or NESTRIX_INGEST_AUTH=none for a local demo)",
      };
    }
    const key = presentedKey(headers);
    if (key === undefined) {
      return {
        ok: false,
        message:
          "missing API key: send Authorization: Bearer <key> or x-nestrix-key: <key>",
      };
    }
    const presented = digest(key);
    let match = -1;
    // Every key is compared, without an early exit, so timing does not reveal which matched.
    for (let i = 0; i < this.digests.length; i++) {
      if (timingSafeEqual(presented, this.digests[i]) && match === -1)
        match = i;
    }
    return match === -1
      ? { ok: false, message: "invalid API key" }
      : {
          ok: true,
          principal: `key:${match}`,
          owner: fingerprint(this.digests[match] as Buffer),
        };
  }
}
