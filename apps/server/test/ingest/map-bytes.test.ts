// D-116: a bytes attribute is base64-encoded only as far as the 16 KiB cut can keep it, and the
// stored text is the same as when the whole value was encoded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonText, MAX_STRING_LENGTH, text } from "../../src/ingest/map.js";
import type { AnyValue } from "../../src/proto/gen/opentelemetry/proto/common/v1/common_pb.js";

/** The implementation before the fix: the whole value is copied, encoded and quoted, then cut. */
function oldToJson(value: AnyValue | undefined): unknown {
  const v = value?.value;
  switch (v?.case) {
    case "bytesValue":
      return Buffer.from(v.value).toString("base64");
    case "stringValue":
      return text(v.value);
    case "arrayValue":
      return v.value.values.map((i) => oldToJson(i));
    case "kvlistValue": {
      const out: Record<string, unknown> = Object.create(null);
      for (const kv of v.value.values) out[text(kv.key)] = oldToJson(kv.value);
      return out;
    }
    default:
      return null;
  }
}
const oldJsonText = (v: AnyValue) => text(JSON.stringify(oldToJson(v)));

const bytes = (n: number): AnyValue =>
  ({
    value: {
      case: "bytesValue",
      value: Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff),
    },
  }) as AnyValue;

// Smallest input whose base64 (with the opening quote) fills the cut.
const threshold = Math.ceil(((MAX_STRING_LENGTH - 1) * 3) / 4);

afterEach(() => vi.restoreAllMocks());

describe("bytes attribute text", () => {
  for (const n of [
    0,
    1,
    100,
    threshold - 1,
    threshold,
    threshold + 1,
    12288,
    12291,
    12292,
    12294,
    1024 * 1024,
  ]) {
    it(`equals the whole-value encoding for ${n} bytes`, () => {
      const v = bytes(n);
      expect(jsonText(v)).toBe(oldJsonText(v));
    });
  }

  it("equals it for a view into a larger buffer", () => {
    const backing = new Uint8Array(50_000).map((_, i) => (i * 13) & 0xff);
    const v = {
      value: { case: "bytesValue", value: backing.subarray(5, 40_000) },
    } as AnyValue;
    expect(jsonText(v)).toBe(oldJsonText(v));
  });

  it("equals it nested in an array and a map, after other content", () => {
    for (const n of [10, 12_000, 20_000, 1024 * 1024]) {
      const inner = bytes(n);
      const arr = {
        value: {
          case: "arrayValue",
          value: {
            values: [
              { value: { case: "stringValue", value: "x".repeat(50) } },
              inner,
              { value: { case: "stringValue", value: "after" } },
            ],
          },
        },
      } as AnyValue;
      const map = {
        value: {
          case: "kvlistValue",
          value: { values: [{ key: "k", value: arr }] },
        },
      } as AnyValue;
      expect(jsonText(arr)).toBe(oldJsonText(arr));
      expect(jsonText(map)).toBe(oldJsonText(map));
    }
  });

  it("does not encode more than the kept prefix of a large value", () => {
    const encode = vi.spyOn(Buffer.prototype, "toString");
    const out = jsonText(bytes(18 * 1024 * 1024));
    expect(out).toHaveLength(MAX_STRING_LENGTH);
    const base64Inputs = encode.mock.contexts
      .map((c) => (c as Buffer).length)
      .filter((len) => len > 0);
    expect(base64Inputs.length).toBeGreaterThan(0);
    expect(Math.max(...base64Inputs)).toBeLessThan(16 * 1024);
  });
});
