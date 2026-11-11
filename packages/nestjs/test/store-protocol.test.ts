// The store's mirror of the query API types (src/store/protocol-types.ts) must equal
// @nestrix/protocol's. @nestrix/nestjs cannot import that private package yet (it is not
// linked), so this compares against its built declarations by relative path. Drift
// fails `pnpm typecheck` (the test tsconfig covers this file); at run time there is
// nothing to check.
import { describe, expect, it } from "vitest";
import type * as Protocol from "../../protocol/dist/index.js";
import type * as Mirror from "../src/store/protocol-types.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const same: [
  Equals<Mirror.AttributeValue, Protocol.AttributeValue>,
  Equals<Mirror.Attributes, Protocol.Attributes>,
  Equals<Mirror.SpanKind, Protocol.SpanKind>,
  Equals<Mirror.StatusCode, Protocol.StatusCode>,
  Equals<Mirror.SpanEvent, Protocol.SpanEvent>,
  Equals<Mirror.SpanLink, Protocol.SpanLink>,
  Equals<Mirror.SpanRecord, Protocol.SpanRecord>,
  Equals<Mirror.PagedResponse, Protocol.PagedResponse>,
  Equals<Mirror.TraceSummary, Protocol.TraceSummary>,
  Equals<Mirror.TraceListResponse, Protocol.TraceListResponse>,
  Equals<Mirror.TraceResponse, Protocol.TraceResponse>,
  Equals<Mirror.ErrorItem, Protocol.ErrorItem>,
  Equals<Mirror.ErrorListResponse, Protocol.ErrorListResponse>,
  Equals<Mirror.MapNodeKind, Protocol.MapNodeKind>,
  Equals<Mirror.MapNode, Protocol.MapNode>,
  Equals<Mirror.MapEdge, Protocol.MapEdge>,
  Equals<Mirror.AppMapResponse, Protocol.AppMapResponse>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

describe("store types mirror @nestrix/protocol", () => {
  it("are equal (checked by tsc)", () => {
    expect(same.every(Boolean)).toBe(true);
  });
});
