// Radix Dialog + framer-motion 弹窗动画（组B / 弹窗动画美化）。
//
// 设计：
//  - 保留 Radix Dialog 的可访问性（焦点陷阱 / aria / ESC 关闭 / 点击遮罩关闭 / Portal），仅替换动画驱动为 framer-motion。
//  - Radix 默认动画走 tw-animate-css 的 CSS 关键帧（linear easing），此处改用 framer-motion 的 spring
//    （遮罩 fade + 内容 scale+fade，spring 弹性更精致）。
//  - 通过 DialogRootCtx 把 open 状态从 Root 透到 Content，使 AnimatePresence 能感知 open→close 触发退出动画
//    （Radix 自身在 close 时立即卸载 Content，无 CSS animation 时不等退出；forceMount + AnimatePresence 接管挂载）。
//  - 尊重 prefers-reduced-motion：开启「减少动态效果」时退化为瞬时切换（无位移/缩放，仅 opacity 快速淡入淡出）。
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Root 上下文：透传 open 状态供 DialogContent 的 AnimatePresence 感知 close（触发退出动画）。 */
const DialogRootCtx = React.createContext<{ open: boolean }>({ open: false });

function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  // 受控 / 非受控 open：Radix 在非受控时内部维护，此处用 defaultOpen 做初始快照，
  // 受控时直接用 open。无论哪种，透给 Content 的 AnimatePresence 都能正确感知。
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isControlled = open !== undefined;
  const currentOpen = isControlled ? open : uncontrolledOpen;
  return (
    <DialogRootCtx.Provider value={{ open: currentOpen }}>
      <DialogPrimitive.Root
        open={currentOpen}
        defaultOpen={defaultOpen}
        onOpenChange={(next) => {
          if (!isControlled) setUncontrolledOpen(next);
          onOpenChange?.(next);
        }}
        modal={modal}
        {...props}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogRootCtx.Provider>
  );
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

/** 遮罩：framer-motion fade + backdrop-blur（默认 0.2s 线性，与内容 spring 协调）。
 *  保留 Radix Overlay 的「点击关闭」语义（Radix 内部处理 onClick → onOpenChange(false)），
 *  asChild 让 motion.div 接管渲染，Radix 仅附加事件 + aria。 */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  const reduce = useReducedMotion();
  return (
    <DialogPrimitive.Overlay asChild forceMount {...props}>
      <motion.div
        className={cn('absolute inset-0 bg-black/50 backdrop-blur-[2px]', className)}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduce ? { duration: 0.12 } : { duration: 0.2, ease: 'easeOut' }}
      />
    </DialogPrimitive.Overlay>
  );
}

/** 内容：scale + fade（spring 弹性）。Radix Content 用 forceMount + asChild 让 motion.div 接管渲染与动画。 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  const { open } = React.useContext(DialogRootCtx);
  const reduce = useReducedMotion();
  // Closed portals must unmount; otherwise a parent Sheet can leave a nested
  // confirmation portal under aria-hidden when it opens later.
  return (
    <DialogPrimitive.Portal>
      <div>
        <AnimatePresence>
          {open ? (
            <div key="dialog-motion-root" className="fixed inset-0 z-[60]">
              <DialogOverlay />
              <DialogPrimitive.Content ref={ref} asChild forceMount {...props}>
                <motion.div
                  className={cn(
                    'absolute left-[50%] top-[50%] grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-5 shadow-lg sm:p-6',
                    className
                  )}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
                  transition={
                    reduce ? { duration: 0.12 } : { type: 'spring', stiffness: 320, damping: 30 }
                  }
                >
                  {children}
                  <DialogPrimitive.Close className="absolute right-4 top-4 rounded-lg opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                    <XIcon className="size-4" />
                    <span className="sr-only">关闭</span>
                  </DialogPrimitive.Close>
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          ) : null}
        </AnimatePresence>
      </div>
    </DialogPrimitive.Portal>
  );
});

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-1.5 text-center sm:text-left', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

// DialogPortal 保留导出以兼容旧调用方；DialogContent 只在打开时挂载 Portal。
function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />;
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
