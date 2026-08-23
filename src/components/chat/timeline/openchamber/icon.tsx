/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/icon/Icon.tsx
 *  + icons.ts + sprite.ts. Adaptation: upstream's Icon resolves names to a
 *  global SVG sprite injected into <body> (Remixicon symbols under `#oc-<name>`).
 *  Tide has no sprite layer, so the shim maps the (small) set of icon names the
 *  ported chat/markdown files use to `lucide-react` components; unknown names
 *  render a neutral `Circle` icon instead of a broken `<use>` reference.
 *  `iconToSvgString` renders the same registry to a plain SVG string for
 *  DOM-string call sites (markdown decorate toolbar buttons), replacing
 *  upstream's sprite `<use href="#oc-...">` references.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Check,
  Circle,
  Copy,
  Download,
  FileImage,
  Minus,
  Plus,
  RefreshCw,
  WrapText,
  type LucideProps,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Icon names used by the ported chat/markdown components (upstream names). */
export type IconName =
  | 'file-copy'
  | 'check'
  | 'download'
  | 'add'
  | 'subtract'
  | 'refresh'
  | 'text-wrap'
  | 'file-image';

const ICON_REGISTRY: Record<IconName, React.ComponentType<LucideProps>> = {
  'file-copy': Copy,
  check: Check,
  download: Download,
  add: Plus,
  subtract: Minus,
  refresh: RefreshCw,
  'text-wrap': WrapText,
  'file-image': FileImage,
};

export interface IconProps extends Omit<LucideProps, 'name'> {
  name: string;
}

/** Upstream `<Icon name=...>` shim. Unknown names render a neutral circle. */
export function Icon({ name, className, size, ...props }: IconProps) {
  const Component = (name in ICON_REGISTRY ? ICON_REGISTRY[name as IconName] : undefined) ?? Circle;
  return <Component aria-hidden="true" className={cn(className)} size={size} {...props} />;
}

/**
 * Render an icon from the registry to a standalone SVG string (stroke inherits
 * `currentColor`, so DOM-built controls stay themed). Used by markdown decorate
 * passes that build HTML strings rather than React trees; upstream referenced
 * the shared sprite here instead.
 */
// oxlint-disable-next-line react/only-export-components -- non-component export lives beside its registry; fast-refresh granularity for this leaf shim is not a concern
export function iconToSvgString(name: IconName, className = 'size-3.5'): string {
  const Component = ICON_REGISTRY[name] ?? Circle;
  return renderToStaticMarkup(createElement(Component, { className, 'aria-hidden': true }));
}
