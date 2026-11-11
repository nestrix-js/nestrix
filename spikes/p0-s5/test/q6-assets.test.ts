import "reflect-metadata";
import { gunzipSync } from "node:zlib";
import { type AdapterName, bootApp } from "@nestrix-js/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  blobGz,
  blobRaw,
  DASHBOARD_CSP,
  IMMUTABLE,
  indexHtml,
  probe,
  resetProbe,
  type WriteStrategy,
} from "../src/dashboard.js";
import { hostModule } from "../src/host.js";
import { get, getJson, note } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => resetProbe());

async function observe(adapter: AdapterName, strategy: WriteStrategy) {
  const booted = await bootApp(adapter, {
    module: hostModule({ mount: { when: "init", strategy } }),
  });
  try {
    const blob = await get(`${booted.baseUrl}/_nestrix/assets/blob.bin`, {
      "accept-encoding": "gzip",
    });
    const html = await get(`${booted.baseUrl}/_nestrix/index.html`);
    const json = await getJson(`${booted.baseUrl}/_nestrix/api/whoami`);
    return { blob, html, json, errors: [...probe.handlerErrors] };
  } finally {
    await booted.close();
  }
}

describe.each(adapters)("Q6 asset and JSON responses (%s)", (adapter) => {
  it("raw ServerResponse writes are byte-exact with the headers set", async () => {
    const { blob, html, json, errors } = await observe(adapter, "raw");
    expect(errors).toEqual([]);
    expect(blob.status).toBe(200);
    expect(blob.headers["content-type"]).toBe("application/octet-stream");
    expect(blob.headers["content-encoding"]).toBe("gzip");
    expect(blob.headers["cache-control"]).toBe(IMMUTABLE);
    expect(blob.headers["content-length"]).toBe(String(blobGz.length));
    expect(blob.body.equals(blobGz)).toBe(true);
    expect(gunzipSync(blob.body).equals(blobRaw)).toBe(true);
    expect(html.body.equals(indexHtml)).toBe(true);
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html.headers["content-security-policy"]).toBe(DASHBOARD_CSP);
    expect(html.headers["x-robots-tag"]).toBe("noindex");
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toMatch(/^application\/json/);
    expect(json.json).toMatchObject({ ok: true });
  });

  it("httpAdapter.status/setHeader/reply: what comes out", async () => {
    const { blob, html, json, errors } = await observe(adapter, "adapter");
    const result = {
      blobStatus: blob.status,
      blobType: blob.headers["content-type"],
      blobEncoding: blob.headers["content-encoding"],
      blobCache: blob.headers["cache-control"],
      blobLength: blob.headers["content-length"],
      blobEtag: blob.headers.etag ?? null,
      blobByteExact: blob.body.equals(blobGz),
      blobBodyStart: blob.body.subarray(0, 40).toString("latin1"),
      htmlByteExact: html.body.equals(indexHtml),
      htmlType: html.headers["content-type"],
      jsonType: json.headers["content-type"],
      jsonOk: (json.json as { ok?: boolean }).ok === true,
      errors,
    };
    note(`Q6 ${adapter} adapter-strategy`, result);
    expect(errors).toEqual([]);
    expect(result.jsonOk).toBe(true);
    expect(result.blobStatus).toBe(200);
    expect(result.blobCache).toBe(IMMUTABLE);
    if (adapter === "express") {
      // ExpressAdapter.reply(): `isObject(body) ? res.json(body) : res.send(String(body))`.
      // A Buffer is an object, so it is sent as JSON: {"type":"Buffer","data":[...]}.
      expect(result.blobByteExact).toBe(false);
      expect(result.htmlByteExact).toBe(false);
      expect(result.blobBodyStart.startsWith('{"type":"Buffer","data":[')).toBe(
        true,
      );
      // ...under the Content-Type and Content-Encoding the handler set: a client
      // would try to gunzip JSON text.
      expect(result.blobEncoding).toBe("gzip");
    } else {
      expect(result.blobByteExact).toBe(true);
      expect(result.htmlByteExact).toBe(true);
      expect(result.blobType).toBe("application/octet-stream");
      expect(result.blobEncoding).toBe("gzip");
      expect(result.blobLength).toBe(String(blobGz.length));
    }
  });

  it("httpAdapter.status/setHeader then httpAdapter.end(res, buffer): what comes out", async () => {
    const { blob, html, errors } = await observe(adapter, "adapter-end");
    const result = {
      blobStatus: blob.status,
      blobType: blob.headers["content-type"] ?? null,
      blobEncoding: blob.headers["content-encoding"] ?? null,
      blobCache: blob.headers["cache-control"] ?? null,
      blobByteExact: blob.body.equals(blobGz),
      htmlByteExact: html.body.equals(indexHtml),
      htmlCsp: html.headers["content-security-policy"] ?? null,
      errors,
    };
    note(`Q6 ${adapter} adapter-end-strategy`, result);
    expect(errors).toEqual([]);
    expect(result.blobByteExact).toBe(true);
    if (adapter === "fastify") {
      // FastifyAdapter.end() writes reply.raw; setHeader() wrote the reply's own
      // header map, which is never flushed: every header the handler set is lost.
      expect(result.blobEncoding).toBeNull();
      expect(result.blobCache).toBeNull();
      expect(result.htmlCsp).toBeNull();
    } else {
      expect(result.blobEncoding).toBe("gzip");
      expect(result.blobCache).toBe(IMMUTABLE);
      expect(result.htmlCsp).toBe(DASHBOARD_CSP);
    }
  });
});
