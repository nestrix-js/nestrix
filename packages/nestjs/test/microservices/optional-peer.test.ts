// `@nestjs/microservices` is an optional peer (backlog P4-01): nothing the package entry point loads
// may import it at runtime, so an app without it still loads `@nestrix/nestjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("@nestjs/microservices stays optional", () => {
  it("no source file imports it except as `import type`", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, "utf8");
      const importLike =
        /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']@nestjs\/microservices[^"']*["']/g;
      for (const match of text.matchAll(importLike)) {
        if (match[2] === undefined)
          offenders.push(`${file}: ${match[0].trim()}`);
      }
      if (/(?:require|import)\(\s*["']@nestjs\/microservices/.test(text)) {
        offenders.push(`${file}: dynamic import`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
