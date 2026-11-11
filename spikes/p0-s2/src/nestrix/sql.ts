// Minimal literal stripping for the spike. Not the production sanitiser.
export function sanitizeSql(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  return text
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .slice(0, 2048);
}

export function sqlOperation(text: unknown): string {
  if (typeof text !== "string") return "query";
  const m = /^\s*([A-Za-z]+)/.exec(text);
  return m?.[1] ? m[1].toUpperCase() : "query";
}
