import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  type McpConfig,
  type McpServerOptions,
} from "../src/index.js";

export interface ToolOutput {
  text: string;
  isError: boolean;
}

export interface Connected {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutput>;
  close(): Promise<void>;
}

/** An MCP client wired to the server in the same process, as the SDK documents for tests. */
export async function connect(
  config: McpConfig,
  options?: McpServerOptions,
): Promise<Connected> {
  const server = createMcpServer(config, options);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return {
        text: content.map((c) => c.text ?? "").join("\n"),
        isError: result.isError === true,
      };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface Mock {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

export type Handler = (
  method: string,
  url: URL,
  headers: IncomingHttpHeaders,
) => { status: number; body?: unknown; raw?: string };

/** A throwaway HTTP server standing in for a Nestrix server. */
export async function mockServer(handler: Handler): Promise<Mock> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    });
    const out = handler(req.method ?? "GET", url, req.headers);
    res.statusCode = out.status;
    if (out.raw !== undefined) {
      res.setHeader("content-type", "text/html");
      res.end(out.raw);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
