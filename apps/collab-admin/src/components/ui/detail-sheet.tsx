import { useRef, type ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

type DetailSheetSize = 'md' | 'lg' | 'xl';

type DetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  size?: DetailSheetSize;
};

const sizeClassName: Record<DetailSheetSize, string> = {
  md: 'sm:max-w-[40rem]',
  lg: 'sm:max-w-[48rem]',
  xl: 'sm:max-w-[56rem]',
};

export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  size = 'md',
}: DetailSheetProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    returnFocusRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
  }
  wasOpenRef.current = open;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(event) => {
          const returnTarget = returnFocusRef.current;
          returnFocusRef.current = null;
          if (!returnTarget?.isConnected) return;
          event.preventDefault();
          requestAnimationFrame(() => returnTarget.focus({ preventScroll: true }));
        }}
        className={cn(
          'flex h-dvh w-full max-w-full flex-col gap-0 overflow-hidden p-0',
          sizeClassName[size],
          className,
        )}
      >
        <SheetHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12 text-left">
          <SheetTitle className="break-words leading-6">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="break-words leading-5">{description}</SheetDescription>
          ) : null}
        </SheetHeader>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="space-y-5 p-5">{children}</div>
        </div>

        {footer ? (
          <SheetFooter className="block shrink-0 border-t px-5 py-4">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export type { DetailSheetProps, DetailSheetSize };
