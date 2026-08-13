/** Protocol dispatcher: single entry point returning per-protocol
 *  `{providerOptions, maxOutputTokens, label}` from apiStyle + reasoning
 *  instruction. The orchestrator never branches on protocol; adding one =
 *  add a builder file + one case. */
import type { ApiStyle } from '../../../src/types';
import { anthropicCallOptions } from './anthropic';
import { openaiCallOptions } from './openai';
import type { ProtocolCallOptions, ProtocolContext } from './types';
import type { ReasoningInstruction } from './reasoning';

export type { ProtocolCallOptions, ProtocolContext } from './types';
export type { ReasoningInstruction } from './reasoning';
export { resolveReasoning, budgetToEffort } from './reasoning';

export function resolveProtocolOptions(
  apiStyle: ApiStyle,
  reasoning: ReasoningInstruction | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  switch (apiStyle) {
    case 'openai':
      return openaiCallOptions(reasoning, ctx);
    case 'anthropic':
      return anthropicCallOptions(reasoning, ctx);
    default:
      // ApiStyle is currently 'openai' | 'anthropic'; a new value landing here
      // means a protocol builder hasn't been written yet. Degrade to a plain
      // no-thinking call rather than crash, and flag it in the label.
      return {
        providerOptions: undefined,
        maxOutputTokens: ctx?.maxOutputTokens ?? 8192,
        label: `unknown-protocol:${apiStyle}`,
      };
  }
}
