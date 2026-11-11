import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { BadRequestException } from "@nestjs/common";

/**
 * Express and platform-node hand the handler a `node:http` request; Fastify wraps
 * it and keeps the original on `.raw`.
 */
export type UploadRequest = IncomingMessage & { raw?: IncomingMessage };

/**
 * Reads the first file of a multipart body with the platform's own parser
 * (`Response#formData`), so this works on any adapter without multer or
 * `@fastify/multipart`. Needs the adapter to leave the multipart body unread; Nest's
 * JSON and urlencoded parsers ignore it. Fastify needs a content-type parser for
 * `multipart/form-data` registered in `main.ts`.
 */
export async function readUpload(
  req: UploadRequest,
): Promise<{ name: string; size: number }> {
  const raw = req.raw ?? req;
  const contentType = raw.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    throw new BadRequestException("expected multipart/form-data");
  }
  const form = await new Response(
    Readable.toWeb(raw) as ReadableStream<Uint8Array>,
    { headers: { "content-type": contentType } },
  ).formData();
  for (const value of form.values()) {
    if (typeof value !== "string") {
      return { name: value.name, size: value.size };
    }
  }
  throw new BadRequestException("no file in the form");
}
