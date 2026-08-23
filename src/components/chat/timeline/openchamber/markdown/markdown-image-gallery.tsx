/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/MarkdownImageGallery.tsx.
 *  Adaptation: the server-auth machinery (`useAssetAuth`, runtime auth token
 *  acquire/refresh/subscribe, `useEffectiveDirectory`) is dropped — Tide's
 *  image sources are either remote http(s) or data URLs, neither of which needs
 *  the OpenChamber asset-auth handshake. The VSCode workspace-fs branch is
 *  deleted (desktop-only). Local-file candidates resolve through the
 *  `markdown-image-assets` seam (reported missing and filtered out). i18n
 *  strings are literal English; `<Icon>` comes from the Tide icon shim.
 */
import React from 'react';
import { toast } from 'sonner';
import { Icon } from '../icon';
import type { MarkdownToolPopupContent } from './markdown-renderer-impl';
import {
  extractMarkdownImageCandidates,
  MAX_MARKDOWN_IMAGE_COUNT,
  type MarkdownImageCandidate,
} from './markdown-core';
import {
  isLocalMarkdownImageSource,
  prepareLocalMarkdownImages,
  resolveMarkdownImageSource,
  type PreparedMarkdownImage,
} from './markdown-image-assets';

const MarkdownImageThumbnail: React.FC<{
  candidate: MarkdownImageCandidate;
  preparation?: PreparedMarkdownImage;
  onShowPopup?: (content: MarkdownToolPopupContent) => void;
}> = ({
  candidate,
  preparation,
  onShowPopup,
}) => {
  const thumbnailRef = React.useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [image, setImage] = React.useState<{ url: string; status: 'loading' | 'ready' | 'error' }>({
    url: '',
    status: 'loading',
  });
  const local = isLocalMarkdownImageSource(candidate.source);

  React.useEffect(() => {
    const thumbnail = thumbnailRef.current;
    if (!thumbnail || shouldLoad) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '200px' });
    observer.observe(thumbnail);
    return () => observer.disconnect();
  }, [shouldLoad]);

  React.useEffect(() => {
    if (!shouldLoad) return;
    if (local) {
      // Local-file candidates degrade through the assets seam: only a `ready`
      // preparation (never produced in Tide today) would load.
      if (preparation?.status !== 'ready') {
        setImage({ url: '', status: 'error' });
        return;
      }
      setImage({ url: preparation.path, status: 'loading' });
      return;
    }
    const controller = new AbortController();
    setImage({ url: '', status: 'loading' });
    void resolveMarkdownImageSource(candidate.source, controller.signal).then((url) => {
      if (controller.signal.aborted) return;
      setImage({ url, status: 'loading' });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setImage({ url: '', status: 'error' });
    });
    return () => controller.abort();
  }, [candidate.source, local, preparation, shouldLoad]);

  const openPreview = React.useCallback(() => {
    if (image.status === 'error') {
      toast.error('Preview unavailable');
      return;
    }
    if (image.status !== 'ready' || !onShowPopup) return;
    onShowPopup({
      open: true,
      title: candidate.filename,
      content: '',
      metadata: { tool: 'markdown-image-preview', filename: candidate.filename },
      image: { url: image.url, filename: candidate.filename },
    });
  }, [candidate.filename, image, onShowPopup]);

  return (
    <button
      ref={thumbnailRef}
      type="button"
      className="w-[100px] shrink-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      aria-label={candidate.filename}
      disabled={image.status === 'loading'}
      onClick={openPreview}
      data-openchamber-markdown-image-action="true"
      data-openchamber-markdown-image-source={candidate.source}
      data-openchamber-markdown-image-filename={candidate.filename}
    >
      <span className="flex h-[72px] w-[100px] items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted/10">
        {image.url && image.status !== 'error' ? (
          <img
            src={image.url}
            alt={candidate.filename}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setImage((current) => ({ ...current, status: 'ready' }))}
            onError={() => setImage({ url: '', status: 'error' })}
            data-openchamber-markdown-image="true"
            data-openchamber-markdown-image-thumbnail="true"
            data-openchamber-markdown-image-state={image.status}
          />
        ) : (
          <Icon name="file-image" className="h-5 w-5 text-muted-foreground" />
        )}
      </span>
      <span
        className="mt-1 flex w-[100px] items-center justify-center gap-1 text-muted-foreground"
        title={candidate.filename}
        data-openchamber-markdown-image-caption="true"
      >
        <Icon name="file-image" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate typography-meta">{candidate.filename}</span>
      </span>
    </button>
  );
};

export const MarkdownImageGallery: React.FC<{
  sessionId?: string;
  messageId: string;
  contents: readonly string[];
  onShowPopup?: (content: MarkdownToolPopupContent) => void;
}> = ({ contents, onShowPopup }) => {
  const galleryRef = React.useRef<HTMLDivElement>(null);
  const [shouldPrepare, setShouldPrepare] = React.useState(false);
  const [prepared, setPrepared] = React.useState<Map<string, PreparedMarkdownImage> | null>(null);
  const candidates = React.useMemo(
    () => extractMarkdownImageCandidates(contents, MAX_MARKDOWN_IMAGE_COUNT),
    [contents],
  );
  const localSources = React.useMemo(
    () => candidates
      .filter((candidate) => isLocalMarkdownImageSource(candidate.source))
      .map((candidate) => candidate.source),
    [candidates],
  );

  React.useEffect(() => {
    if (localSources.length === 0 || shouldPrepare) return;
    const gallery = galleryRef.current;
    if (!gallery || typeof IntersectionObserver === 'undefined') {
      setShouldPrepare(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldPrepare(true);
      observer.disconnect();
    }, { rootMargin: '200px' });
    observer.observe(gallery);
    return () => observer.disconnect();
  }, [localSources.length, shouldPrepare]);

  React.useEffect(() => {
    if (!shouldPrepare || localSources.length === 0) return;
    const controller = new AbortController();
    void prepareLocalMarkdownImages({
      sources: localSources,
      directory: '',
      sessionId: '',
      messageId: '',
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setPrepared(result);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setPrepared(new Map(localSources.map((source) => [source, { status: 'error' } as PreparedMarkdownImage])));
      }
    });
    return () => controller.abort();
  }, [localSources, shouldPrepare]);

  const visibleCandidates = candidates.filter((candidate) => prepared?.get(candidate.source)?.status !== 'missing');
  if (visibleCandidates.length === 0) return null;

  return (
    <div
      ref={galleryRef}
      className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1"
      data-openchamber-markdown-image-gallery="true"
    >
      {visibleCandidates.map((candidate) => (
        <MarkdownImageThumbnail
          key={candidate.source}
          candidate={candidate}
          preparation={prepared?.get(candidate.source)}
          onShowPopup={onShowPopup}
        />
      ))}
    </div>
  );
};
