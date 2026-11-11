// Fails when the packed package's unpacked size exceeds the budget (D-52).
// Usage: node scripts/check-size.mjs [--budget <bytes>]   (the flag is for trying the check;
// the committed budget below is what CI enforces).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// D-52: 1 MB unpacked, measured by `npm pack --dry-run --json` (decimal megabyte).
// Raise only by recording a new budget in docs/decisions.md D-52 (measured size + 20%, at most 2 MB).
const BUDGET_BYTES = 1_000_000;

const flag = process.argv.indexOf("--budget");
const budget = flag > -1 ? Number(process.argv[flag + 1]) : BUDGET_BYTES;
if (!Number.isFinite(budget) || budget <= 0) {
  console.error("check-size: --budget needs a positive number of bytes");
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const out = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  },
);
const [pack] = JSON.parse(out);
const { unpackedSize, files } = pack;
const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 3);

console.log(
  `@nestrix/ui unpacked size ${unpackedSize} bytes, budget ${budget} bytes (${files.length} files; largest: ${largest.map((f) => `${f.path} ${f.size}`).join(", ")})`,
);
if (unpackedSize > budget) {
  console.error(
    `check-size: over budget by ${unpackedSize - budget} bytes. See D-52 in docs/decisions.md.`,
  );
  process.exit(1);
}
