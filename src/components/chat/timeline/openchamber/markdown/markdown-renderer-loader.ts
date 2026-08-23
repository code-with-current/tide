/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/markdownRendererLoader.ts.
 *  Verbatim port. */
let markdownRendererModulePromise: Promise<typeof import('./markdown-renderer-impl')> | null = null;

export const loadMarkdownRendererModule = () => {
  markdownRendererModulePromise ??= import('./markdown-renderer-impl').catch((error) => {
    markdownRendererModulePromise = null;
    throw error;
  });
  return markdownRendererModulePromise;
};

export const preloadMarkdownRenderer = () => {
  void loadMarkdownRendererModule().catch(() => undefined);
};
