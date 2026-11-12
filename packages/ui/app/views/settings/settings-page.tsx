import type { ApiToken, ApiTokenCreateResponse } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
      className="space-y-2 rounded-lg border border-border bg-secondary/40 p-4"
    >
      <p className="text-sm font-medium">
        Token "{created.token.name}" created. Copy it now: it is not shown
        again.
      </p>
      <div className="flex gap-2">
        <Input
          ref={field}
          readOnly
          aria-label="New API token"
          data-testid="new-token-secret"
          className="font-mono"
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
    <tr data-testid="token" className="border-t border-border">
      <td className="py-2 pr-3">{token.name}</td>
      <td className="py-2 pr-3 font-mono text-xs">{token.prefix}…</td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {formatRelative(token.createdAtUnixMs, now)}
      </td>
      <td
        data-testid="last-used"
        className="py-2 pr-3 text-xs text-muted-foreground"
      >
        {token.lastUsedAtUnixMs === null
          ? "never"
          : formatRelative(token.lastUsedAtUnixMs, now)}
      </td>
      <td className="py-2 text-right">
        {revoked ? (
          <Badge variant="secondary">Revoked</Badge>
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
    <section aria-label="API tokens" className="space-y-3">
      <h3 className="flex items-center gap-2 font-semibold">
        <KeyRound className="size-4" />
        API tokens
      </h3>
      <p className="text-sm text-muted-foreground">
        A token reads the query API (traces, errors, routes, classes, map) with{" "}
        <code className="font-mono">Authorization: Bearer</code>, for tools such
        as the Nestrix MCP server. It cannot change anything, sign in to this
        page, or send traces.
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
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      {created && (
        <NewToken created={created} onDone={() => setCreated(null)} />
      )}
      {tokens.isError && tokens.data === undefined && (
        <p role="alert" className="text-sm text-destructive">
          Could not load tokens: {tokens.error.message}
        </p>
      )}
      {tokens.data !== undefined &&
        (list.length > 0 ? (
          <table data-testid="tokens" className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-1 font-medium">Name</th>
                <th className="pb-1 font-medium">Token</th>
                <th className="pb-1 font-medium">Created</th>
                <th className="pb-1 font-medium">Last used</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <TokenRow key={t.id} token={t} now={now} />
              ))}
            </tbody>
          </table>
        ) : (
          <p
            data-testid="tokens-empty"
            className="text-sm text-muted-foreground"
          >
            No tokens yet.
          </p>
        ))}
    </section>
  );
}

/** Settings of the standalone server. */
export function SettingsPage() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  if (meta.data !== undefined && meta.data.mode !== "standalone") {
    return (
      <section aria-label="Settings" className="space-y-2">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p
          data-testid="settings-unavailable"
          className="text-sm text-muted-foreground"
        >
          These settings belong to the standalone server.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Settings" className="space-y-4">
      <h2 className="text-lg font-semibold">Settings</h2>
      {meta.data !== undefined && <ApiTokens />}
    </section>
  );
}
