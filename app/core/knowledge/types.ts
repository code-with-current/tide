/** Shared types for the knowledge-sources feature: registry rows, ingestion
 *  progress events, and normalized documents produced by fetchers. */

export type SourceKind = 'url' | 'docs' | 'crawl' | 'repo';

export interface KnowledgeSource {
  id: string; // crypto.randomUUID()
  name: string;
  kind: SourceKind;
  /** url / dir or file path / root url / repo url */
  location: string;
  createdAt: number;
  lastIndexedAt: number | null;
  status: 'idle' | 'queued' | 'indexing' | 'error';
  error: string | null;
  chunkCount: number;
  embedderId: string | null;
  /** ['*'] = all workspaces */
  enabledWorkspaceIds: string[];
}

export interface SourceProgressEvent {
  sourceId: string;
  phase: 'fetching' | 'chunking' | 'embedding' | 'done' | 'failed';
  pagesSeen?: number;
  chunksTotal?: number;
  chunksEmbedded?: number;
  current?: string;
  error?: string;
}

export interface SourceDocument {
  title: string;
  content: string;
  /** Stored in chunks.path — shown as hit label ("example.com/guide") */
  origin: string;
}
