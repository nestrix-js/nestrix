// Fails when an option name declared in packages/nestjs/src/options.ts is missing from the
// configuration reference page. Run by `pnpm docs:build`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const optionsPath = fileURLToPath(
  new URL("../../packages/nestjs/src/options.ts", import.meta.url),
);
const pagePath = fileURLToPath(
  new URL("../reference/configuration.md", import.meta.url),
);

const source = readFileSync(optionsPath, "utf8");
const page = readFileSync(pagePath, "utf8");

// Property declarations at interface-member indentation: `  name?: type;`, `  readonly name: type;`.
const names = new Set();
for (const match of source.matchAll(
  /^ {2}(?:readonly )?([A-Za-z_]\w*)\??:/gm,
)) {
  names.add(match[1]);
}

// A name counts as documented when it appears inside an inline-code span, alone or in a path
// such as `export.otlp.endpoint`.
const codeSpans = [...page.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const documented = (name) =>
  codeSpans.some((span) =>
    new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(span),
  );

if (names.size === 0) {
  console.error(
    "check-options: found no option names in options.ts (parser out of date?).",
  );
  process.exit(1);
}
const missing = [...names].filter((name) => !documented(name)).sort();
if (missing.length > 0) {
  console.error(
    `check-options: ${missing.length} option(s) in options.ts are missing from reference/configuration.md:\n  ${missing.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`check-options: all ${names.size} option names are documented.`);
