import * as React from 'react';
import { cn } from '@/lib/utils';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'icon';
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium leading-none shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50',
        size === 'default' && 'min-h-10 px-4 py-2',
        size === 'sm' && 'h-8 px-3 py-1 text-xs',
        size === 'icon' && 'size-10',
        variant === 'default' && 'bg-primary text-primary-foreground hover:bg-primary/85',
        variant === 'outline' && 'border border-border bg-background text-foreground hover:bg-muted',
        variant === 'ghost' && 'bg-transparent shadow-none hover:bg-muted',
        variant === 'destructive' && 'border border-destructive/20 bg-destructive/10 text-destructive shadow-none hover:bg-destructive/20',
        className,
      )}
      {...props}
    />
  );
});
