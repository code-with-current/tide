import { Brain, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useModelOption, supportsThinking } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import type { ReasoningOption, ThinkingLevel } from '@/types';

interface LevelOption {
  value: Exclude<ThinkingLevel, 'off'>;
  label: string;
  hint: string;
}

/** Canonical tiers — the fallback option list when the model publishes no
 *  effort values (budget-token, toggle, or unenriched models). */
const LEVELS: LevelOption[] = [
  { value: 'minimal', label: 'Minimal', hint: 'Barely-any reasoning · fastest tier that reasons' },
  { value: 'low',     label: 'Low',     hint: 'Brief reasoning · fast, fewest tokens' },
  { value: 'medium',  label: 'Medium',  hint: 'Balanced — recommended default' },
  { value: 'high',    label: 'High',    hint: 'Deeper reasoning · slower, more tokens' },
  { value: 'extra',   label: 'Extra',   hint: 'Extended thinking · large token budget' },
  { value: 'max',     label: 'Max',     hint: 'Maximum reasoning · slowest, highest cost' },
];

const RANK: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 1, low: 2, medium: 3, high: 4, extra: 5, max: 6,
};

/** Provider effort vocabulary (models.dev `reasoning_options` values) in
 *  intensity order, each mapped to the ThinkingLevel it round-trips through.
 *  'none' is omitted — the header switch owns on/off. */
const EFFORT_TIERS: { effort: string; option: LevelOption }[] = [
  { effort: 'minimal', option: LEVELS[0] },
  { effort: 'low',     option: LEVELS[1] },
  { effort: 'medium',  option: LEVELS[2] },
  { effort: 'high',    option: LEVELS[3] },
  { effort: 'xhigh',   option: LEVELS[4] },
  { effort: 'max',     option: LEVELS[5] },
];

/** Derive supported effort strings from either the provider response
 *  (supportedEfforts) or the catalog reasoning contracts (reasoningContracts).
 *  Returns undefined when neither source has data. */
function effortsForModel(model: { supportedEfforts?: string[]; reasoningContracts?: ReasoningOption[] }): string[] | undefined {
  if (model.supportedEfforts && model.supportedEfforts.length > 0) return model.supportedEfforts;
  const effortContract = model.reasoningContracts?.find((c) => c.type === 'effort');
  return effortContract?.values;
}

/** True when the model's only reasoning contract is a toggle — thinking is
 *  on/off with no level distinction (mirrors resolveReasoning's toggleOnly). */
function isToggleOnly(model: { reasoningContracts?: ReasoningOption[] } | undefined): boolean {
  const contracts = model?.reasoningContracts;
  if (!contracts || contracts.length === 0) return false;
  return contracts.some((c) => c.type === 'toggle')
    && !contracts.some((c) => c.type === 'effort')
    && !contracts.some((c) => c.type === 'budget_tokens');
}

/** Build the dropdown options from the model's published effort values,
 *  falling back to the canonical tiers when none are published. On/off is
 *  owned by the header switch, so only level tiers are listed. */
function buildOptions(efforts: string[] | undefined): LevelOption[] {
  if (efforts && efforts.length > 0) {
    const published = new Set(efforts.map((e) => e.toLowerCase()));
    const options: LevelOption[] = [];
    for (const tier of EFFORT_TIERS) {
      if (!published.has(tier.effort)) continue;
      if (options.some((o) => o.value === tier.option.value)) continue;
      options.push(tier.option);
    }
    if (options.length > 0) return options;
  }
  return LEVELS;
}

/** The option the UI marks active for a stored level: exact match, else the
 *  next stronger offered option, else the strongest. */
function snapToOptions(level: ThinkingLevel, options: LevelOption[]): LevelOption {
  const exact = options.find((o) => o.value === level);
  if (exact) return exact;
  const target = level === 'off' ? RANK.medium : RANK[level];
  return options.find((o) => RANK[o.value] >= target) ?? options[options.length - 1] ?? LEVELS[2];
}

export function ThinkingLevelSelector({ compact = false }: { compact?: boolean }) {
  const level = useUi((s) => s.thinkingLevel);
  const setLevel = useUi((s) => s.setThinkingLevel);
  const selectedModelId = useUi((s) => s.selectedModelId);
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const model = useModelOption(selectedProviderId, selectedModelId);
  const supported = model ? (model.reasoning ?? supportsThinking(model.modelId, model)) : false;
  const mandatory = model?.reasoningMandatory;
  const toggleOnly = isToggleOnly(model);
  const isOn = level !== 'off';

  const options = toggleOnly ? [] : buildOptions(effortsForModel(model ?? {}));
  const current = snapToOptions(level, options);
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
            ? (mandatory ? 'Reasoning always on (model mandatory)' : toggleOnly ? 'Thinking on/off' : 'Thinking level')
            : `${model?.alias ?? 'This model'} does not support reasoning`}
        >
          <Brain className={cn('size-4', isOn ? 'text-reasoning' : 'text-muted-foreground/50')} />
          {!compact && <span>{!isOn ? 'Off' : toggleOnly ? 'On' : current.label}</span>}
          <ChevronDown className="size-4 text-input-foreground/60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56 p-0 overflow-hidden">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5 px-3 py-2">
          <Brain className={cn('size-3', isOn ? 'text-reasoning' : 'text-muted-foreground/50')} /> Thinking
          <Switch
            size="sm"
            className="ml-auto"
            checked={isOn}
            disabled={!!mandatory}
            onCheckedChange={(v) => setLevel(v ? (toggleOnly ? 'medium' : current.value) : 'off')}
            title={mandatory ? 'Reasoning always on (model mandatory)' : isOn ? 'Turn thinking off' : 'Turn thinking on'}
          />
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {options.length > 0 && (
          <div className={cn('px-2 py-1.5 flex flex-col gap-0.5', !isOn && 'pointer-events-none opacity-50')}>
            {options.map((o) => (
              <DropdownMenuItem
                key={o.value}
                onSelect={() => setLevel(o.value)}
                className={cn(
                  'justify-between rounded-md px-2.5 py-1.5 text-[0.85rem]',
                  isOn && o.value === current.value
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground',
                )}
                title={o.hint}
              >
                {o.label}
                {isOn && o.value === current.value && <Check className="size-3.5 text-reasoning" />}
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
