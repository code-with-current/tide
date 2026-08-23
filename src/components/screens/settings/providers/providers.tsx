import {
  Plus,
  Trash2,
  ShieldCheck,
  Check,
  Server,
  Brain,
  PlugZap,
  Search,
  RefreshCw,
  BrainCircuit,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { SkeletonBar } from "@/components/ui/loading-rows";
import { Input } from "@/components/ui/input";
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
import { ProviderLogo } from "@/components/primitives/provider-logo";
import * as api from "@/lib/api/client";
import { useProviders } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiStyle, Provider } from "@/types";
import { cn, formatContext } from "@/lib/utils";
import { formatPriceRate } from "@/lib/queries";
import {
  fetchAndEnrichModels,
  toResolveFn,
  type FetchedModel,
} from "@/lib/fetch-models";
import { SettingsHeader } from "../shared";

// =============================================================
// ProvidersSection — LLM provider management, master/detail.
// Sidebar lists added providers (+ "New"); selecting one drives the main pane's inline edit form. Add and edit share the same ProviderDetail component — the sidebar IS the navigation between them.
// =============================================================

import {
  ModelsTable, appendFetchedModels, rowsToModels,
  useModelRows, type Row,
} from "./models-table";
import {
  EndpointPreview,
  FetchRow,
  FetchSection,
  FormField,
  PROTOCOL,
  SectionLabel,
} from "./provider-fields";
import { AddProviderWizard } from "./add-wizard/add-wizard";
import { matchPresetByBaseUrl, filterPresetModels } from "@/lib/provider-presets";

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
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-3.5" /> Add Provider
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
              className="w-full h-7 pl-7 pr-2 text-[0.8214rem] bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <Button
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-3.5" /> Add Provider
          </Button>
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[0.7143rem] uppercase tracking-wider text-muted-foreground/55 font-semibold">
              Providers
            </span>
            {filtered && filtered.length > 0 && (
              <Badge variant="secondary" className="font-mono text-[0.6429rem]">
                {filtered.length}
              </Badge>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scroll space-y-0.5">
            {isLoading && (
              <div className="space-y-0.5" aria-hidden>
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
                    <SkeletonBar className="size-5 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <SkeletonBar className="h-3 w-1/2" />
                      <SkeletonBar className="h-2 w-1/3" />
                    </div>
                    <SkeletonBar className="size-3 shrink-0 rounded-[3px]" />
                  </div>
                ))}
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
        <AddProviderWizard
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
// ProviderListItem — one row in the sidebar. Active row uses primary tint + left accent bar (the "you are here" cue). Keyboard-selectable.
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
  const preset = matchPresetByBaseUrl(provider.baseUrl);
  const tint = preset?.accent ?? (provider.apiStyle === "anthropic" ? "#d97757" : "#10a37f");
  const modelCount = provider.models.length;
  // Short host for the subtitle — strips scheme + path for a compact read.
  const host = provider.baseUrl
    ? provider.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    : "";

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
      {/* Brand avatar — real logo mark on the brand-tinted tile. */}
      <span
        className="size-5 rounded-md flex items-center justify-center shrink-0"
        style={tint === "#ffffff" ? undefined : { background: tint }}
      >
        <ProviderLogo
          apiStyle={provider.apiStyle}
          presetId={preset?.id}
          className={cn("size-3", tint === "#ffffff" ? "text-foreground" : "text-white")}
        />
      </span>

      {/* Name + subtitle (host) — two-line read like the Workspace rows. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[0.8214rem] font-medium truncate">
            {provider.name}
          </span>
        </div>
        {host && (
          <span className="block text-[0.6786rem] text-muted-foreground/45 font-mono truncate -mt-0.5">
            {host}
          </span>
        )}
      </div>

      {/* Model count — compact mono pill, only when > 0. */}
      {modelCount > 0 && (
        <Badge
          variant="secondary"
          className="font-mono text-[0.6429rem] px-1 py-0 shrink-0"
          title={`${modelCount} model${modelCount === 1 ? "" : "s"}`}
        >
          {modelCount}
        </Badge>
      )}

      {/* Status — a brand-tinted dot when enabled, "off" label when not. */}
      {provider.enabled ? (
        <span
          className="size-1.5 rounded-full shrink-0"
          style={
            tint === "#ffffff"
              ? { background: "#34d399", boxShadow: "0 0 6px #34d39980" }
              : { background: tint, boxShadow: `0 0 6px ${tint}80` }
          }
          title="Enabled"
        />
      ) : (
        <span className="text-[0.6429rem] text-muted-foreground/45 shrink-0" title="Disabled">
          off
        </span>
      )}
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
// ProviderDetail — the inline edit form (auto-save). Selecting a provider in the sidebar renders this; edits persist ~600ms after the last change. Add is handled by the AddProviderWizard.
// =============================================================

function ProviderDetail({
  provider,
  onDeleted,
}: {
  provider: Provider;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(provider.name);
  // apiStyle is fixed at edit time — set when the provider was created (via
  // the wizard); changing it here would silently break the endpoint mapping.
  const apiStyle: ApiStyle = provider.apiStyle;
  const detailPreset = matchPresetByBaseUrl(provider.baseUrl);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  // Key field starts EMPTY on edit — the decrypted key is never pre-filled into the DOM. Save omits apiKey from the patch when the field is blank, so an untouched form preserves whatever's in the keychain. Type a new value to replace; there's no explicit "clear key" affordance (delete the provider to clear the key).
  const [apiKey, setApiKey] = useState("");
  const [limits, setLimits] = useState(provider.limits);
  const hasStoredKey = !!provider.apiKey;
  const { rows, setRows, updateRow, addRow, removeRow } = useModelRows(
    provider.models.map((m) => ({
      alias: m.alias,
      modelId: m.modelId,
      context: String(m.contextWindow),
      catalogId: m.catalogId,
      reasoning: m.reasoning,
      reasoningMandatory: m.reasoningMandatory,
      supportedEfforts: m.supportedEfforts,
      vision: m.vision,
      priceLabel: m.priceLabel,
      inputCostPerToken: m.inputCostPerToken,
      outputCostPerToken: m.outputCostPerToken,
      cacheReadCostPerToken: m.cacheReadCostPerToken,
      cacheWriteCostPerToken: m.cacheWriteCostPerToken,
      id: m.id,
      providerId: m.providerId,
    })),
  );

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
      // Save exactly what the user typed — no trailing-slash strip, no /v1 auto-append (see the add form for rationale).
      const baseUrlToSave = baseUrl.trim();
      // Build the patch WITHOUT apiKey, then add it only if the user typed one. Omitting the field entirely (vs sending undefined) is the robust way to say "don't touch the keychain entry" — structured clone over IPC preserves undefined, but being explicit avoids any ambiguity at the store layer.
      const patch: Parameters<typeof api.updateProvider>[1] = {
        name: name.trim() || "Untitled",
        apiStyle,
        baseUrl: baseUrlToSave,
        limits,
        models: rowsToModels(rows, provider.id),
      };
      const newKey = apiKey.trim();
      if (newKey) patch.apiKey = newKey;
      void api
        .updateProvider(provider.id, patch)
        .then(() => qc.invalidateQueries({ queryKey: ["providers"] }))
        .catch((e) =>
          // Autosave is silent on success (fields visibly updating is the
          // confirmation), but surface failures so a broken save isn't invisible.
          toast.error("Provider save failed", {
            description: e instanceof Error ? e.message : undefined,
          }),
        );
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, baseUrl, apiKey, limits, rows]);

  useCatalogEnrichment(rows, updateRow);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <span
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={
            detailPreset && detailPreset.accent !== "#ffffff"
              ? { background: detailPreset.accent }
              : undefined
          }
        >
          <ProviderLogo
            apiStyle={provider.apiStyle}
            presetId={detailPreset?.id}
            className={cn(
              "size-4",
              detailPreset && detailPreset.accent !== "#ffffff" ? "text-white" : "text-primary",
            )}
          />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{provider.name}</div>
          <div className="text-[0.7857rem] text-muted-foreground/55">
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
        <div className="w-[70%] mx-auto px-6 py-5 space-y-6">
          <EndpointPreview apiStyle={apiStyle} baseUrl={baseUrl} />

          {/* Connection */}
          <section className="space-y-3.5">
            <SectionLabel icon={<Server className="size-3" />}>
              Connection
            </SectionLabel>
            <FormField id="usage-limits" label="Usage limits (informational)">
              <div className="grid grid-cols-2 gap-2">
                <div className="relative">
                  <input
                    type="number"
                    min={0}
                    value={limits?.fiveHourTokens ?? ""}
                    onChange={(e) =>
                      setLimits((l) => ({ ...l, fiveHourTokens: Number(e.target.value) || undefined }))
                    }
                    placeholder="—"
                    className="w-full h-8 pr-9 text-[12px] font-mono bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50">5h</span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    min={0}
                    value={limits?.weeklyTokens ?? ""}
                    onChange={(e) =>
                      setLimits((l) => ({ ...l, weeklyTokens: Number(e.target.value) || undefined }))
                    }
                    placeholder="—"
                    className="w-full h-8 pr-9 text-[12px] font-mono bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50">7d</span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground/50 mt-1">
                Token budgets for the top-bar meter. Never blocks — informational only.
              </p>
            </FormField>
            <FormField id="name" label="Provider name">
              <Input
                className="h-8 text-[0.8929rem]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="OpenRouter, z.ai, LM Studio…"
              />
            </FormField>

            <FormField id="baseUrl" label="Base URL">
              <Input
                className="font-mono text-[0.8571rem] h-8"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={PROTOCOL[apiStyle].baseUrlPlaceholder}
              />
              <p className="text-[0.7143rem] text-muted-foreground/50 mt-1">
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
                className="font-mono text-[0.8571rem] h-8"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  hasStoredKey
                    ? "•••••••• (saved) — type a new key to replace"
                    : PROTOCOL[apiStyle].keyPlaceholder
                }
              />
              <div className="flex items-center justify-between mt-1 gap-2">
                <p className="text-[0.7143rem] text-muted-foreground/50 flex items-center gap-1">
                  <ShieldCheck className="size-2.5 text-success" />
                  Sent as{" "}
                  <span className="font-mono">
                    {PROTOCOL[apiStyle].authHeader}
                  </span>
                  . Stored in the OS keychain.
                </p>
                {hasStoredKey ? (
                  <span className="text-[0.7143rem] text-success flex items-center gap-0.5 shrink-0">
                    <Check className="size-2.5" /> Key on file
                  </span>
                ) : (
                  <span className="text-[0.7143rem] text-muted-foreground/45 shrink-0">
                    No key set
                  </span>
                )}
              </div>
            </FormField>
          </section>

          {/* Models */}
          <section className="space-y-3">
            <SectionLabel
              icon={<BrainCircuit className="size-3" />}
              count={rowsToModels(rows, provider.id).length}
              action={
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
              }
            >
              Models
            </SectionLabel>
            <ModelsTable
              rows={rows}
              onUpdate={updateRow}
              onAdd={addRow}
              onRemove={removeRow}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Sub-components
// =============================================================

/**
 * Debounced catalog enrichment for model rows. Watches for rows with a
 * modelId but no catalogId, resolves each against the models.dev catalog via
 * IPC, and fills in context / reasoning / price when a match is found. Skips
 * rows that already have a catalogId (enriched) or whose modelId has already
 * been tried (avoids redundant IPC calls + infinite update loops).
 */
export function useCatalogEnrichment(
  rows: Row[],
  updateRow: (i: number, patch: Partial<Row>) => void,
) {
  const triedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = rows
      .map((r, i) => ({ i, id: r.modelId.trim(), row: r }))
      .filter(({ id, row }) => id.length > 0 && !row.catalogId && !triedRef.current.has(id));

    if (pending.length === 0) return;

    const timer = setTimeout(() => {
      for (const { i, id, row } of pending) {
        triedRef.current.add(id);
        void api
          .resolveModelCatalog({ modelId: id, contextWindow: parseInt(row.context, 10) || 0 })
          .then((res) => {
            if (!res?.meta?.resolvedCatalogId) return;
            updateRow(i, {
              catalogId: res.meta.resolvedCatalogId,
              context: row.context || String(res.meta.contextWindow),
              reasoning: res.meta.supportsReasoning || row.reasoning,
              priceLabel: row.priceLabel ?? (res.meta.pricing ? formatPriceRate(res.meta.pricing) : undefined),
              inputCostPerToken: row.inputCostPerToken ?? res.meta.pricing?.inputPerToken,
              outputCostPerToken: row.outputCostPerToken ?? res.meta.pricing?.outputPerToken,
            });
          });
      }
    }, 500);

    return () => clearTimeout(timer);
    // Key on row modelIds so the timer resets while typing, but triedRef
    // prevents re-resolution of already-attempted IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}

/** Fetch-models button — probes the provider's /models endpoint, resolves each result against the models.dev catalog, and opens a grouped dialog (✅ MATCHED / ⚠ AMBIGUOUS / — NONE) where the user multi-selects models to add. baseUrl/apiKey come from the form's current state so it works in the add form before the provider is saved. Errors show inline next to the button (no modal). */
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
  // Models the provider reports but this apiStyle cannot call — shown dimmed.
  const [excluded, setExcluded] = useState<FetchedModel[]>([]);
  // Per-model selection state. For matched/none, keyed by modelId (bool).
  // For ambiguous, keyed by `${modelId}` → chosen catalogId (or undefined).
  const [selected, setSelected] = useState<Record<string, string | boolean>>(
    {},
  );

  const fetchModels = async () => {
    setState({ status: "loading" });
    try {
      const fetched = await fetchAndEnrichModels(
        api.probeProviderModels,
        toResolveFn(api.resolveModelCatalog),
        { apiStyle, baseUrl, apiKey, existingIds: existingModelIds },
      );
      // Route-aware providers (OpenCode Zen) serve different models per wire
      // endpoint — selectable rows are what this apiStyle can call; the rest
      // render dimmed so the full provider catalog stays visible.
      const preset = matchPresetByBaseUrl(baseUrl);
      const selectable = filterPresetModels(fetched, preset, apiStyle);
      const selectableIds = new Set(selectable.map((m) => m.modelId));
      setAvailable(selectable);
      setExcluded(fetched.filter((m) => !selectableIds.has(m.modelId)));
      setSelected({});
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "Fetch failed" });
      return;
    }
    setState({ status: "idle" });
  };

  const close = () => {
    setAvailable(null);
    setExcluded([]);
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
            className="text-[0.7143rem] text-destructive truncate max-w-[280px]"
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
          className="text-[0.7857rem] h-7 text-muted-foreground hover:text-foreground shrink-0"
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
                className="ml-auto text-[0.6429rem] uppercase"
              >
                {apiStyle === "anthropic" ? "Anthropic" : "OpenAI"}
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-[0.7857rem] mt-0.5">
              Live data from the provider where available; auto-matched against
              the models.dev catalog otherwise.
            </DialogDescription>
          </DialogHeader>

          {state.status === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" /> Resolving models…
            </div>
          ) : !grouped ||
            grouped.live.length + grouped.available.length + excluded.length === 0 ? (
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
                      vision={m.supportsVision}
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
                  hint={grouped.available.some((m) => m.catalogId) ? "catalog-enriched" : "no metadata"}
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
                      reasoning={m.reasoning}
                      vision={m.supportsVision}
                      meta={
                        m.contextWindow
                          ? `${formatContext(m.contextWindow)} ctx${m.priceLabel ? " · " + m.priceLabel : ""}`
                          : m.priceLabel
                      }
                    />
                  ))}
                </FetchSection>
              )}

              {/* ⊘ OTHER ENDPOINT — provider reports them, but this apiStyle
                  can't call them (Zen's per-model routing). Visible, dimmed,
                  not selectable. */}
              {excluded.length > 0 && (
                <FetchSection
                  icon="⊘"
                  tone="muted"
                  label="Other endpoint"
                  count={excluded.length}
                  hint="switch API style to use"
                >
                  {excluded.map((m) => (
                    <FetchRow
                      key={m.modelId}
                      checked={false}
                      onToggle={() => {}}
                      modelId={m.modelId}
                      reasoning={m.reasoning}
                      vision={m.supportsVision}
                      disabled
                      disabledNote={apiStyle === "anthropic" ? "OpenAI style" : "Anthropic style"}
                    />
                  ))}
                </FetchSection>
              )}
            </div>
          )}

          <DialogFooter className="px-4 py-2.5 border-t border-border bg-secondary/30 flex items-center justify-between gap-2">
            <span className="text-[0.7857rem] text-muted-foreground/60">
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

/** Enable/disable toggle for edit mode — immediate (separate from the form's
 *  Save), matching the old card's behavior. Sits in the detail header. */
function EnableToggle({ provider }: { provider: Provider }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(provider.enabled);
  const [busy, setBusy] = useState(false);
  const toggle = async (checked: boolean) => {
    setOn(checked); // optimistic
    setBusy(true);
    try {
      await api.updateProvider(provider.id, { enabled: checked });
      qc.invalidateQueries({ queryKey: ["providers"] });
    } catch (e) {
      // Revert on failure — the IPC didn't land, so don't leave the toggle
      // lying in the "on" position. Toast so the user knows why it flipped back.
      setOn(!checked);
      toast.error("Couldn't update provider", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[0.7143rem] text-muted-foreground/55">
        {on ? "on" : "off"}
      </span>
      <Switch checked={on} disabled={busy} onCheckedChange={toggle} />
    </div>
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
      toast.success("Provider deleted");
      onDone();
    } catch (e) {
      toast.error("Delete failed", {
        description: e instanceof Error ? e.message : undefined,
      });
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
          className="text-[0.7857rem] h-7 text-muted-foreground/55 hover:text-destructive px-2"
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
