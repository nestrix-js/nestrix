import { useQueryState } from "nuqs";

import { serviceParser } from "@/lib/params";

/** The selected service from the URL (`?service=`), or undefined for all services. */
export function useService() {
  const [service, setService] = useQueryState("service", serviceParser);
  return [
    service ?? undefined,
    (next: string | undefined) => setService(next ?? null),
  ] as const;
}
