import { type ReactElement, type ReactNode, cloneElement, isValidElement } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

/** Tip: one-line text tooltip wrapper around a single child. Forwards unknown props (onClick, aria-*, Slot trigger handlers) via cloneElement. */
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
