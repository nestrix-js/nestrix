import { Bookmark, Check, Link as LinkIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type RequestFilters, requestFilterParsers } from "@/lib/params";
import {
  deleteSavedFilter,
  loadSavedFilters,
  MAX_NAME_LENGTH,
  type SavedFilter,
  saveFilter,
} from "@/lib/saved-filters";

type Key = keyof RequestFilters;
const KEYS = Object.keys(requestFilterParsers) as Key[];

// The parsers are typed per key; a string round trip needs the loose view.
type LooseParser = {
  serialize: (value: never) => string;
  parse: (raw: string) => unknown;
};
const parser = (key: Key) =>
  requestFilterParsers[key] as unknown as LooseParser;

/** The set filters as URL parameter strings. */
export function filtersToStrings(
  filters: RequestFilters,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEYS) {
    const value = filters[key];
    if (value !== null) out[key] = parser(key).serialize(value as never);
  }
  return out;
}

/** Every filter key: the saved value when it parses, otherwise null (unset). */
export function stringsToFilters(
  params: Record<string, string>,
): RequestFilters {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const raw = params[key];
    out[key] = raw === undefined ? null : (parser(key).parse(raw) ?? null);
  }
  return out as RequestFilters;
}

/**
 * Saved filters and "Copy link" for the request toolbar. Markup for tests: `saved-filters-trigger`,
 * then in the menu `saved-filter-name` (input), `saved-filter-save`, one `saved-filter-item` per
 * filter with `saved-filter-apply` and `saved-filter-delete`; `copy-filter-link` is outside the menu.
 */
export function SavedFiltersMenu({
  filters,
  onApply,
}: {
  filters: RequestFilters;
  onApply: (filters: RequestFilters) => void;
}) {
  const [saved, setSaved] = useState<SavedFilter[]>(() => loadSavedFilters());
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const current = filtersToStrings(filters);
  const canSave = name.trim() !== "" && Object.keys(current).length > 0;

  const submit = () => {
    if (!canSave) return;
    setSaved(saveFilter(name, current));
    setName("");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 1500);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              data-testid="saved-filters-trigger"
            />
          }
        >
          <Bookmark />
          Saved
          {saved.length > 0 ? ` (${saved.length})` : ""}
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-2 p-2" align="end">
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              aria-label="Name for the current filters"
              data-testid="saved-filter-name"
              placeholder="Name this view"
              maxLength={MAX_NAME_LENGTH}
              className="h-7"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              data-testid="saved-filter-save"
              disabled={!canSave}
              title={
                Object.keys(current).length === 0
                  ? "Set a filter first"
                  : "Save the current filters"
              }
            >
              Save
            </Button>
          </form>
          {saved.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              Nothing saved yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {saved.map((item) => (
                <li
                  key={item.name}
                  data-testid="saved-filter-item"
                  className="flex items-center gap-1"
                >
                  <button
                    type="button"
                    data-testid="saved-filter-apply"
                    className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
                    title={Object.entries(item.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("  ")}
                    onClick={() => {
                      onApply(stringsToFilters(item.params));
                      setOpen(false);
                    }}
                  >
                    {item.name}
                  </button>
                  <button
                    type="button"
                    data-testid="saved-filter-delete"
                    aria-label={`Delete ${item.name}`}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                    onClick={() => setSaved(deleteSavedFilter(item.name))}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="sm"
        data-testid="copy-filter-link"
        onClick={copyLink}
      >
        {copy === "copied" ? <Check /> : <LinkIcon />}
        <span aria-live="polite">
          {copy === "copied"
            ? "Copied"
            : copy === "failed"
              ? "Failed"
              : "Copy link"}
        </span>
      </Button>
    </>
  );
}
