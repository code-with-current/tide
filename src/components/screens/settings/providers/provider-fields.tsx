import { Brain, Check, Copy, Eye, Plug } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ProviderLogo } from "@/components/primitives/provider-logo";
import type { ApiStyle } from "@/types";
import { cn } from "@/lib/utils";

// Shared form primitives for the provider settings screen — used by both the
// inline edit form (providers.tsx) and the add-wizard steps. Lives in its own
// module so providers.tsx → add-wizard → providers.tsx doesn't form a circular
// import (that cycle broke HMR: "Cannot access 'PROTOCOL' before initialization").

// Per-protocol form config — drives placeholders, auth-header hints, and the resolved endpoint path. Centralizing here keeps add + edit forms in sync and makes the protocol↔behavior relationship explicit (the auth header is the z.ai coding-vs-anthropic gotcha — each protocol speaks only one, mixing them 404s).
export const PROTOCOL = {
  anthropic: {
    baseUrlPlaceholder: "https://api.anthropic.com",
    keyPlaceholder: "sk-ant-…",
    authHeader: "x-api-key",
  },
  openai: {
    baseUrlPlaceholder: "https://api.openai.com/v1",
    keyPlaceholder: "sk-…",
    authHeader: "Authorization: Bearer",
  },
} as const satisfies Record<
  ApiStyle,
  { baseUrlPlaceholder: string; keyPlaceholder: string; authHeader: string }
>;

// =============================================================
// EndpointPreview — echoes the typed baseUrl verbatim. No trailing-slash strip, no /v1 auto-append, no path suffix: provider endpoints vary (z.ai's coding relay lives at /api/coding/pas/v4; some gateways want /v1, others don't), so transforming the input here would misrepresent non-standard gateways. The SDK appends its own path at runtime.
// =============================================================
export function EndpointPreview({
  apiStyle,
  baseUrl,
}: {
  apiStyle: ApiStyle;
  baseUrl: string;
}) {
  const full = baseUrl.trim();
  // Path the SDK appends at runtime per protocol — shown dimmed so the
  // style↔endpoint relationship reads at a glance even for providers whose
  // base URL is identical across styles (OpenCode Zen). The input itself is
  // still saved verbatim; nonstandard gateways may append differently.
  const suffix = apiStyle === "openai" ? "/chat/completions" : "/v1/messages";
  return (
    <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/[0.06] to-transparent p-3.5">
      <div className="flex items-center gap-2 mb-2">
        <Plug className="size-3.5 text-primary" />
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
          Resolved endpoint
        </span>
        <Badge
          variant="secondary"
          className="ml-auto text-[9px] uppercase tracking-wide"
        >
          {apiStyle === "openai" ? "OpenAI" : "Anthropic"}
        </Badge>
      </div>
      <code className="font-mono text-[12px] text-foreground break-all leading-relaxed block min-h-[1.1em]">
        {full || (
          <span className="text-muted-foreground/40">
            Enter a base URL to preview the endpoint…
          </span>
        )}
        {full && (
          <span
            className="text-muted-foreground/55"
            title="Path appended by the SDK at request time — some gateways differ."
          >
            {suffix}
          </span>
        )}
      </code>
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border/50">
        <span className="text-[10px] text-muted-foreground/45">
          SDK posts tool-calling requests here
        </span>
        {full && <CopyButton text={full} />}
      </div>
    </div>
  );
}

export function SectionLabel({
  icon,
  count,
  action,
  children,
}: {
  icon: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground/55">{icon}</span>
      <h3 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
        {children}
      </h3>
      {count != null && (
        <Badge variant="secondary" className="text-[9px] font-mono">
          {count}
        </Badge>
      )}
      {action && <div className="ml-auto min-w-0">{action}</div>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-1 text-[10px] text-muted-foreground/55 hover:text-foreground cursor-pointer transition-colors"
    >
      {copied ? (
        <>
          <Check className="size-2.5 text-success" /> Copied
        </>
      ) : (
        <>
          <Copy className="size-2.5" /> Copy
        </>
      )}
    </button>
  );
}

/** A section header for the grouped dialog: icon + label + count + hint. */
export function FetchSection({
  icon,
  tone,
  label,
  count,
  hint,
  children,
}: {
  icon: string;
  tone: "success" | "warning" | "muted";
  label: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : "text-muted-foreground/50";
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-1.5 px-4 py-1.5 sticky top-0 bg-popover/95 backdrop-blur z-[1]">
        <span className={cn("text-[11px]", toneClass)}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
          {label}
        </span>
        <Badge variant="secondary" className="text-[8px] px-1 py-0 font-mono">
          {count}
        </Badge>
        <span className="text-[9px] text-muted-foreground/40 ml-auto lowercase">
          {hint}
        </span>
      </div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

/** A checkable model row (live + matched + none sections). */
export function FetchRow({
  checked,
  onToggle,
  modelId,
  reasoning,
  vision,
  mandatory,
  meta,
  disabled,
  disabledNote,
}: {
  checked: boolean;
  onToggle: () => void;
  modelId: string;
  reasoning?: boolean;
  /** True when the model accepts image input — shows an eye badge. */
  vision?: boolean;
  /** True when reasoning is mandatory (always on) — shows a lock badge. */
  mandatory?: boolean;
  meta?: string;
  /** Non-selectable row (model not served on this API style) — rendered dimmed. */
  disabled?: boolean;
  /** Shown as a badge on disabled rows, e.g. "OpenAI style only". */
  disabledNote?: string;
}) {
  if (disabled) {
    return (
      <div
        className="w-full flex items-center gap-2 px-4 py-1.5 text-left opacity-55"
        title={disabledNote}
      >
        <span className="size-3.5 rounded border border-border/60 flex items-center justify-center shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <code className="font-mono text-[11px] text-foreground/60 truncate">
              {modelId}
            </code>
            {reasoning && <Brain className="size-3 text-reasoning/70 shrink-0" />}
            {vision && <Eye className="size-3 text-info/70 shrink-0" />}
            {disabledNote && (
              <Badge
                variant="secondary"
                className="text-[8px] px-1 py-0 uppercase text-muted-foreground/70 shrink-0"
              >
                {disabledNote}
              </Badge>
            )}
          </div>
          {meta && (
            <div className="text-[10px] text-muted-foreground/45 pl-4 truncate">
              {meta}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2 px-4 py-1.5 transition-colors text-left",
        checked ? "bg-primary/10" : "hover:bg-secondary/60",
      )}
    >
      <span
        className={cn(
          "size-3.5 rounded border flex items-center justify-center shrink-0 transition-colors",
          checked ? "bg-primary border-primary" : "border-border",
        )}
      >
        {checked && <Check className="size-2.5 text-primary-foreground" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <code className="font-mono text-[11px] text-foreground/80 truncate">
            {modelId}
          </code>
          {reasoning && <Brain className="size-3 text-reasoning shrink-0" />}
          {vision && <Eye className="size-3 text-info shrink-0" />}
          {mandatory && (
            <Badge
              variant="secondary"
              className="text-[8px] px-1 py-0 uppercase text-reasoning/80 shrink-0"
              title="reasoning always on"
            >
              always
            </Badge>
          )}
        </div>
        {meta && (
          <div className="text-[10px] text-muted-foreground/55 pl-4 truncate">
            {meta}
          </div>
        )}
      </div>
    </button>
  );
}

export function FormField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground/60">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** API style — prominent two-card selector at the top of the form. The choice
 *  is consequential (sets protocol + endpoint path), so it's a big branded
 *  card with an active check, not a buried field. */
export function ApiStylePicker({
  value,
  onChange,
}: {
  value: ApiStyle;
  onChange: (s: ApiStyle) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <StyleCard
        active={value === "anthropic"}
        onClick={() => onChange("anthropic")}
        title="Anthropic"
        detail="/v1/messages"
        tone="anthropic"
      />
      <StyleCard
        active={value === "openai"}
        onClick={() => onChange("openai")}
        title="OpenAI"
        detail="/chat/completions"
        tone="openai"
      />
    </div>
  );
}

function StyleCard({
  active,
  onClick,
  title,
  detail,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  detail: string;
  tone: "anthropic" | "openai";
}) {
  // Brand tint per protocol — used for the active ring, avatar glow, and the
  // subtle background wash. Kept as hex (not CSS vars) because these are
  // fixed brand colors, not theme tokens.
  const tint = tone === "anthropic" ? "#d97757" : "#10a37f";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative flex items-center gap-2.5 p-3 rounded-xl text-left transition-all duration-150 border",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "bg-secondary shadow-sm"
          : "border-border bg-card hover:border-primary/30 hover:bg-secondary/60",
      )}
      style={
        active
          ? { borderColor: `${tint}55`, boxShadow: `inset 0 0 0 1px ${tint}40` }
          : undefined
      }
    >
      <StyleAvatar tone={tone} active={active} />
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "text-[12.5px] font-semibold tracking-tight",
            active ? "text-foreground" : "text-foreground/80",
          )}
        >
          {title}
        </div>
        <div className="text-[10px] text-muted-foreground/55 font-mono mt-0.5 truncate">
          {detail}
        </div>
      </div>
      {active && (
        <span
          className="size-4 rounded-full flex items-center justify-center shrink-0"
          style={{ background: tint }}
        >
          <Check className="size-3 text-white" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/** Brand-colored letter avatar — mirrors the ProviderAvatar used in the
 *  composer/selector so the protocol reads at a glance. Rounded-full with a
 *  subtle ring on the active card so the selection reads at a glance. */
function StyleAvatar({ tone, active }: { tone: "anthropic" | "openai"; active: boolean }) {
  const base = "size-8 rounded-lg flex items-center justify-center text-white shrink-0 transition-shadow";
  if (tone === "anthropic") {
    return (
      <span
        className={cn(base, active && "shadow-[0_0_0_3px_rgba(217,119,87,0.15)]")}
        style={{ background: "linear-gradient(135deg,#d97757,#b8553f)" }}
      >
        <ProviderLogo apiStyle="anthropic" className="size-4" />
      </span>
    );
  }
  return (
    <span
      className={cn(base, active && "shadow-[0_0_0_3px_rgba(16,163,127,0.15)]")}
      style={{ background: "#10a37f" }}
    >
      <ProviderLogo apiStyle="openai" className="size-4" />
    </span>
  );
}
