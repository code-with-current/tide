/**
 * Minimal in-panel browser: URL bar + back/forward/reload + webview. The
 * URL persists per workspace; the webview unmounts with the panel (URL
 * remembered, reloads on reopen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { isNavigableUrl, normalizeUrl } from '@/lib/browser-url';
import { cn } from '@/lib/utils';

/** Minimal surface of Electron's <webview> tag beyond what @types/react
 *  knows (HTMLWebViewElement is an empty HTMLElement stub). The renderer
 *  tsconfig has no Electron globals, so the navigation methods are declared
 *  here — local and honest. */
interface WebviewElement extends HTMLWebViewElement {
  src: string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

export function BrowserTab() {
  const workspaceId = useUi((s) => s.activeWorkspaceId);
  const stored = useUi((s) => (workspaceId ? s.browserUrls[workspaceId] : undefined));
  const setBrowserUrl = useUi((s) => s.setBrowserUrl);
  const wvRef = useRef<WebviewElement | null>(null);
  // Last URL commanded to (or reported by) the webview. Guards the src
  // effect so internal navigations are never re-commanded.
  const lastSrc = useRef('');
  const [input, setInput] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });

  useEffect(() => {
    setUrl(stored ?? '');
    // Unmounting the webview (no stored URL) clears the guard — otherwise a
    // stale lastSrc would silently swallow a later navigation to that URL.
    if (!stored) lastSrc.current = '';
  }, [stored]);

  // While the input is focused the user owns it; on blur an unsubmitted
  // edit is discarded back to the stored URL. did-navigate updates `stored`,
  // so the bar tracks page navigations too.
  useEffect(() => {
    if (!focused) setInput(stored ?? '');
  }, [stored, focused]);

  const syncNav = useCallback(() => {
    const wv = wvRef.current;
    if (!wv) return;
    setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
  }, []);

  const hasUrl = url !== '';

  useEffect(() => {
    const wv = wvRef.current;
    if (!wv || !hasUrl) return;
    const onWillNavigate = (e: Event) => {
      if (!isNavigableUrl((e as Event & { url?: string }).url ?? '')) e.preventDefault();
    };
    const onDidNavigate = (e: Event) => {
      const current = (e as Event & { url?: string }).url;
      // Internal navigation (link click / redirect): the page already moved.
      // Record it so the src effect below doesn't re-command the webview
      // into a hard reload.
      if (current) lastSrc.current = current;
      if (current && workspaceId) setBrowserUrl(workspaceId, current);
      syncNav();
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    wv.addEventListener('will-navigate', onWillNavigate);
    wv.addEventListener('did-navigate', onDidNavigate);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('dom-ready', syncNav);
    return () => {
      wv.removeEventListener('will-navigate', onWillNavigate);
      wv.removeEventListener('did-navigate', onDidNavigate);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('dom-ready', syncNav);
    };
  }, [hasUrl, workspaceId, setBrowserUrl, syncNav]);

  // src is commanded imperatively, never via JSX: writing the src attribute
  // always (re)navigates, so round-tripping internal navigations through
  // state would hard-reload the page the user just landed on.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv || !url || lastSrc.current === url) return;
    lastSrc.current = url;
    wv.src = url;
  }, [url]);

  const go = useCallback(() => {
    if (!workspaceId) return;
    const next = normalizeUrl(input);
    if (!isNavigableUrl(next)) return;
    if (next === lastSrc.current) {
      wvRef.current?.reload();
      return;
    }
    setUrl(next);
    setBrowserUrl(workspaceId, next);
  }, [input, workspaceId, setBrowserUrl]);

  const iconBtn =
    'p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border flex-shrink-0">
        <button
          type="button"
          title="Back"
          disabled={!nav.back}
          onClick={() => wvRef.current?.goBack()}
          className={iconBtn}
        >
          <ArrowLeft className="size-3" />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!nav.forward}
          onClick={() => wvRef.current?.goForward()}
          className={iconBtn}
        >
          <ArrowRight className="size-3" />
        </button>
        <button
          type="button"
          title="Reload"
          disabled={!url}
          onClick={() => wvRef.current?.reload()}
          className={iconBtn}
        >
          <RotateCw className={cn('size-3', loading && 'animate-spin')} />
        </button>
        <div className="flex-1 flex items-center gap-1 px-2 py-0.5 rounded-md bg-input">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
            }}
            placeholder="Enter a URL…"
            className="bg-transparent w-full border-0 outline-none text-[0.75rem] placeholder:text-muted-foreground text-foreground"
          />
        </div>
        <button
          type="button"
          onClick={go}
          className="px-2 py-0.5 rounded-md hover:bg-secondary text-[0.75rem] text-muted-foreground hover:text-foreground transition-colors"
        >
          Go
        </button>
      </div>

      {url ? (
        <webview ref={wvRef} className="h-full w-full flex-1" />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <p className="text-[0.8rem] text-muted-foreground">Enter a URL to start browsing</p>
          <div className="flex w-full max-w-sm gap-1.5">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go();
              }}
              placeholder="https://example.com"
              className="flex-1 px-2 py-1 rounded-md bg-input border-0 outline-none text-[0.75rem] placeholder:text-muted-foreground text-foreground"
            />
            <button
              type="button"
              onClick={go}
              className="px-3 py-1 rounded-md bg-secondary text-[0.75rem] text-foreground hover:bg-secondary/80 transition-colors"
            >
              Go
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
