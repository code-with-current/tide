import { useEffect, useRef, useState } from 'react';
import { Brain, Eye, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatContext } from '@/lib/utils';
import type { ApiStyle, Model } from '@/types';

export interface Row {
  alias: string;
  modelId: string;
  context: string;
  /** LiteLLM/models.dev catalog canonical id, set when the row came from the Fetch Models
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
  /** Whether the model accepts image input (sourced from a live provider
   *  response). Persisted onto Model so image attachments can be inlined. */
  vision?: boolean;
  /** Present when the row maps to an existing model (edit mode) — preserves
   *  identity so updateProvider doesn't drop/recreate models on every save. */
  id?: string;
  providerId?: string;
}

/** Editing a matched model-id severs the catalog link — stale metadata
 *  (context, price, reasoning) belongs to the old id, so it all goes. */
export function modelIdChangePatch(row: Row, value: string): Partial<Row> {
  if (!row.catalogId) return { modelId: value };
  return {
    modelId: value,
    catalogId: undefined,
    context: "",
    reasoning: undefined,
    priceLabel: undefined,
    inputCostPerToken: undefined,
    outputCostPerToken: undefined,
  };
}

/** Convert editable table rows into persisted Model records. Rows that map to
 *  existing models keep their identity (id/providerId); new rows get a fresh id
 *  and the given providerId ("" while the provider itself is still being created). */
export function rowsToModels(rows: Row[], providerId = ""): Model[] {
  return rows
    .filter((r) => r.modelId.trim() || r.alias.trim())
    .map((r) => ({
      id: r.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
      alias: r.alias.trim() || r.modelId.trim(),
      modelId: r.modelId.trim(),
      contextWindow: parseInt(r.context, 10) || 200_000,
      providerId: r.providerId ?? providerId,
      catalogId: r.catalogId,
      reasoning: r.reasoning,
      reasoningMandatory: r.reasoningMandatory,
      supportedEfforts: r.supportedEfforts,
      vision: r.vision,
      priceLabel: r.priceLabel,
      inputCostPerToken: r.inputCostPerToken,
      outputCostPerToken: r.outputCostPerToken,
      cacheReadCostPerToken: r.cacheReadCostPerToken,
      cacheWriteCostPerToken: r.cacheWriteCostPerToken,
    }));
}

/** Row state + mutators shared by every form that edits a provider's models. */
export function useModelRows(initial: Row[]) {
  const [rows, setRows] = useState<Row[]>(initial);
  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });
  const addRow = () =>
    setRows((rs) => [...rs, { alias: "", modelId: "", context: "" }]);
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  return { rows, setRows, updateRow, addRow, removeRow };
}

/** When the API style changes, follow it with the protocol's canonical
 *  endpoint — but ONLY if the URL is empty or still one of the defaults.
 *  A custom URL (z.ai proxy, OpenRouter, LM Studio, etc.) is preserved so
 *  toggling protocol never clobbers the user's input. Skips the mount. */
export function useFollowProtocolEndpoint(
  apiStyle: ApiStyle,
  setBaseUrl: (updater: (cur: string) => string) => void,
) {
  const prevStyle = useRef(apiStyle);
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
  }, [apiStyle, setBaseUrl]);
}

/** The models editor: alias / id / context / price table with per-row capability
 *  icons, catalog badges, and a footer hosting the add-row button. */
export function ModelsTable({
  rows,
  onUpdate,
  onAdd,
  onRemove,
}: {
  rows: Row[];
  onUpdate: (i: number, patch: Partial<Row>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  return (
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
                    <input
                      className="w-full bg-transparent border-0 outline-none text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                      value={row.alias}
                      onChange={(e) => onUpdate(i, { alias: e.target.value })}
                      placeholder="Alias"
                    />
                    {row.reasoning && (
                      <Brain className="size-3 text-reasoning shrink-0" />
                    )}
                    {row.vision && (
                      <Eye className="size-3 text-info shrink-0" />
                    )}
                  </div>
                </TableCell>
                <TableCell className="py-1 pr-1">
                  <input
                    className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                    value={row.modelId}
                    onChange={(e) => onUpdate(i, modelIdChangePatch(row, e.target.value))}
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
                        {row.context ? formatContext(parseInt(row.context, 10)) : "—"}
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
                      onChange={(e) => onUpdate(i, { context: e.target.value })}
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
                    onClick={() => onRemove(i)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-[11px] text-muted-foreground/50 py-6"
                >
                  No models. Add a row to define one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="px-3 py-2 border-t border-border bg-secondary/20">
        <Button
          variant="ghost"
          size="sm"
          onClick={onAdd}
          className="text-[11px] h-7 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" /> Add row
        </Button>
      </div>
    </div>
  );
}
