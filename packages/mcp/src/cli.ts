#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, isLoopbackUrl, loadConfig } from "./config.js";
import { createMcpServer } from "./tools.js";

/** Reads the environment, serves MCP over stdio. stdout carries the protocol, so messages go to stderr. */
async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`nestrix-mcp: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  if (config.url.startsWith("http://") && !isLoopbackUrl(config.url)) {
    process.stderr.write(
      "nestrix-mcp: warning: NESTRIX_URL is plain http to a non-local host, so NESTRIX_TOKEN travels unencrypted.\n",
    );
  }
  await createMcpServer(config).connect(new StdioServerTransport());
}

// Only when run as the program, not when a file is loaded with require() or import (the
// no-top-level-await check loads every built file).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `nestrix-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
