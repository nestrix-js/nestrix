import type { ApiToken, ApiTokenCreateResponse } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import {
  Chip,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  SkeletonList,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createToken, getMeta, getTokens, revokeToken } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/use-now";

/** The new token, shown once. Copy uses the clipboard API where the page may (secure contexts). */
function NewToken({
  created,
  onDone,
}: {
  created: ApiTokenCreateResponse;
  onDone: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied("yes");
    } catch {
      // No clipboard access (plain HTTP on a remote host): the text is selected instead.
      setCopied("manual");
    }
  };
  return (
    <div
      data-testid="new-token"
      role="status"
      className="space-y-3 rounded-lg border border-warning/60 bg-warning/10 p-4"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-[var(--warning-text)]"
          aria-hidden
        />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            Token "{created.token.name}" created. Copy it now: it is not shown
            again.
          </p>
          <p className="text-xs text-muted-foreground">
            Only a hash is stored, so a lost token cannot be recovered; create a
            new one and revoke this one instead.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={field}
          readOnly
          aria-label="New API token"
          data-testid="new-token-secret"
          className="min-w-0 flex-1 font-mono"
          value={created.secret}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="outline" onClick={() => void copy()}>
          <Copy />
          Copy
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      {copied && (
        <p data-testid="copy-state" className="text-xs text-muted-foreground">
          {copied === "yes"
            ? "Copied to the clipboard."
            : "Selected: press Ctrl+C or Cmd+C to copy."}
        </p>
      )}
    </div>
  );
}

function TokenRow({ token, now }: { token: ApiToken; now: number }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeToken(token.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tokens"] }),
  });
  const revoked = token.revokedAtUnixMs !== null;
  return (
    <tr
      data-testid="token"
      className="border-t border-border hover:bg-muted/40"
    >
      <td className="px-4 py-2.5 font-medium">{token.name}</td>
      <td className="px-4 py-2.5 font-mono text-xs">{token.prefix}…</td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {formatRelative(token.createdAtUnixMs, now)}
      </td>
      <td
        data-testid="last-used"
        className="px-4 py-2.5 text-xs text-muted-foreground"
      >
        {token.lastUsedAtUnixMs === null
          ? "never"
          : formatRelative(token.lastUsedAtUnixMs, now)}
      </td>
      <td className="px-4 py-2.5 text-right">
        {revoked ? (
          <Chip tone="neutral">Revoked</Chip>
        ) : confirming ? (
          <span className="inline-flex gap-1">
            <Button
              variant="destructive"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Confirm revoke
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}

/** API tokens of the standalone server: read-only access to the query API for tools. */
function ApiTokens() {
  const queryClient = useQueryClient();
  const now = useNow();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: getTokens });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiTokenCreateResponse | null>(null);
  const create = useMutation({
    mutationFn: () => createToken(name.trim()),
    onSuccess: async (answer) => {
      setCreated(answer);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const list = tokens.data?.tokens ?? [];

  return (
    <Section
      testId="api-tokens"
      title="API tokens"
      description="Read-only access to the query API for tools such as the Nestrix MCP server"
      source="stored on this server; only a hash is kept"
      flush
      actions={
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <KeyRound className="size-4" />
        </span>
      }
    >
      <div className="space-y-4 border-t border-border p-4">
        <p className="text-sm text-muted-foreground">
          A token reads the query API (traces, errors, routes, classes, map)
          with <code className="font-mono">Authorization: Bearer</code>. It
          cannot change anything, sign in to this page, or send traces.
        </p>
        <div className="flex max-w-xl gap-2">
          <Input
            aria-label="Token name"
            placeholder="Name, such as laptop MCP"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            disabled={create.isPending || name.trim() === ""}
            onClick={() => create.mutate()}
          >
            Create token
          </Button>
        </div>
        {create.isError && (
          <p role="alert" className="text-sm text-[var(--destructive-text)]">
            {create.error.message}
          </p>
        )}
        {created && (
          <NewToken created={created} onDone={() => setCreated(null)} />
        )}
      </div>
      {tokens.data === undefined && !tokens.isError && (
        <div
          className="border-t border-border p-4"
          data-testid="tokens-loading"
        >
          <SkeletonList rows={2} className="border-0 p-0" />
        </div>
      )}
      {tokens.isError && tokens.data === undefined && (
        <div className="border-t border-border p-4">
          <ErrorState
            testId="tokens-error"
            title="Could not load tokens"
            message={tokens.error.message}
            onRetry={() => tokens.refetch()}
          />
        </div>
      )}
      {tokens.data !== undefined &&
        (list.length > 0 ? (
          <div className="overflow-x-auto border-t border-border">
            <table data-testid="tokens" className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Token</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <TokenRow key={t.id} token={t} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-border p-4">
            <EmptyState
              testId="tokens-empty"
              icon={<KeyRound />}
              title="No tokens yet"
            >
              Name a token above and create it to give a tool read-only access
              to this server's data.
            </EmptyState>
          </div>
        ))}
    </Section>
  );
}

/** Settings of the standalone server. */
export function SettingsPage() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  if (meta.data !== undefined && meta.data.mode !== "standalone") {
    return (
      <section aria-label="Settings" className="space-y-6">
        <PageHeader
          title="Settings"
          description="Access and configuration of the server"
        />
        <EmptyState
          testId="settings-unavailable"
          title="Nothing to configure here"
        >
          These settings belong to the standalone server.
        </EmptyState>
      </section>
    );
  }
  return (
    <section aria-label="Settings" className="space-y-6">
      <PageHeader
        title="Settings"
        description="Access and configuration of the server"
      />
      {meta.data !== undefined && <ApiTokens />}
    </section>
  );
}
