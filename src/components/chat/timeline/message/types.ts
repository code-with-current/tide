/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/types.ts.
 *  Pure types — ported verbatim. `ContentChangeReason` is defined locally here
 *  (upstream imports it from its useChatAutoFollow hook, which is not staged
 *  and whose full union is unknown); MessageBody only ever emits 'structural',
 *  and Task 6 can narrow this when it wires Tide's auto-follow hook. */

export type StreamPhase = 'streaming' | 'cooldown' | 'completed';

export type DiffViewMode = 'side-by-side' | 'unified';

/** Locally defined — see header. Accepts 'structural' plus any later reason. */
export type ContentChangeReason = 'structural' | (string & Record<never, never>);

export interface AgentMentionInfo {
  name: string;
  token: string;
}

export interface ToolPopupContent {
  open: boolean;
  title: string;
  content: string;
  language?: string;
  isDiff?: boolean;
  diffHunks?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  image?: {
    url: string;
    mimeType?: string;
    filename?: string;
    size?: number;
    gallery?: Array<{
      url: string;
      mimeType?: string;
      filename?: string;
      size?: number;
    }>;
    index?: number;
  };
  mermaid?: {
    url: string;
    mimeType?: string;
    filename?: string;
    source?: string;
  };
}
