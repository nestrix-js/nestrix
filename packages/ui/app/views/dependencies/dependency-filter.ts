/** The dependencies called `name` (exactly as the page lists them); all of them for none. */
export function filterByName<T extends { name: string }>(
  rows: readonly T[],
  name: string | null,
): T[] {
  return name === null ? [...rows] : rows.filter((r) => r.name === name);
}
