import { Brain, ChevronDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { useModelOption, supportsThinking } from '@/lib/queries';
import { useUi, type ThinkingLevel } from '@/lib/stores/ui';

const LEVELS: { value: ThinkingLevel; label: string; hint: string }[] = [
  { value: 'off',    label: 'Off',    hint: 'No reasoning budget — fastest, cheapest' },
  { value: 'low',    label: 'Low',    hint: 'Brief reasoning · fast, fewest tokens' },
  { value: 'medium', label: 'Medium', hint: 'Balanced — recommended default' },
  { value: 'high',   label: 'High',   hint: 'Deeper reasoning · slower, more tokens' },
  { value: 'extra',  label: 'Extra',  hint: 'Extended thinking · large token budget' },
  { value: 'max',    label: 'Max',    hint: 'Maximum reasoning · slowest, highest cost' },
];

/** Map a provider effort name (e.g. 'low','high') to our ThinkingLevel.
 *  'extra'/'max' have no provider equivalent → map to the highest offered. */
const effortToLevel = (e: string): ThinkingLevel | undefined => {
  const lower = e.toLowerCase();
  if (lower === 'low') return 'low';
  if (lower === 'medium') return 'medium';
  if (lower === 'high') return 'high';
  // Providers may offer 'max'/'xhigh' → collapse to our extra/max tiers.
  if (lower === 'max' || lower === 'xhigh') return 'max';
  return undefined;
};

/** Derive supported effort strings from either the provider response
 *  (supportedEfforts) or the catalog reasoning contracts (reasoningContracts).
 *  Returns undefined when neither source has data. */
function effortsForModel(model: { supportedEfforts?: string[]; reasoningContracts?: import('@/types').ReasoningOption[] }): string[] | undefined {
  if (model.supportedEfforts && model.supportedEfforts.length > 0) return model.supportedEfforts;
  const effortContract = model.reasoningContracts?.find((c) => c.type === 'effort');
  return effortContract?.values;
}

/** Compute the visible levels for a model, honoring mandatory + supportedEfforts. */
function visibleLevels(
  mandatory: boolean | undefined,
  efforts: string[] | undefined,
): { value: ThinkingLevel; label: string; hint: string }[] {
  let levels = [...LEVELS];
  if (mandatory) levels = levels.filter((l) => l.value !== 'off');
  if (efforts && efforts.length > 0) {
    // Keep 'off' only if reasoning isn't mandatory, then map provider efforts.
    const allowed = new Set(efforts.map(effortToLevel).filter((v): v is ThinkingLevel => !!v));
    levels = levels.filter((l) => l.value === 'off' ? !mandatory : allowed.has(l.value));
    // Always include at least the highest offered level if filtering dropped everything.
    if (levels.filter((l) => l.value !== 'off').length === 0) {
      const highest = [...allowed].sort().pop();
      if (highest) levels = LEVELS.filter((l) => l.value === highest || (l.value === 'off' && !mandatory));
    }
  }
  return levels.length > 0 ? levels : LEVELS;
}

export function ThinkingLevelSelector({ compact = false }: { compact?: boolean }) {
  const level = useUi((s) => s.thinkingLevel);
  const setLevel = useUi((s) => s.setThinkingLevel);
  const selectedModelId = useUi((s) => s.selectedModelId);
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const model = useModelOption(selectedProviderId, selectedModelId);
  const supported = model ? (model.reasoning ?? supportsThinking(model.modelId, model)) : false;
  const mandatory = model?.reasoningMandatory;
  const efforts = effortsForModel(model ?? {});

  const levels = visibleLevels(mandatory, efforts);
  const levelToIndex = (l: ThinkingLevel): number => levels.findIndex((x) => x.value === l);
  const indexToLevel = (i: number): ThinkingLevel => levels[i]?.value ?? levels[Math.min(1, levels.length - 1)]?.value ?? 'medium';

  // If the current level is no longer valid (e.g. 'off' for a mandatory model),
  // clamp to the lowest visible non-off level.
  const currentIndex = Math.max(0, levelToIndex(level));
  const current = levels[currentIndex];
  // A mandatory-reasoning model IS supported — it always reasons.
  const effectivelySupported = supported || !!mandatory;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 gap-1.5 text-[0.85rem] px-2 text-input-foreground hover:text-foreground',
            compact && 'px-1.5',
            !effectivelySupported && 'opacity-40',
          )}
          disabled={!effectivelySupported}
          title={effectivelySupported
            ? (mandatory ? 'Reasoning always on (model mandatory)' : 'Thinking level')
            : `${model?.alias ?? 'This model'} does not support reasoning`}
        >
          <Brain className="size-4 text-reasoning" />
          {!compact && <span>{mandatory ? 'Always' : (current?.label ?? 'Thinking')}</span>}
          <ChevronDown className="size-4 text-input-foreground/60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top"  className="w-[300px] p-0 overflow-hidden">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5 px-3 py-2">
          <Brain className="size-3 text-reasoning" /> Thinking level
          {mandatory && (
            <span className="ml-auto text-[9px] text-reasoning/70 normal-case">always on</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <div className="px-3 py-2.5">
          <div className="text-base font-semibold text-reasoning">{current?.label}</div>
          <div className="text-[11px] text-muted-foreground/60 mt-0.5">
            {current?.hint}
            {mandatory && ' · this model always reasons'}
          </div>
        </div>

        <div className="px-3 py-2">
          <Slider
            value={[currentIndex]}
            min={0}
            max={levels.length - 1}
            step={1}
            onValueChange={(v) => setLevel(indexToLevel(v[0]))}
            aria-label="Thinking level"
          />
          <div className="flex justify-between mt-2 px-0.5">
            {levels.map((l, i) => (
              <span
                role="button"
                key={l.value}
                onClick={() => setLevel(l.value)}
                className={cn(
                  'text-[10px] font-medium transition-colors leading-none pt-1 flex-1 first:text-left last:text-right text-center',
                  i === currentIndex ? 'text-reasoning' : 'text-muted-foreground/60 hover:text-primary-foreground',
                )}
                title={l.hint}
              >
                {l.label}
              </span>
            ))}
          </div>
        </div>

        <DropdownMenuSeparator />

        <div className="px-3 py-2 text-[10px] text-muted-foreground/60 flex items-start gap-1.5">
          <Sparkles className="size-3 text-reasoning flex-shrink-0 mt-px" />
          <span>Higher levels allocate more reasoning tokens. Cost scales accordingly.</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
