import { defineConfig } from "vitest/config";

// The probes measure sampling intervals and depend on when V8 optimises functions; test files
// running in parallel compete for CPU and change both. One file at a time.
export default defineConfig({
  test: { fileParallelism: false },
});
