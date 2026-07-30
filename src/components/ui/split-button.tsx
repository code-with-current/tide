/**
 * SplitButton — a primary action button with a chevron toggle that opens a
 * dropdown of related secondary actions. Built from shadcn ButtonGroup +
 * Button + DropdownMenu so it inherits their styling and a11y (keyboard nav,
 * focus management, outside-click/Escape close — all from Radix).
 *
 * Used by the Inspector Review card to collapse the four secondary permission
 * actions (Reject & explain; Remember · Session/Project; Switch to Edit Mode)
 * behind the two primary buttons, reducing visual clutter in a narrow panel.
 *
 * The primary click and each item's onSelect stay independent callbacks —
 * this is a presentation composite, not a behavior change.
 */
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { type VariantProps } from 'class-variance-authority';
import { Button, buttonVariants } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Derive the variant/size prop types from the project's Button — it doesn't
// export a ButtonProps type, so we mirror its `VariantProps<typeof buttonVariants>`
// pattern. Keeps split-button in sync with button.tsx if it gains a variant.
type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
type ButtonSize = VariantProps<typeof buttonVariants>['size'];

export interface SplitButtonItem {
  /** Bold label line. */
  label: ReactNode;
  /** Optional muted hint beneath the label explaining the consequence. */
  hint?: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Fired on select. The dropdown closes automatically (Radix). */
  onSelect: () => void;
}

export interface SplitButtonProps {
  /** Primary button label. */
  label: ReactNode;
  /** Primary click handler. */
  onPrimary: () => void;
  /** Button variant for both the primary and the chevron toggle. */
  variant?: ButtonVariant;
  /** Button size for both halves. */
  size?: ButtonSize;
  /** Secondary actions revealed by the chevron. Empty → no chevron rendered. */
  items: SplitButtonItem[];
  /** Dropdown anchor side relative to the group. Defaults to 'end'. */
  menuAlign?: 'start' | 'end';
  /** Disable both halves (e.g. while a request is in flight). */
  disabled?: boolean;
  /** Accessible label for the chevron toggle. */
  toggleAriaLabel?: string;
  /** Extra classes on the outer ButtonGroup. */
  className?: string;
}

export function SplitButton({
  label,
  onPrimary,
  variant = 'default',
  size = 'sm',
  items,
  menuAlign = 'end',
  disabled,
  toggleAriaLabel,
  className,
}: SplitButtonProps) {
  // No secondary items → render a plain primary button. Keeps call sites
  // uniform: they always pass `items`, but it may be empty for some states
  // (e.g. the blocked-mode card has no Approve variants).
  if (items.length === 0) {
    return (
      <Button variant={variant} size={size} onClick={onPrimary} disabled={disabled} className={className}>
        {label}
      </Button>
    );
  }

  return (
    <ButtonGroup className={className}>
      <Button
        variant={variant}
        size={size}
        onClick={onPrimary}
        disabled={disabled}
        // The ButtonGroup trims inner corners; the primary half keeps its
        // outer (left) rounding and loses the right so the chevron sits flush.
      >
        {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size={size}
            disabled={disabled}
            aria-label={toggleAriaLabel ?? `More options for ${typeof label === 'string' ? label : 'action'}`}
            // icon size keeps the chevron compact regardless of button size;
            // pull a hair of left padding off so the divider reads cleanly.
            className="px-1.5 [&_svg]:size-3.5"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={menuAlign} sideOffset={4} className="min-w-[200px]">
          {items.map((item, i) => (
            <DropdownMenuItem
              key={i}
              onSelect={(e) => {
                e.preventDefault(); // stay open-safe; caller decides
                item.onSelect();
              }}
              className="items-start gap-2 py-2"
            >
              {item.icon && <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">{item.icon}</span>}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-semibold leading-tight">{item.label}</span>
                {item.hint && <span className="text-[10px] leading-tight text-muted-foreground">{item.hint}</span>}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
