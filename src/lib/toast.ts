/** App-standard toast helpers — thin wrappers over Sonner. */

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

/** Default export mirrors sonner's `toast` callable with typed helpers as static props. */
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
