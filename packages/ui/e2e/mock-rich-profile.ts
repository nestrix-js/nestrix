import type { FlameNode, ProfileFunction } from "@nestrix-js/protocol";

/** A flame node whose total is its own samples plus its children's. */
function n(
  functionName: string,
  url: string,
  line: number,
  selfSamples: number,
  children: FlameNode[] = [],
): FlameNode {
  return {
    functionName,
    url,
    line,
    selfSamples,
    totalSamples:
      selfSamples + children.reduce((sum, c) => sum + c.totalSamples, 0),
    children,
  };
}

const APP = "file:///srv/orders/dist";
const DEPS = "file:///srv/orders/node_modules";

/**
 * A profile with every origin in it (your code, `node_modules`, Node built-ins, V8), for the
 * screenshots: a request handler that spends its time serialising decimals as JSON.
 */
export function richProfile(): {
  flame: FlameNode;
  topFunctions: ProfileFunction[];
  samples: number;
} {
  const flame = n("(root)", "", 0, 0, [
    n(
      "processTicksAndRejections",
      "node:internal/process/task_queues",
      95,
      20,
      [
        n("handle", `${DEPS}/express/lib/router/layer.js`, 152, 40, [
          n("create", `${APP}/orders.controller.js`, 41, 140, [
            n("toResponse", `${APP}/orders.service.js`, 88, 320, [
              n("stringify", "node:internal/json", 12, 260),
              n("serializeDecimal", `${APP}/orders.service.js`, 212, 190, [
                n("toString", `${DEPS}/decimal.js/decimal.mjs`, 1880, 230, [
                  n("round", `${DEPS}/decimal.js/decimal.mjs`, 940, 70),
                ]),
              ]),
            ]),
            n("total", `${APP}/pricing.service.js`, 48, 260, [
              n("query", `${DEPS}/pg/lib/client.js`, 538, 160, [
                n("parseDataRow", `${DEPS}/pg/lib/parser.js`, 77, 60),
              ]),
            ]),
          ]),
          n(
            "reply",
            `${DEPS}/@nestjs/platform-express/adapters/express-adapter.js`,
            61,
            150,
            [n("_write", "node:net", 971, 270)],
          ),
        ]),
      ],
    ),
    n("(program)", "", 0, 250),
    n("(garbage collector)", "", 0, 230),
  ]);
  const merged = new Map<string, ProfileFunction>();
  const walk = (node: FlameNode) => {
    if (node.functionName !== "(root)") {
      const key = `${node.functionName}|${node.url}|${node.line}`;
      const known = merged.get(key);
      if (known) {
        known.selfSamples += node.selfSamples;
      } else {
        merged.set(key, {
          functionName: node.functionName,
          url: node.url,
          line: node.line,
          column: 1,
          selfSamples: node.selfSamples,
          totalSamples: node.totalSamples,
        });
      }
    }
    node.children.forEach(walk);
  };
  walk(flame);
  const topFunctions = [...merged.values()]
    .filter((f) => f.selfSamples > 0)
    .sort((a, b) => b.selfSamples - a.selfSamples);
  return { flame, topFunctions, samples: flame.totalSamples };
}
