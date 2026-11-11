import type { Slo } from "@nestrix/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSlo, deleteSlo, getMeta, getSlos, updateSlo } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";
import {
  budgetBarPercent,
  budgetState,
  describeBudget,
  describeIndicator,
  emptyForm,
  formatBurnRate,
  formatPercent,
  formFromSlo,
  type SloForm,
  toRequest,
} from "@/views/slos/slo-format";

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Create (no `editing`) or edit form; saves with fetch (the page's CSP forbids form posts). */
function SloFormPanel({
  editing,
  services,
  onDone,
}: {
  editing: Slo | undefined;
  services: string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SloForm>(
    editing ? formFromSlo(editing) : emptyForm(services[0] ?? ""),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof SloForm>(key: K, value: SloForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const request = toRequest(form);
      if (!request.ok) throw new Error(request.message);
      return editing
        ? updateSlo(editing.id, request.body)
        : createSlo(request.body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["slos"] });
      onDone();
    },
    onError: (error) => setProblem(error.message),
  });

  return (
    <fieldset
      data-testid="slo-form"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <legend className="px-1 text-sm font-semibold">
        {editing ? `Edit ${editing.name}` : "New SLO"}
      </legend>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id="slo-name" label="Name">
          <Input
            id="slo-name"
            value={form.name}
            maxLength={200}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field id="slo-service" label="Service">
          <Input
            id="slo-service"
            list="slo-services"
            value={form.service}
            maxLength={256}
            onChange={(e) => set("service", e.target.value)}
          />
          <datalist id="slo-services">
            {services.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field
          id="slo-route"
          label="Route (optional, empty for the whole service)"
        >
          <Input
            id="slo-route"
            value={form.route}
            maxLength={512}
            placeholder="/orders/:id"
            onChange={(e) => set("route", e.target.value)}
          />
        </Field>
        <Field id="slo-kind" label="Kind">
          <select
            id="slo-kind"
            className={selectClass}
            value={form.kind}
            onChange={(e) =>
              set(
                "kind",
                e.target.value === "latency" ? "latency" : "availability",
              )
            }
          >
            <option value="availability">Availability (no 5xx)</option>
            <option value="latency">Latency (under a threshold)</option>
          </select>
        </Field>
        {form.kind === "latency" && (
          <Field id="slo-threshold" label="Threshold (ms)">
            <Input
              id="slo-threshold"
              inputMode="decimal"
              value={form.latencyThresholdMs}
              onChange={(e) => set("latencyThresholdMs", e.target.value)}
            />
          </Field>
        )}
        <Field id="slo-objective" label="Objective (%)">
          <Input
            id="slo-objective"
            inputMode="decimal"
            value={form.objectivePercent}
            onChange={(e) => set("objectivePercent", e.target.value)}
          />
        </Field>
        <Field id="slo-window" label="Window">
          <select
            id="slo-window"
            className={selectClass}
            value={form.windowDays}
            onChange={(e) =>
              set("windowDays", e.target.value === "7" ? "7" : "30")
            }
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </Field>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={save.isPending}
          onClick={() => {
            setProblem(null);
            save.mutate();
          }}
        >
          {editing ? "Save changes" : "Create SLO"}
        </Button>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

function SloCard({ slo, onEdit }: { slo: Slo; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteSlo(slo.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["slos"] }),
  });
  const { status } = slo;
  const state = budgetState(status.errorBudget.remainingFraction);
  const width = budgetBarPercent(status.errorBudget.remainingFraction);
  return (
    <li
      data-testid="slo"
      data-state={state}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{slo.name}</h3>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">
              {slo.service}
              {slo.route ? ` ${slo.route}` : ""}
            </span>
            {" · "}
            {describeIndicator(slo)} · last {slo.windowDays} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status.breached && <Badge variant="destructive">Breached</Badge>}
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          {confirming ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Confirm delete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Objective</dt>
          <dd data-testid="objective" className="font-mono">
            {formatPercent(slo.objective)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Attainment</dt>
          <dd
            data-testid="attainment"
            className={cn("font-mono", status.breached && "text-destructive")}
          >
            {formatPercent(status.attainment)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Burn rate, 1 h</dt>
          <dd data-testid="burn-1h" className="font-mono">
            {formatBurnRate(status.burnRate["1h"])}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Burn rate, 6 h</dt>
          <dd data-testid="burn-6h" className="font-mono">
            {formatBurnRate(status.burnRate["6h"])}
          </dd>
        </div>
      </dl>
      <div className="space-y-1">
        <div
          role="progressbar"
          aria-label={`Error budget of ${slo.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={width}
          data-testid="budget-bar"
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              state === "ok" && "bg-green-500",
              state === "low" && "bg-amber-500",
              state === "spent" && "bg-destructive",
            )}
            style={{ width: `${width}%` }}
          />
        </div>
        <p data-testid="budget-text" className="text-xs text-muted-foreground">
          {describeBudget(status.errorBudget.remainingFraction)}
          {status.totalRequests > 0 &&
            ` (${Math.round(status.badRequests)} bad of ${status.totalRequests} requests)`}
        </p>
      </div>
    </li>
  );
}

/** SLOs of the standalone server: objective, attainment, budget bar and burn rates. */
export function SlosPage() {
  const [paused] = usePaused();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";
  const slos = useQuery({
    queryKey: ["slos"],
    queryFn: getSlos,
    enabled: standalone,
    refetchInterval: pollInterval(paused) === false ? false : 30_000,
    refetchIntervalInBackground: false,
  });
  // "new" | an SLO being edited | closed.
  const [panel, setPanel] = useState<"new" | Slo | null>(null);

  if (meta.data !== undefined && !standalone) {
    return (
      <section aria-label="SLOs" className="space-y-2">
        <h2 className="text-lg font-semibold">SLOs</h2>
        <p
          data-testid="slos-unavailable"
          className="text-sm text-muted-foreground"
        >
          SLOs are computed from stored history, which only the standalone
          server keeps.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label="SLOs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">SLOs</h2>
        <Button
          size="sm"
          disabled={panel !== null}
          onClick={() => setPanel("new")}
        >
          <Plus />
          New SLO
        </Button>
      </div>
      {panel !== null && (
        <SloFormPanel
          key={panel === "new" ? "new" : panel.id}
          editing={panel === "new" ? undefined : panel}
          services={meta.data?.services ?? []}
          onDone={() => setPanel(null)}
        />
      )}
      {slos.isError && slos.data === undefined && (
        <div
          role="alert"
          className="rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load SLOs.</p>
          <p className="text-sm text-muted-foreground">{slos.error?.message}</p>
        </div>
      )}
      {slos.data !== undefined &&
        (slos.data.slos.length > 0 ? (
          <ul className="space-y-3" data-testid="slos">
            {slos.data.slos.map((slo) => (
              <SloCard key={slo.id} slo={slo} onEdit={() => setPanel(slo)} />
            ))}
          </ul>
        ) : (
          <p
            data-testid="slos-empty"
            className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
          >
            No SLOs yet. Create one to track an objective over the stored
            history.
          </p>
        ))}
    </section>
  );
}
