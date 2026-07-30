import { type ReactElement, type ReactNode, cloneElement, isValidElement } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

/**
 * Convenience wrapper for the common case: wrap a single child, show a
 * text tooltip on hover. Reduces the 4-element shadcn boilerplate to one.
 *
 *   <Tip label="Send">
 *     <button>…</button>
 *   </Tip>
 *
 * Forwards unknown props (onClick, aria-*, anything passed by a parent
 * Slot such as `PopoverTrigger asChild` or `DropdownMenuTrigger asChild`)
 * onto the child via cloneElement. Without this forwarding, wrapping a
 * trigger button in <Tip> would silently swallow the trigger's handlers
 * and the popover/menu would never open.
 */
export function Tip({
  label,
  children,
  side = 'top',
  align = 'center',
  delayMs,
  ...rest
}: {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  delayMs?: number;
} & React.HTMLAttributes<HTMLElement>) {
  const trigger = isValidElement(children)
    ? cloneElement(children, rest as Partial<typeof children.props>)
    : (children as ReactElement);
  return (
    <Tooltip delayDuration={delayMs}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side} align={align} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
