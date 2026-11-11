/**
 * Reads an OTLP request body from the raw Node request, enforcing the size limit on the bytes
 * received and, separately, on the inflated size (a gzip bomb is cut off while inflating).
 * Nothing here throws synchronously; failures reject with `BodyError` or `ClientGoneError`.
 */
import type { IncomingMessage } from "node:http";
import { createGunzip, type Gunzip } from "node:zlib";

export type ContentEncoding = "identity" | "gzip";

/** The body could not be read for a reason the client should be told about. */
export class BodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/** The client aborted or the connection failed; there is nobody to answer. */
export class ClientGoneError extends Error {
  constructor() {
    super("client went away before the body was read");
    this.name = "ClientGoneError";
  }
}

/**
 * Parses `Content-Encoding`. Returns `undefined` for anything other than absent, `identity` or
 * `gzip` (the caller answers 415).
 */
export function parseContentEncoding(
  header: string | string[] | undefined,
): ContentEncoding | undefined {
  if (header === undefined) return "identity";
  if (Array.isArray(header)) return undefined;
  const value = header.trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "gzip" || value === "x-gzip") return "gzip";
  return undefined;
}

export function readBody(
  req: IncomingMessage,
  encoding: ContentEncoding,
  limit: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (req.readableEnded) {
      // Something (a body parser) consumed the stream before us.
      reject(new Error("request body was already consumed"));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let inflated = 0;
    let settled = false;
    const gunzip: Gunzip | undefined =
      encoding === "gzip" ? createGunzip() : undefined;

    const cleanup = () => {
      req.off("data", onRequestData);
      req.off("end", onRequestEnd);
      req.off("error", onRequestError);
      req.off("close", onRequestClose);
      if (gunzip) {
        gunzip.off("data", onBodyData);
        gunzip.off("end", onBodyEnd);
        gunzip.off("drain", onDrain);
        // Errors after settling (e.g. from destroy) must not become unhandled.
        gunzip.on("error", noop);
        gunzip.destroy();
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Stop reading; after answering, the caller discards the rest (`discardRest`).
      req.pause();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(
        chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, inflated),
      );
    };
    const tooLarge = (what: string) =>
      new BodyError(
        413,
        `request body ${what} exceeds the limit of ${limit} bytes`,
      );

    function onBodyData(chunk: Buffer) {
      if (settled) return;
      inflated += chunk.length;
      if (inflated > limit) {
        fail(tooLarge(encoding === "gzip" ? "after decompression" : "size"));
        return;
      }
      chunks.push(chunk);
    }
    function onBodyEnd() {
      succeed();
    }
    function onDrain() {
      if (!settled) req.resume();
    }
    function onRequestData(chunk: Buffer) {
      if (settled) return;
      received += chunk.length;
      if (received > limit) {
        fail(tooLarge("size"));
        return;
      }
      if (gunzip) {
        if (!gunzip.write(chunk)) req.pause();
      } else {
        onBodyData(chunk);
      }
    }
    function onRequestEnd() {
      if (settled) return;
      if (gunzip) gunzip.end();
      else succeed();
    }
    function onRequestError() {
      fail(new ClientGoneError());
    }
    function onRequestClose() {
      if (!req.complete) fail(new ClientGoneError());
    }

    if (gunzip) {
      gunzip.on("data", onBodyData);
      gunzip.on("end", onBodyEnd);
      gunzip.on("drain", onDrain);
      gunzip.once("error", () => {
        fail(new BodyError(400, "request body is not valid gzip"));
      });
    }
    req.on("data", onRequestData);
    req.on("end", onRequestEnd);
    req.on("error", onRequestError);
    req.on("close", onRequestClose);
  });
}

/**
 * After answering early, reads and discards what is left of the body so the client, still
 * sending, gets the response instead of a connection reset. Nothing is buffered. Past `budget`
 * bytes the connection is destroyed instead.
 */
export function discardRest(req: IncomingMessage, budget: number): void {
  try {
    if (req.complete || req.destroyed || req.readableEnded) return;
    let seen = 0;
    const onData = (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > budget) {
        req.off("data", onData);
        req.destroy();
      }
    };
    req.on("data", onData);
    req.once("end", () => req.off("data", onData));
    req.on("error", noop);
    req.resume();
  } catch {
    // Best effort.
  }
}

function noop() {}
