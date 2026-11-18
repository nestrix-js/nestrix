import { useQuery } from "@tanstack/react-query";
import { getMeta } from "@/lib/api";

import { DebouncedInput } from "@/views/requests/debounced-input";

/**
 * One attribute filter (issue #27, D-102): a key the backend accepts (`meta.attributeFilters`:
 * the server's `NESTRIX_INDEXED_ATTRIBUTES`, or the keys the embedded app sets) and an exact
 * value. Hidden while the backend offers none and the URL holds none.
 */
export function AttributeFilter({
  attrKey,
  attrValue,
  onChange,
}: {
  attrKey: string | null;
  attrValue: string | null;
  onChange: (next: {
    attrKey: string | null;
    attrValue: string | null;
  }) => void;
}) {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const offered = meta.data?.attributeFilters ?? [];
  const keys =
    attrKey !== null && !offered.includes(attrKey)
      ? [...offered, attrKey]
      : offered;
  if (keys.length === 0) return null;
  const key = attrKey ?? keys[0] ?? null;
  return (
    <div className="flex items-center gap-1" data-testid="attribute-filter">
      <select
        aria-label="Attribute"
        className="h-7 max-w-40 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        value={key ?? ""}
        onChange={(e) =>
          onChange({ attrKey: e.target.value || null, attrValue })
        }
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <DebouncedInput
        aria-label="Attribute value"
        placeholder="equals"
        className="h-7 w-32"
        value={attrValue ?? ""}
        onCommit={(v) =>
          onChange(
            v === ""
              ? { attrKey: null, attrValue: null }
              : { attrKey: key, attrValue: v },
          )
        }
      />
    </div>
  );
}
