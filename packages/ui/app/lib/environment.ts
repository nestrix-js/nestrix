import { useQueryState } from "nuqs";

import { serviceParser } from "@/lib/params";

/**
 * The selected environment from the URL (`?environment=`), or undefined for every environment
 * (issue #28, D-101). `unset` selects the data without an environment.
 */
export function useEnvironment() {
  const [environment, setEnvironment] = useQueryState(
    "environment",
    serviceParser,
  );
  return [
    environment ?? undefined,
    (next: string | undefined) => setEnvironment(next ?? null),
  ] as const;
}
