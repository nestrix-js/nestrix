import { TriangleAlert } from "lucide-react";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What a control inside a `FormField` needs to be tied to its label, hint and error. */
export interface FieldControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  "aria-required"?: true;
}

/**
 * A labelled form field: the label (a `*` marks a required one; an optional one says so in its
 * label), a hint under the control, and an error in `text-destructive-text` that is tied to the
 * control with `aria-describedby` and `aria-invalid`. The control is a render prop so the ids
 * reach it: `<FormField id="x" label="Name" required>{(p) => <Input {...p} />}</FormField>`.
 */
export function FormField({
  id,
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: (props: FieldControlProps) => React.ReactNode;
  className?: string;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={cn("space-y-1 text-sm", className)}>
      <label
        htmlFor={id}
        className={cn(
          "block text-xs font-medium",
          // The `*` is drawn by CSS, so it is not part of the label's text or its accessible name.
          required &&
            "after:ml-0.5 after:text-destructive-text after:content-['*']",
        )}
      >
        {label}
      </label>
      {children({
        id,
        ...(error ? { "aria-invalid": true as const } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(required ? { "aria-required": true as const } : {}),
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          data-testid={`${id}-error`}
          className="text-xs font-medium text-destructive-text"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** An error the server (or a request) returned, not tied to one field; announced when it appears. */
export function FormProblem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      data-testid="form-problem"
      className="flex items-start gap-1.5 text-sm text-destructive-text"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The form frame shared by the create and edit forms: a real `<form>` (Enter submits, fetch does
 * the saving because the page's CSP forbids form posts), a legend, Esc to cancel, and focus on
 * the first field when it opens. `onSubmit` is called after the default is prevented.
 */
export function FormPanel({
  title,
  testId,
  onSubmit,
  onCancel,
  children,
  note = "* required",
  returnFocusTo,
}: {
  /** The id of the control to focus when the panel closes (the button that opened it). */
  returnFocusTo?: string;
  title: string;
  testId: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
  note?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const titleId = useId();
  useEffect(() => {
    const form = ref.current;
    form
      ?.querySelector<HTMLElement>("input:not([readonly]), select, textarea")
      ?.focus({ preventScroll: true });
    form?.scrollIntoView?.({ block: "nearest" });
    return () => {
      if (returnFocusTo !== undefined) focusField(returnFocusTo);
    };
  }, [returnFocusTo]);
  return (
    <form
      ref={ref}
      noValidate
      data-testid={testId}
      aria-labelledby={titleId}
      className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      {children}
    </form>
  );
}

/** Focus the control of a field by its id (after a validation error), once it is rendered. */
export function focusField(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * The buttons of a form: one primary (the submit) first, then Cancel. Never two primaries.
 */
export function FormActions({
  submit,
  pending,
  onCancel,
}: {
  submit: string;
  pending: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-2 border-t border-border pt-3">
      <Button type="submit" disabled={pending}>
        {submit}
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * A destructive action that asks first, in place: "Delete" turns into a labelled group with a
 * red confirm button and a Keep button. Focus goes to Keep (the safe choice), Esc cancels and
 * returns focus to the trigger, and the trigger names what it deletes for a screen reader.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  subject,
  consequence,
  pending,
  onConfirm,
  triggerClassName,
}: {
  /** The trigger, such as "Delete" or "Revoke". */
  label: string;
  /** The red button, such as "Confirm delete". */
  confirmLabel: string;
  /** What it acts on, such as the rule's name. */
  subject: string;
  /** What follows, one short sentence, shown while asking. */
  consequence?: string;
  pending?: boolean;
  onConfirm: () => void;
  triggerClassName?: string;
}) {
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) keep.current?.focus();
    else if (wasAsking.current) trigger.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-label={`${label} ${subject}`}
        className={cn(
          "border-destructive/40 text-destructive-text hover:bg-destructive/10 hover:text-destructive-text",
          triggerClassName,
        )}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <fieldset
      aria-label={`${label} ${subject}?`}
      data-testid="confirm-action"
      className="flex min-w-0 flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setAsking(false);
        }
      }}
    >
      {consequence && (
        <span className="text-xs text-muted-foreground">{consequence}</span>
      )}
      <Button
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
      <Button
        ref={keep}
        variant="ghost"
        size="sm"
        onClick={() => setAsking(false)}
      >
        Keep
      </Button>
    </fieldset>
  );
}
