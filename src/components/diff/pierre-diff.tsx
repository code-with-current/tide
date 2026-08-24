import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { VirtualizedFile, VirtualizedFileDiff, areOptionsEqual, parseDiffFromFile } from '@pierre/diffs';
import type { FileDiffMetadata, FileDiffOptions, FileContents, FileOptions } from '@pierre/diffs';
import { useUi } from '@/lib/stores/ui';
import {
  LARGE_CONTENT_BYTES,
  PIERRE_THEMES,
  acquireSharedVirtualizer,
  contentCacheKey,
  getPierreFontStack,
  getPierreThemeType,
  getPierreWorkerPool,
  registerPierreThemes,
  releaseSharedVirtualizer,
  wakeVirtualizer,
} from '@/lib/diff/pierre-bridge';

export interface PierreDiffProps {
  original: string;
  modified: string;
  /** Pre-parsed diff; skips the parse when provided. */
  fileDiff?: FileDiffMetadata;
  /** Explicit syntax language override (shiki id, e.g. 'typescript'). */
  language?: string;
  sideBySide: boolean;
  wrap?: boolean;
}

type PierreFileDiff = VirtualizedFileDiff<unknown>;

/**
 * Imperative Pierre diff host. Trimmed of comments/annotations/selection.
 * Loaded lazily by the file viewer (and future diff surfaces) so the large
 * @pierre/diffs chunk stays out of the entry bundle.
 */
export function PierreDiff({ original, modified, fileDiff, language, sideBySide, wrap = false }: PierreDiffProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<PierreFileDiff | null>(null);
  // Last inputs pushed to the imperative instance. The update effect below
  // runs on EVERY render (streaming parents re-render at high frequency);
  // calling instance.render() again would cancel in-flight worker
  // tokenization and restart it, so it must be skipped when nothing changed.
  const lastPushed = useRef<{ input: unknown; options: FileDiffOptions<unknown> } | null>(null);
  const appTheme = useUi((s) => s.appTheme);

  const parsedDiff = useMemo<FileDiffMetadata>(() => {
    if (fileDiff != null) return fileDiff;
    const oldFile: FileContents = {
      name: 'original',
      contents: original,
      lang: language,
      cacheKey: contentCacheKey('old', original),
    };
    const newFile: FileContents = {
      name: 'modified',
      contents: modified,
      lang: language,
      cacheKey: contentCacheKey('new', modified),
    };
    return parseDiffFromFile(oldFile, newFile);
  }, [fileDiff, original, modified, language]);

  const buildOptions = (): FileDiffOptions<unknown> => ({
    theme: PIERRE_THEMES,
    themeType: getPierreThemeType(),
    diffStyle: sideBySide ? 'split' : 'unified',
    lineDiffType: 'none',
    hunkSeparators: 'line-info-basic',
    overflow: wrap ? 'wrap' : 'scroll',
    disableFileHeader: true,
    tokenizeMaxLength: LARGE_CONTENT_BYTES,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = containerRef.current;
    if (root == null || host == null) return;

    registerPierreThemes();
    const fileContainer = document.createElement('diffs-container');
    fileContainer.style.display = 'block';
    fileContainer.style.setProperty('--diffs-font-family', getPierreFontStack());
    host.appendChild(fileContainer);

    const virtualizer = acquireSharedVirtualizer(root, fileContainer);
    const instance = new VirtualizedFileDiff(buildOptions(), virtualizer, undefined, getPierreWorkerPool(), true);
    instance.hydrate({ fileDiff: parsedDiff, fileContainer });
    instanceRef.current = instance;
    const frame = requestAnimationFrame(() => wakeVirtualizer(root));

    return () => {
      cancelAnimationFrame(frame);
      instance.cleanUp();
      instanceRef.current = null;
      releaseSharedVirtualizer(root);
      host.innerHTML = '';
    };
    // Mount-once by design: prop changes flow through the update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const instance = instanceRef.current;
    if (instance == null) return;
    const options = buildOptions();
    const prev = lastPushed.current;
    if (prev != null && prev.input === parsedDiff && areOptionsEqual(prev.options, options)) return;
    lastPushed.current = { input: parsedDiff, options };
    instance.setOptions(options);
    instance.render({ fileDiff: parsedDiff, forceRender: prev == null || !areOptionsEqual(prev.options, options) });
  });

  useEffect(() => {
    instanceRef.current?.setThemeType(getPierreThemeType());
  }, [appTheme]);

  return (
    <div ref={rootRef} className="size-full min-h-0" style={{ overflow: 'auto' }}>
      <div ref={containerRef} className="size-full" />
    </div>
  );
}

export interface PierreFileProps {
  /** Full file contents — rendered as a highlighted, virtualized single file. */
  content: string;
  /** Filename — drives language inference. */
  name: string;
  /** Explicit syntax language override (shiki id, e.g. 'typescript'). */
  language?: string;
  wrap?: boolean;
}

/** Single-file Pierre host (no diff) — the plain-content counterpart of
 *  PierreDiff, built on Pierre's real VirtualizedFile component. */
export function PierreFile({ content, name, language, wrap = true }: PierreFileProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<VirtualizedFile<unknown> | null>(null);
  // See PierreDiff — dedupe imperative pushes under high-frequency re-renders.
  const lastPushed = useRef<{ input: unknown; options: FileOptions<unknown> } | null>(null);
  const appTheme = useUi((s) => s.appTheme);

  const file = useMemo<FileContents>(() => ({
    name,
    contents: content,
    lang: language,
    cacheKey: contentCacheKey('file', content),
  }), [name, content, language]);

  const buildOptions = (): FileOptions<unknown> => ({
    theme: PIERRE_THEMES,
    themeType: getPierreThemeType(),
    overflow: wrap ? 'wrap' : 'scroll',
    disableFileHeader: true,
    tokenizeMaxLength: LARGE_CONTENT_BYTES,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = containerRef.current;
    if (root == null || host == null) return;

    registerPierreThemes();
    const fileContainer = document.createElement('diffs-container');
    fileContainer.style.display = 'block';
    fileContainer.style.setProperty('--diffs-font-family', getPierreFontStack());
    host.appendChild(fileContainer);

    const virtualizer = acquireSharedVirtualizer(root, fileContainer);
    const instance = new VirtualizedFile(buildOptions(), virtualizer, undefined, getPierreWorkerPool(), true);
    instance.hydrate({ file, fileContainer });
    instanceRef.current = instance;
    const frame = requestAnimationFrame(() => wakeVirtualizer(root));

    return () => {
      cancelAnimationFrame(frame);
      instance.cleanUp();
      instanceRef.current = null;
      releaseSharedVirtualizer(root);
      host.innerHTML = '';
    };
    // Mount-once by design: prop changes flow through the update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const instance = instanceRef.current;
    if (instance == null) return;
    const options = buildOptions();
    const prev = lastPushed.current;
    if (prev != null && prev.input === file && areOptionsEqual(prev.options, options)) return;
    lastPushed.current = { input: file, options };
    instance.setOptions(options);
    instance.render({ file, forceRender: prev == null || !areOptionsEqual(prev.options, options) });
  });

  useEffect(() => {
    instanceRef.current?.setThemeType(getPierreThemeType());
  }, [appTheme]);

  return (
    <div ref={rootRef} className="size-full min-h-0" style={{ overflow: 'auto' }}>
      <div ref={containerRef} className="size-full" />
    </div>
  );
}
