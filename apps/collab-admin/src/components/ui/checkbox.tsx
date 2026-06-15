import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// 平台内 Checkbox：复用项目既有 button/input 视觉语言（rounded-xl + border + ring），不引入 radix 依赖。
// role="checkbox" 让 Table 的 [&:has([role=checkbox])] 选择器生效（与 shadcn Table 约定一致）。
export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  Omit<React.HTMLAttributes<HTMLButtonElement>, 'onClick'> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }
>(function Checkbox({ className, checked, onCheckedChange, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={(e) => {
        // 点击不触发外层行点击（详情 Sheet）等冒泡逻辑。
        e.stopPropagation();
        onCheckedChange?.(!checked);
      }}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-background transition-colors hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
        checked && 'border-primary bg-primary text-primary-foreground',
        className,
      )}
      {...props}
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </button>
  );
});
