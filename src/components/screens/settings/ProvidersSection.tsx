import {
  Plus,
  Pencil,
  Trash2,
  ShieldCheck,
  Plug,
  Check,
  Server,
  Brain,
  PlugZap,
  Copy,
  Search,
  KeyRound,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dot } from "@/components/primitives";
import * as api from "@/lib/api/client";
import { useProviders, useAddProvider } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiStyle, Provider, Model, ProviderModelMeta } from "@/types";
import { cn, formatContext } from "@/lib/utils";
import { formatPriceRate } from "@/lib/queries";
import { SettingsHeader } from "./shared";

// =============================================================
// ProvidersSection — LLM provider management, master/detail.
// Sidebar lists added providers (+ "New"); selecting one drives
// the main pane's inline edit form. Add and edit share the same
// ProviderDetail component (no modal) — the sidebar IS the
// navigation between them.
// =============================================================

// Per-protocol form config — drives placeholders, auth-header hints, and
// the resolved endpoint path. Centralizing here keeps the add + edit forms
// in sync and makes the protocol↔behavior relationship explicit (the auth
// header in particular is the z.ai coding-vs-anthropic gotcha — each
// protocol speaks only one, and mixing them 404s).
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

type Selection = string | null;

export function ProvidersSection() {
  const { data: providers, isLoading } = useProviders();
  const [selectedId, setSelectedId] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const selected = providers?.find((p) => p.id === selectedId);
  const q = query.trim().toLowerCase();
  const filtered =
    q && providers
      ? providers.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.apiStyle.toLowerCase().includes(q),
        )
      : providers;

  return (
    <div className="h-full flex flex-col overflow-hidden p-6 gap-4">
      <SettingsHeader
        title="LLM Providers"
        description="OpenAI- or Anthropic-compatible endpoints. Set any base URL."
        action={
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-3.5" /> Add provider
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 flex-1 min-h-0">
        {/* Sidebar: search → add → list (no auto-select; starts empty). */}
        <aside className="flex flex-col lg:border-r border-border lg:pr-4 min-h-0 gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers…"
              className="w-full h-7 pl-7 pr-2 text-[11.5px] bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="justify-start text-[11.5px] h-7"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-3.5" /> Add provider
          </Button>
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/55 font-semibold">
              Providers
            </span>
            {filtered && filtered.length > 0 && (
              <Badge variant="secondary" className="font-mono text-[9px]">
                {filtered.length}
              </Badge>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scroll space-y-0.5">
            {isLoading && (
              <div className="px-2 py-3 text-[11px] text-muted-foreground/50">
                Loading…
              </div>
            )}
            {filtered?.map((p) => (
              <ProviderListItem
                key={p.id}
                provider={p}
                active={selectedId === p.id}
                onSelect={() => setSelectedId(p.id)}
              />
            ))}
          </div>
        </aside>

        {/* Detail */}
        <section className="flex flex-col min-h-0">
          {selected ? (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              onDeleted={() =>
                setSelectedId(
                  providers?.find((p) => p.id !== selected.id)?.id ?? null,
                )
              }
            />
          ) : (
            <EmptyDetail />
          )}
        </section>
      </div>

      {dialogOpen && (
        <ProviderFormDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(id) => {
            setSelectedId(id);
            setDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}

// =============================================================
// ProviderListItem — one row in the sidebar.
// Active row: primary tint + left accent bar (the "you are here"
// cue the UX active-state rule calls for). Keyboard-selectable.
// =============================================================

function ProviderListItem({
  provider,
  active,
  onSelect,
}: {
  provider: Provider;
  active: boolean;
  onSelect: () => void;
}) {
  const styleLabel = provider.apiStyle === "openai" ? "O" : "A";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "h-4 w-0.5 rounded-full shrink-0",
          active ? "bg-primary" : "bg-transparent",
        )}
      />
      <span className="text-[11.5px] font-medium flex-1 truncate">
        {provider.name}
      </span>
      {!provider.enabled && (
        <span className="text-[9px] text-muted-foreground/45">off</span>
      )}
      {provider.enabled && <Dot tone="ok" className="size-1 shrink-0" />}
      <Badge
        variant="secondary"
        className="font-mono text-[9px] uppercase px-1 py-0"
      >
        {styleLabel}
      </Badge>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/45 p-8">
      <PlugZap className="size-5" />
      <span className="text-xs">Select a provider, or add a new one.</span>
    </div>
  );
}

// =============================================================
// ProviderFormDialog — add a NEW provider (modal). Editing existing
// providers stays inline (ProviderDetail, auto-save); add goes through
// this dialog with an explicit Save because the provider doesn't exist
// to auto-save yet. Composes the same sub-components (EndpointPreview,
// ApiStylePicker, SectionLabel, FormField) as the inline form.
// =============================================================

function ProviderFormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const addProvider = useAddProvider();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [apiStyle, setApiStyle] = useState<ApiStyle>("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { alias: "", modelId: "", context: "" },
  ]);

  // Follow the protocol with its canonical endpoint when toggling style
  // (only if the URL is empty or still a default). Mirrors ProviderDetail.
  const prevStyle = useRef<ApiStyle>(apiStyle);
  useEffect(() => {
    if (prevStyle.current === apiStyle) return;
    prevStyle.current = apiStyle;
    const AD = "https://api.anthropic.com";
    const OD = "https://api.openai.com/v1";
    const target = apiStyle === "anthropic" ? AD : OD;
    setBaseUrl((cur) => {
      const t = cur.trim();
      return t === "" || t === AD || t === OD ? target : cur;
    });
  }, [apiStyle]);

  const rowsToModels = (): Model[] =>
    rows
      .filter((r) => r.modelId.trim() || r.alias.trim())
      .map((r) => ({
        id: `m_${Math.random().toString(36).slice(2, 8)}`,
        alias: r.alias.trim() || r.modelId.trim(),
        modelId: r.modelId.trim(),
        contextWindow: parseInt(r.context, 10) || 200_000,
        providerId: "",
        catalogId: r.catalogId,
        reasoning: r.reasoning,
        reasoningMandatory: r.reasoningMandatory,
        supportedEfforts: r.supportedEfforts,
        priceLabel: r.priceLabel,
        inputCostPerToken: r.inputCostPerToken,
        outputCostPerToken: r.outputCostPerToken,
        cacheReadCostPerToken: r.cacheReadCostPerToken,
        cacheWriteCostPerToken: r.cacheWriteCostPerToken,
      }));

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      // Save exactly what the user typed — no trailing-slash strip, no /v1
      // auto-append. Provider endpoints vary (z.ai coding relay lives at
      // /api/coding/paas/v4; some gateways want /v1, others don't), so the
      // form must not mutate the input. The EndpointPreview below shows
      // what the SDK will resolve to; the user decides what to type.
      const baseUrlToSave = baseUrl.trim();
      const created = await addProvider.mutateAsync({
        name: name.trim() || "Untitled",
        apiStyle,
        baseUrl: baseUrlToSave,
        apiKey: apiKey.trim() || undefined,
        models: rowsToModels(),
      });
      qc.invalidateQueries({ queryKey: ["providers"] });
      onCreated(created.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="min-w-[60%] max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-3.5 flex-row items-center gap-3 border-b border-border space-y-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              background: "rgba(217,119,87,0.12)",
              border: "1px solid rgba(217,119,87,0.25)",
            }}
          >
            <KeyRound className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-base font-semibold text-left">
              Add provider
            </DialogTitle>
            <DialogDescription className="text-xs mt-0.5">
              Configure an OpenAI- or Anthropic-compatible endpoint.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto scroll">
          <div className="space-y-2">
            <SectionLabel icon={<Plug className="size-3" />}>
              API style
            </SectionLabel>
            <ApiStylePicker value={apiStyle} onChange={setApiStyle} />
          </div>

          <EndpointPreview apiStyle={apiStyle} baseUrl={baseUrl} />

          <div className="grid grid-cols-2 gap-4">
            <FormField id="name" label="Provider name">
              <Input
                className="h-8 text-[12.5px]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="OpenRouter, z.ai, LM Studio…"
              />
            </FormField>
            <FormField id="baseUrl" label="Base URL">
              <Input
                className="font-mono text-[12px] h-8"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={PROTOCOL[apiStyle].baseUrlPlaceholder}
              />
            </FormField>
            <FormField id="key" label="API key">
              <Input
                type="password"
                className="font-mono text-[12px] h-8"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={PROTOCOL[apiStyle].keyPlaceholder}
              />
              <p className="text-[10px] text-muted-foreground/50 mt-1 flex items-center gap-1">
                <ShieldCheck className="size-2.5 text-success" />
                Sent as{" "}
                <span className="font-mono">
                  {PROTOCOL[apiStyle].authHeader}
                </span>
                . Stored in the OS keychain.
              </p>
            </FormField>
          </div>

          <div className="space-y-2">
            <SectionLabel
              icon={<Brain className="size-3" />}
              count={rowsToModels().length}
            >
              Models
            </SectionLabel>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">
                        Alias
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">
                        Model ID
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-20">
                        Context
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-28">
                        Price
                      </TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className="border-border/60">
                        <TableCell className="py-1 pr-1">
                          <div className="flex items-center gap-1">
                            {row.reasoning && (
                              <Brain className="size-3 text-reasoning shrink-0" />
                            )}
                            <input
                              className="w-full bg-transparent border-0 outline-none text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.alias}
                              onChange={(e) =>
                                updateRow(i, { alias: e.target.value })
                              }
                              placeholder="Alias"
                            />
                          </div>
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <input
                            className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                            value={row.modelId}
                            onChange={(e) =>
                              updateRow(i, { modelId: e.target.value })
                            }
                            placeholder="model-id"
                          />
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          {row.catalogId ? (
                            <div
                              className="flex items-center gap-1 px-1 py-0.5"
                              title={`Catalog: ${row.catalogId}`}
                            >
                              <span className="font-mono text-[11.5px] text-muted-foreground">
                                {row.context || "—"}
                              </span>
                              <Badge
                                variant="secondary"
                                className="text-[8px] px-1 py-0 uppercase tracking-wide text-success/80"
                              >
                                cat
                              </Badge>
                            </div>
                          ) : (
                            <input
                              className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.context}
                              onChange={(e) =>
                                updateRow(i, { context: e.target.value })
                              }
                              placeholder="200000"
                            />
                          )}
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          {row.priceLabel ? (
                            <span className="font-mono text-[10.5px] text-muted-foreground/70">
                              {row.priceLabel}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/30">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="py-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground/45 hover:text-destructive"
                            onClick={() =>
                              setRows((rs) => rs.filter((_, idx) => idx !== i))
                            }
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="px-3 py-2 border-t border-border bg-secondary/20 flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setRows((rs) => [
                      ...rs,
                      { alias: "", modelId: "", context: "" },
                    ])
                  }
                  className="text-[11px] h-7 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3" /> Add row
                </Button>
                <FetchModelsButton
                  apiStyle={apiStyle}
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                  onFetched={(models) =>
                    setRows((prev) => appendFetchedModels(prev, models))
                  }
                  existingModelIds={rows.map((r) => r.modelId)}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-3 bg-secondary border-t border-border flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground/55 flex items-center gap-1.5">
            <ShieldCheck className="size-3 text-success" /> API key stored in
            the OS keychain.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={saving}
              onClick={save}
            >
              {saving ? (
                "Saving…"
              ) : (
                <>
                  <Check className="size-3.5" /> Save provider
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// ProviderDetail — the inline edit form (auto-save).
// Selecting a provider in the sidebar renders this; edits persist
// ~600ms after the last change. Add is handled by ProviderFormDialog.
// =============================================================

export interface Row {
  alias: string;
  modelId: string;
  context: string;
  /** LiteLLM catalog canonical id, set when the row came from the Fetch Models
   *  dialog with a confident match. Enables O(1) metadata lookup at runtime. */
  catalogId?: string;
  /** "$in / $out per Mtok" price label, set when the row came from the Fetch
   *  Models dialog with a catalog/live match. Display-only. */
  priceLabel?: string;
  /** Whether the model supports reasoning (sourced from a live provider response).
   *  Drives the brain icon in the table — replaces the heuristic prefix table. */
  reasoning?: boolean;
  /** Raw per-token rates for cost calculation (USD). */
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadCostPerToken?: number;
  cacheWriteCostPerToken?: number;
  /** True when the model always reasons (sourced from a live provider response).
   *  Persisted onto Model so the thinking-level selector can disable "off". */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels (sourced from a live provider response). */
  supportedEfforts?: string[];
  /** Present when the row maps to an existing model (edit mode) — preserves
   *  identity so updateProvider doesn't drop/recreate models on every save. */
  id?: string;
  providerId?: string;
}

function ProviderDetail({
  provider,
  onDeleted,
}: {
  provider: Provider;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(provider.name);
  const [apiStyle, setApiStyle] = useState<ApiStyle>(provider.apiStyle);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  // Key field starts EMPTY on edit — the decrypted key is never pre-filled
  // into the DOM. The save below omits apiKey from the patch when the field
  // is blank, so an untouched form preserves whatever's in the keychain.
  // Type a new value to replace; there's no explicit "clear key" affordance
  // (delete the provider if you want the key gone).
  const [apiKey, setApiKey] = useState("");
  const hasStoredKey = !!provider.apiKey;
  const [rows, setRows] = useState<Row[]>(
    provider.models.map((m) => ({
      alias: m.alias,
      modelId: m.modelId,
      context: String(m.contextWindow),
      catalogId: m.catalogId,
      reasoning: m.reasoning,
      reasoningMandatory: m.reasoningMandatory,
      supportedEfforts: m.supportedEfforts,
      priceLabel: m.priceLabel,
      inputCostPerToken: m.inputCostPerToken,
      outputCostPerToken: m.outputCostPerToken,
      cacheReadCostPerToken: m.cacheReadCostPerToken,
      cacheWriteCostPerToken: m.cacheWriteCostPerToken,
      id: m.id,
      providerId: m.providerId,
    })),
  );

  // When the API style changes, follow it with the protocol's canonical
  // endpoint — but ONLY if the URL is empty or still one of the defaults.
  // A custom URL (z.ai proxy, OpenRouter, LM Studio, etc.) is preserved so
  // toggling protocol never clobbers the user's input. Skips the mount.
  const prevStyle = useRef<ApiStyle>(apiStyle);
  useEffect(() => {
    if (prevStyle.current === apiStyle) return;
    prevStyle.current = apiStyle;
    const ANTHROPIC_DEFAULT = "https://api.anthropic.com";
    const OPENAI_DEFAULT = "https://api.openai.com/v1";
    const target =
      apiStyle === "anthropic" ? ANTHROPIC_DEFAULT : OPENAI_DEFAULT;
    setBaseUrl((cur) => {
      const t = cur.trim();
      if (t === "" || t === ANTHROPIC_DEFAULT || t === OPENAI_DEFAULT)
        return target;
      return cur;
    });
  }, [apiStyle]);

  const rowsToModels = (): Model[] =>
    rows
      .filter((r) => r.modelId.trim() || r.alias.trim())
      .map((r) => ({
        id: r.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
        alias: r.alias.trim() || r.modelId.trim(),
        modelId: r.modelId.trim(),
        contextWindow: parseInt(r.context, 10) || 200_000,
        providerId: r.providerId ?? provider.id,
        catalogId: r.catalogId,
        reasoning: r.reasoning,
        reasoningMandatory: r.reasoningMandatory,
        supportedEfforts: r.supportedEfforts,
        priceLabel: r.priceLabel,
        inputCostPerToken: r.inputCostPerToken,
        outputCostPerToken: r.outputCostPerToken,
        cacheReadCostPerToken: r.cacheReadCostPerToken,
        cacheWriteCostPerToken: r.cacheWriteCostPerToken,
      }));

  // Debounced auto-save. Skip the mount so loading the form doesn't write.
  // "New provider" creates a real provider immediately (in the sidebar), so
  // this form is always editing — no Save/Cancel. Edits persist ~600ms after
  // the last keystroke / row change.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => {
      // Save exactly what the user typed — no trailing-slash strip, no /v1
      // auto-append (see the add form for rationale).
      const baseUrlToSave = baseUrl.trim();
      // Build the patch WITHOUT apiKey, then add it only if the user typed
      // one. Omitting the field entirely (vs sending undefined) is the
      // robust way to say "don't touch the keychain entry" — structured
      // clone over IPC preserves undefined, but being explicit avoids any
      // ambiguity at the store layer.
      const patch: Parameters<typeof api.updateProvider>[1] = {
        name: name.trim() || "Untitled",
        apiStyle,
        baseUrl: baseUrlToSave,
        models: rowsToModels(),
      };
      const newKey = apiKey.trim();
      if (newKey) patch.apiKey = newKey;
      void api
        .updateProvider(provider.id, patch)
        .then(() => qc.invalidateQueries({ queryKey: ["providers"] }));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, apiStyle, baseUrl, apiKey, rows]);

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{
            background: "rgba(217,119,87,0.12)",
            border: "1px solid rgba(217,119,87,0.25)",
          }}
        >
          <Pencil className="size-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{provider.name}</div>
          <div className="text-[11px] text-muted-foreground/55">
            Edits save automatically.
          </div>
        </div>
        <EnableToggle provider={provider} />
        <DeleteProviderAction provider={provider} onDone={onDeleted} />
      </div>

      {/* Body — single scrollable column: live endpoint preview + sections.
          The preview resolves baseUrl + path live, making the API-style↔URL
          relationship concrete (kills the recurring "/v1" confusion). */}
      <div className="flex-1 overflow-y-auto scroll">
        <div className="px-6 py-5 space-y-6">
          {/* API style — the most consequential choice (sets protocol + path),
              so it sits at the top as a prominent selector, not a buried field. */}
          <div className="space-y-2">
            <SectionLabel icon={<Plug className="size-3" />}>
              API style
            </SectionLabel>
            <ApiStylePicker value={apiStyle} onChange={setApiStyle} />
          </div>

          <EndpointPreview apiStyle={apiStyle} baseUrl={baseUrl} />

          {/* Connection */}
          <section className="space-y-3.5">
            <SectionLabel icon={<Server className="size-3" />}>
              Connection
            </SectionLabel>
            <FormField id="name" label="Provider name">
              <Input
                className="h-8 text-[12.5px]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="OpenRouter, z.ai, LM Studio…"
              />
            </FormField>

            <FormField id="baseUrl" label="Base URL">
              <Input
                className="font-mono text-[12px] h-8"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={PROTOCOL[apiStyle].baseUrlPlaceholder}
              />
              <p className="text-[10px] text-muted-foreground/50 mt-1">
                {apiStyle === "anthropic" ? (
                  <>
                    Official:{" "}
                    <span className="font-mono">https://api.anthropic.com</span>
                    . Anthropic-compatible proxy:{" "}
                    <span className="font-mono">api.z.ai/api/anthropic</span>.
                  </>
                ) : (
                  <>
                    Official:{" "}
                    <span className="font-mono">https://api.openai.com/v1</span>
                    . OpenAI-compatible proxies (z.ai, OpenRouter, LM Studio)
                    expose their own <span className="font-mono">/v1</span> URL.
                  </>
                )}
              </p>
            </FormField>

            <FormField id="key" label="API key">
              <Input
                type="password"
                className="font-mono text-[12px] h-8"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  hasStoredKey
                    ? "•••••••• (saved) — type a new key to replace"
                    : PROTOCOL[apiStyle].keyPlaceholder
                }
              />
              <div className="flex items-center justify-between mt-1 gap-2">
                <p className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                  <ShieldCheck className="size-2.5 text-success" />
                  Sent as{" "}
                  <span className="font-mono">
                    {PROTOCOL[apiStyle].authHeader}
                  </span>
                  . Stored in the OS keychain.
                </p>
                {hasStoredKey ? (
                  <span className="text-[10px] text-success flex items-center gap-0.5 shrink-0">
                    <Check className="size-2.5" /> Key on file
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/45 shrink-0">
                    No key set
                  </span>
                )}
              </div>
            </FormField>
          </section>

          {/* Models */}
          <section className="space-y-3">
            <SectionLabel
              icon={<Brain className="size-3" />}
              count={rowsToModels().length}
            >
              Models
            </SectionLabel>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">
                        Alias
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">
                        Model ID
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-20">
                        Context
                      </TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-28">
                        Price
                      </TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className="border-border/60">
                        <TableCell className="py-1 pr-1">
                          <div className="flex items-center gap-1">
                            {row.reasoning && (
                              <Brain className="size-3 text-reasoning shrink-0" />
                            )}
                            <input
                              className="w-full bg-transparent border-0 outline-none text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.alias}
                              onChange={(e) =>
                                updateRow(i, { alias: e.target.value })
                              }
                              placeholder="Alias"
                            />
                          </div>
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <input
                            className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                            value={row.modelId}
                            onChange={(e) =>
                              updateRow(i, { modelId: e.target.value })
                            }
                            placeholder="model-id"
                          />
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          {row.catalogId ? (
                            <div
                              className="flex items-center gap-1 px-1 py-0.5"
                              title={`Catalog: ${row.catalogId}`}
                            >
                              <span className="font-mono text-[11.5px] text-muted-foreground">
                                {row.context || "—"}
                              </span>
                              <Badge
                                variant="secondary"
                                className="text-[8px] px-1 py-0 uppercase tracking-wide text-success/80"
                              >
                                cat
                              </Badge>
                            </div>
                          ) : (
                            <input
                              className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.context}
                              onChange={(e) =>
                                updateRow(i, { context: e.target.value })
                              }
                              placeholder="200000"
                            />
                          )}
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          {row.priceLabel ? (
                            <span className="font-mono text-[10.5px] text-muted-foreground/70">
                              {row.priceLabel}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/30">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="py-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground/45 hover:text-destructive"
                            onClick={() =>
                              setRows((rs) => rs.filter((_, idx) => idx !== i))
                            }
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {rows.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-[11px] text-muted-foreground/50 py-6"
                        >
                          No models. Add a row to define one.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="px-3 py-2 border-t border-border bg-secondary/20 flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setRows((rs) => [
                      ...rs,
                      { alias: "", modelId: "", context: "" },
                    ])
                  }
                  className="text-[11px] h-7 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3" /> Add row
                </Button>
                <FetchModelsButton
                  apiStyle={apiStyle}
                  baseUrl={baseUrl}
                  // The key field starts empty (leave-blank-when-untouched
                  // behavior); fall back to the stored key so the button
                  // works without making the user re-type the key.
                  apiKey={apiKey.trim() || provider.apiKey || ""}
                  onFetched={(models) =>
                    setRows((prev) => appendFetchedModels(prev, models))
                  }
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Sub-components
// =============================================================

// =============================================================
// EndpointPreview — echoes the typed baseUrl verbatim. No
// trailing-slash strip, no /v1 auto-append, no path suffix:
// provider endpoints vary (z.ai's coding relay lives at
// /api/coding/paas/v4; some gateways want /v1, others don't),
// so transforming the input here would misrepresent non-standard
// gateways. The SDK appends its own path at runtime.
// =============================================================
export function EndpointPreview({
  apiStyle,
  baseUrl,
}: {
  apiStyle: ApiStyle;
  baseUrl: string;
}) {
  const full = baseUrl.trim();
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
  children,
}: {
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground/55">{icon}</span>
      <h3 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
        {children}
      </h3>
      {count != null && (
        <Badge variant="secondary" className="text-[9px] font-mono ml-auto">
          {count}
        </Badge>
      )}
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

/** A fetched model's match state.
 *  - 'live'     : rich provider response (OpenRouter) — used directly, no catalog
 *  - 'matched'  : confident single catalog hit (auto-enrich)
 *  - 'ambiguous': multiple catalog hits (pick one)
 *  - 'none'     : no catalog data (bare id) */
export type MatchState = "live" | "matched" | "ambiguous" | "none";

/** A single candidate shown for an ambiguous model (the catalog-resolve path
 *  is currently unused — provider data is preferred — but the type is kept so
/** A model fetched from the provider, optionally enriched by the catalog or
 *  sourced directly from a rich provider response. */
export interface FetchedModel {
  modelId: string;
  matchState: MatchState;
  /** Catalog canonical id (matched/selected) OR the provider's model id (live). */
  catalogId?: string;
  /** Context window from the catalog or the live provider response. */
  contextWindow?: number;
  /** "$in / $out per Mtok" price label. */
  priceLabel?: string;
  /** Raw per-token rates for cost calculation (USD). */
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadCostPerToken?: number;
  cacheWriteCostPerToken?: number;
  /** Whether the model supports reasoning. */
  reasoning?: boolean;
  /** True when the model always reasons and cannot be turned off (live only). */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels the model accepts, e.g. ['high','medium','low'] (live only). */
  supportedEfforts?: string[];
  /** Whether the model accepts image input (live only). */
  supportsVision?: boolean;
  /** Max output tokens (live only; catalog path derives this separately at runtime). */
  maxOutputTokens?: number;
}

/** Append fetched models to the rows, skipping any already present (matched by
 *  exact modelId). Catalog-matched/live rows carry their catalogId + a locked
 *  context window + reasoning metadata; unmatched rows keep blank context. */
export function appendFetchedModels(
  prev: Row[],
  incoming: FetchedModel[],
): Row[] {
  const existing = new Set(prev.map((r) => r.modelId.trim()).filter(Boolean));
  const fresh: Row[] = incoming
    .filter((m) => !existing.has(m.modelId.trim()))
    .map((m) => ({
      alias: m.modelId,
      modelId: m.modelId,
      context: m.catalogId && m.contextWindow ? String(m.contextWindow) : "",
      catalogId: m.catalogId,
      priceLabel: m.priceLabel,
      inputCostPerToken: m.inputCostPerToken,
      outputCostPerToken: m.outputCostPerToken,
      cacheReadCostPerToken: m.cacheReadCostPerToken,
      cacheWriteCostPerToken: m.cacheWriteCostPerToken,
      reasoning: m.reasoning,
      reasoningMandatory: m.reasoningMandatory,
      supportedEfforts: m.supportedEfforts,
    }));
  return [...prev, ...fresh];
}

// (The catalog resolve path — toFetchedModel + its inline interfaces — was
// removed when provider /models became the sole metadata source. Provider data
// is used directly via liveToFetchedModel; bare-id models are added as 'none'.)

/** True when a provider model entry carries rich metadata beyond a bare id.
 *  OpenRouter populates these; OpenAI/Anthropic direct + LM Studio do not. */
function isRichProviderModel(m: ProviderModelMeta): boolean {
  return !!(
    m.context_length ||
    m.pricing ||
    m.reasoning ||
    m.max_completion_tokens ||
    m.input_modalities
  );
}

/** Build a FetchedModel directly from a rich provider response — no catalog
 *  roundtrip. The provider's data is authoritative for its own models. */
function liveToFetchedModel(m: ProviderModelMeta): FetchedModel {
  const inTok = m.pricing?.prompt ? parseFloat(m.pricing.prompt) : undefined;
  const outTok = m.pricing?.completion
    ? parseFloat(m.pricing.completion)
    : undefined;
  const cacheRead = m.pricing?.input_cache_read
    ? parseFloat(m.pricing.input_cache_read)
    : undefined;
  const cacheWrite = m.pricing?.input_cache_write
    ? parseFloat(m.pricing.input_cache_write)
    : undefined;
  const priceLabel =
    inTok != null &&
    outTok != null &&
    !Number.isNaN(inTok) &&
    !Number.isNaN(outTok)
      ? formatPriceRate({ inputPerToken: inTok, outputPerToken: outTok })
      : undefined;
  // The reasoning flag comes ONLY from the OpenRouter `reasoning` object.
  // We deliberately do NOT fall back to `supported_parameters.includes('reasoning')`
  // because nearly every modern model accepts the reasoning *parameter*, but that
  // doesn't mean it's a reasoning model. The brain icon means "this model actually
  // reasons by default" (default_enabled) or "always reasons" (mandatory).
  const reasoningOn =
    m.reasoning?.default_enabled ?? m.reasoning?.mandatory ?? undefined;
  return {
    modelId: m.id,
    matchState: "live",
    // OpenRouter ids (e.g. "anthropic/claude-sonnet-4-5") ARE canonical slugs,
    // so they serve as the catalogId for runtime lookup too.
    catalogId: m.id,
    contextWindow: m.context_length,
    priceLabel,
    inputCostPerToken:
      inTok != null && !Number.isNaN(inTok) ? inTok : undefined,
    outputCostPerToken:
      outTok != null && !Number.isNaN(outTok) ? outTok : undefined,
    cacheReadCostPerToken:
      cacheRead != null && !Number.isNaN(cacheRead) ? cacheRead : undefined,
    cacheWriteCostPerToken:
      cacheWrite != null && !Number.isNaN(cacheWrite) ? cacheWrite : undefined,
    reasoning: reasoningOn,
    reasoningMandatory: m.reasoning?.mandatory,
    supportedEfforts: m.reasoning?.supported_efforts,
    supportsVision: m.input_modalities?.includes("image"),
    maxOutputTokens: m.max_completion_tokens,
  };
}

/** Fetch-models button — probes the provider's /models endpoint, then resolves
 *  each result against the LiteLLM catalog and opens a grouped dialog where the
 *  user selects models to add. Models are grouped by match state:
 *    ✅ MATCHED   — auto-resolved, one-click add
 *    ⚠ AMBIGUOUS  — multiple catalog candidates, user picks one
 *    — NONE       — no catalog data, add as-is
 *  Multi-select via checkboxes; [Add N selected] commits the selection.
 *
 *  The baseUrl/apiKey come from the form's current state, so this works in
 *  the add form before the provider is saved. Errors show inline next to
 *  the button (wrong key, 404, network) without a modal. */
export function FetchModelsButton({
  apiStyle,
  baseUrl,
  apiKey,
  onFetched,
  existingModelIds = [],
}: {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  /** Called with the user's selection when [Add N selected] is clicked. */
  onFetched: (models: FetchedModel[]) => void;
  /** Model ids already in the table — filtered out of the dialog. */
  existingModelIds?: string[];
}) {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "error";
    error?: string;
  }>({
    status: "idle",
  });
  // The fetched + catalog-enriched model list. Null = dialog closed.
  const [available, setAvailable] = useState<FetchedModel[] | null>(null);
  // Per-model selection state. For matched/none, keyed by modelId (bool).
  // For ambiguous, keyed by `${modelId}` → chosen catalogId (or undefined).
  const [selected, setSelected] = useState<Record<string, string | boolean>>(
    {},
  );

  const fetchModels = async () => {
    setState({ status: "loading" });
    const res = await api.probeProviderModels({ apiStyle, baseUrl, apiKey });
    if (!res.ok) {
      setState({ status: "error", error: res.error });
      return;
    }
    // Filter out models already in the table.
    const existing = new Set(existingModelIds.map((id) => id.trim()));
    const probed = res.models.filter((m) => !existing.has(m.id.trim()));
    // Rich provider responses (OpenRouter) → use live data directly.
    // Bare-id responses (OpenAI/Anthropic direct, LM Studio) → add as-is
    // (no catalog fallback; the user can edit context manually).
    const live = probed.filter(isRichProviderModel).map(liveToFetchedModel);
    const bare = probed
      .filter((m) => !isRichProviderModel(m))
      .map((m): FetchedModel => ({ modelId: m.id, matchState: "none" }));
    setAvailable([...live, ...bare]);
    setSelected({});
    setState({ status: "idle" });
  };

  const close = () => {
    setAvailable(null);
    setSelected({});
  };

  // Count of checked models (live + available).
  const selectedCount = available
    ? available.filter((m) => selected[m.modelId] === true).length
    : 0;

  const commit = () => {
    if (!available) return;
    const toAdd = available.filter((m) => selected[m.modelId] === true);
    if (toAdd.length > 0) onFetched(toAdd);
    close();
  };

  const disabled =
    state.status === "loading" || !baseUrl.trim() || !apiKey.trim();

  // Group: live (rich provider response) vs available (bare ids, no metadata).
  // The catalog matched/ambiguous/none distinction no longer exists — bare
  // providers (z.ai, OpenAI direct, LM Studio) all land in "available".
  const grouped = available
    ? {
        live: available.filter((m) => m.matchState === "live"),
        available: available.filter((m) => m.matchState !== "live"),
      }
    : null;

  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        {state.status === "error" && state.error && (
          <span
            className="text-[10px] text-destructive truncate max-w-[280px]"
            title={state.error}
          >
            {state.error}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={fetchModels}
          className="text-[11px] h-7 text-muted-foreground hover:text-foreground shrink-0"
          title={
            disabled && !baseUrl.trim()
              ? "Enter a base URL first"
              : disabled && !apiKey.trim()
                ? "Enter an API key first"
                : "Fetch the model list from the provider"
          }
        >
          <RefreshCw
            className={cn(
              "size-3",
              state.status === "loading" && "animate-spin",
            )}
          />
          {state.status === "loading" ? "Fetching…" : "Fetch models"}
        </Button>
      </div>

      <Dialog open={available !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent
          showCloseButton={false}
          className="max-w-lg p-0 gap-0 overflow-hidden"
        >
          <DialogHeader className="px-4 py-3 border-b border-border space-y-0">
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <Brain className="size-4 text-primary" /> Fetch models
              <Badge
                variant="secondary"
                className="ml-auto text-[9px] uppercase"
              >
                {apiStyle === "anthropic" ? "Anthropic" : "OpenAI"}
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-[11px] mt-0.5">
              Live data from the provider where available; auto-matched against
              the LiteLLM catalog otherwise.
            </DialogDescription>
          </DialogHeader>

          {state.status === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" /> Resolving models…
            </div>
          ) : !grouped ||
            grouped.live.length + grouped.available.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              All available models have been added.
            </div>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto scroll">
              {/* 🟢 LIVE (from provider — OpenRouter returns rich metadata) */}
              {grouped.live.length > 0 && (
                <FetchSection
                  icon="🟢"
                  tone="success"
                  label="From provider"
                  count={grouped.live.length}
                  hint="live data"
                >
                  {grouped.live.map((m) => (
                    <FetchRow
                      key={m.modelId}
                      checked={selected[m.modelId] === true}
                      onToggle={() =>
                        setSelected((s) => ({
                          ...s,
                          [m.modelId]: s[m.modelId] !== true,
                        }))
                      }
                      modelId={m.modelId}
                      reasoning={m.reasoning}
                      mandatory={m.reasoningMandatory}
                      meta={
                        m.contextWindow
                          ? `${formatContext(m.contextWindow)} ctx${m.priceLabel ? " · " + m.priceLabel : ""}`
                          : m.priceLabel
                      }
                    />
                  ))}
                </FetchSection>
              )}

              {/* — AVAILABLE (bare ids — z.ai, OpenAI direct, LM Studio; no metadata) */}
              {grouped.available.length > 0 && (
                <FetchSection
                  icon="—"
                  tone="muted"
                  label="Available models"
                  count={grouped.available.length}
                  hint="no metadata"
                >
                  {grouped.available.map((m) => (
                    <FetchRow
                      key={m.modelId}
                      checked={selected[m.modelId] === true}
                      onToggle={() =>
                        setSelected((s) => ({
                          ...s,
                          [m.modelId]: s[m.modelId] !== true,
                        }))
                      }
                      modelId={m.modelId}
                    />
                  ))}
                </FetchSection>
              )}
            </div>
          )}

          <DialogFooter className="px-4 py-2.5 border-t border-border bg-secondary/30 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground/60">
              {selectedCount > 0
                ? `${selectedCount} selected`
                : "Select models to add"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={selectedCount === 0}
                onClick={commit}
              >
                <Check className="size-3.5" /> Add{" "}
                {selectedCount > 0 ? `${selectedCount} selected` : ""}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A section header for the grouped dialog: icon + label + count + hint. */
function FetchSection({
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
function FetchRow({
  checked,
  onToggle,
  modelId,
  reasoning,
  mandatory,
  meta,
}: {
  checked: boolean;
  onToggle: () => void;
  modelId: string;
  reasoning?: boolean;
  /** True when reasoning is mandatory (always on) — shows a lock badge. */
  mandatory?: boolean;
  meta?: string;
}) {
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
          {reasoning && <Brain className="size-3 text-reasoning shrink-0" />}
          <code className="font-mono text-[11px] text-foreground/80 truncate">
            {modelId}
          </code>
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

/** Enable/disable toggle for edit mode — immediate (separate from the form's
 *  Save), matching the old card's behavior. Sits in the detail header. */
function EnableToggle({ provider }: { provider: Provider }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(provider.enabled);
  const toggle = async (checked: boolean) => {
    setOn(checked);
    await api.updateProvider(provider.id, { enabled: checked });
    qc.invalidateQueries({ queryKey: ["providers"] });
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground/55">
        {on ? "on" : "off"}
      </span>
      <Switch checked={on} onCheckedChange={toggle} />
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
    <div className="grid grid-cols-2 gap-3">
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-2.5 p-3 rounded-lg  text-left cursor-pointer transition-all duration-150 border border-b-4",
        active
          ? tone === "anthropic"
            ? "border-0 translate-y-1 bg-orange/30 hover:bg-orange-100/10"
            : "border-0 translate-y-1 bg-green/30 hover:bg-green-100/10"
          : tone === "anthropic"
            ? " hover:bg-orange-100/10"
            : " hover:bg-green-100/10",
      )}
    >
      <StyleAvatar tone={tone} />
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "text-[12.5px] font-semibold",
            active ? "text-primary" : "text-foreground",
          )}
        >
          {title}
        </div>
        <div className="text-[10px] text-muted-foreground/55 font-mono mt-0.5">
          {detail}
        </div>
      </div>
      {active && <Check className="size-3.5 text-primary shrink-0" />}
    </button>
  );
}

/** Brand-colored letter avatar — mirrors the ProviderAvatar used in the
 *  composer/selector so the protocol reads at a glance. */
function StyleAvatar({ tone }: { tone: "anthropic" | "openai" }) {
  if (tone === "anthropic") {
    return (
      <span
        className="size-7 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0"
        style={{ background: "linear-gradient(135deg,#d97757,#b8553f)" }}
      >
        A
      </span>
    );
  }
  return (
    <span
      className="size-7 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0"
      style={{ background: "#10a37f" }}
    >
      O
    </span>
  );
}

/** Delete (edit mode) — confirm dialog, then remove + keychain entry. */
function DeleteProviderAction({
  provider,
  onDone,
}: {
  provider: Provider;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const del = async () => {
    setBusy(true);
    try {
      await api.deleteProvider(provider.id);
      qc.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-[11px] h-7 text-muted-foreground/55 hover:text-destructive px-2"
        >
          <Trash2 className="size-3" /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {provider.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes its configuration and the matching OS keychain entry.
            Existing sessions keep their history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={del}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : "Delete forever"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
