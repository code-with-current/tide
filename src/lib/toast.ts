/**
 * App-standard toast helpers — thin wrappers over Sonner.
 *
 * Convention (see docs/plans/2026-08-01-loading-state-coverage-design.md):
 *   • Toast = a user-initiated ACTION completed or failed (saved, deleted,
 *     toggled, created). Fire-and-forget outcome confirmation.
 *   • Inline spinner/skeleton = ongoing loading or query state. Never toast
 *     "loading" for a query.
 *   • Success toasts are terse (2–4 words), auto-dismiss (~2.5s default).
 *     Errors persist until dismissed and carry a description.
 *   • No redundant success toast for outcomes already confirmed by visible
 *     UI change (e.g. a toggle flipping on).
 *
 * Re-exporting `toast' directly from sonner keeps call sites `import { toast }
 * from '@/lib/toast'` while letting this module own the canonical surface.
 */

import { toast as sonnerToast } from 'sonner';

export const toast = Object.assign(sonnerToast, {
  /** Terse success (2–4 words). Auto-dismisses. */
  success: (msg: string) => sonnerToast.success(msg),
  /** Persists until dismissed. `description` carries the why. */
  error: (msg: string, opts?: { description?: string }) =>
    sonnerToast.error(msg, opts),
  info: (msg: string) => sonnerToast.info(msg),
  loading: (msg: string) => sonnerToast.loading(msg),
  /** Promise wrapper — covers ~80% of settings-save feedback in one line. */
  promise: sonnerToast.promise,
});
