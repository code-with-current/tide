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
 * Call sites `import { toast } from '@/lib/toast'`. The helpers below
 * reference the original sonner functions directly (NOT via the exported
 * object) to avoid the self-referential recursion that `Object.assign` caused.
 */

import { toast as sonnerToast } from 'sonner';

/** Terse success (2–4 words). Auto-dismisses. */
export function toastSuccess(msg: string) {
  return sonnerToast.success(msg);
}

/** Persists until dismissed. `description` carries the why. */
export function toastError(msg: string, opts?: { description?: string }) {
  return sonnerToast.error(msg, opts);
}

export function toastInfo(msg: string) {
  return sonnerToast.info(msg);
}

export function toastLoading(msg: string) {
  return sonnerToast.loading(msg);
}

/** Promise wrapper — covers ~80% of settings-save feedback in one line. */
export function toastPromise<T>(
  promise: Promise<T>,
  msgs: { loading: string; success: string | ((data: T) => string); error: string | ((e: unknown) => string) },
) {
  return sonnerToast.promise(promise, msgs);
}

/**
 * The default export mirrors sonner's `toast` callable (so existing
 * `toast('msg')` calls still work) while exposing the typed helpers above
 * as static props. Built by binding — no self-reference.
 */
const toast = Object.assign(
  (msg: string, opts?: Parameters<typeof sonnerToast>[1]) => sonnerToast(msg, opts),
  {
    success: toastSuccess,
    error: toastError,
    info: toastInfo,
    loading: toastLoading,
    promise: toastPromise,
  },
);

export { toast };
export default toast;
