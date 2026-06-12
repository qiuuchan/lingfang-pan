import { StarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Stars({ score, max = 5, className, starClassName }: { score: number; max?: number; className?: string; starClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={`${score} 星`}>
      {Array.from({ length: max }, (_, i) => (
        <StarIcon key={i} className={cn('size-4', i < score ? 'fill-current text-yellow-500' : 'text-muted-foreground/40', starClassName)} />
      ))}
    </span>
  );
}