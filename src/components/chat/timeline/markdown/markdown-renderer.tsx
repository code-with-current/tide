/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/MarkdownRenderer.tsx.
 *  Adaptation: `lazyWithChunkRecovery` (the upstream's retrying lazy loader) is
 *  replaced with plain `React.lazy` — Tide has no chunk-recovery helper; the
 *  mobile-surface fallback branch is dropped (desktop-only app). The lazy
 *  module-loading shape (loader indirection + gallery split) is preserved. */
import React from 'react';
import { loadMarkdownRendererModule } from './markdown-renderer-loader';

// Thin lazy wrapper around the markdown renderer implementation.
// The full implementation (marked + Shiki highlighting + KaTeX + morphdom
// DOM morphing, plus beautiful-mermaid) is loaded on demand, keeping the
// initial bundle lean.

const MarkdownRendererLazy = React.lazy(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.MarkdownRenderer })),
);

const SimpleMarkdownRendererLazy = React.lazy(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.SimpleMarkdownRenderer })),
);

const MarkdownImageGalleryLazy = React.lazy(() =>
  import('./markdown-image-gallery').then((m) => ({ default: m.MarkdownImageGallery })),
);

const fallback = <div className="break-words w-full min-w-0" />;

export const MarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={fallback}>
    <MarkdownRendererLazy {...props} />
  </React.Suspense>
);

export const SimpleMarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof SimpleMarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={fallback}>
    <SimpleMarkdownRendererLazy {...props} />
  </React.Suspense>
);

export const MarkdownImageGallery: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownImageGalleryLazy>> = (props) => (
  <React.Suspense fallback={null}>
    <MarkdownImageGalleryLazy {...props} />
  </React.Suspense>
);
