import type { LoadedPlugin } from '@/lib/types';

export function isAuthorManaged(plugin: LoadedPlugin): boolean {
  return plugin.source === 'team';
}

export function readPluginIcon(plugin: LoadedPlugin): string | undefined {
  const manifest = plugin.manifest;
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const icon = (manifest as Record<string, unknown>).icon;
    if (typeof icon === 'string' && icon.trim()) return icon.trim();
  }
  return undefined;
}

export function PluginIcon({ icon, className }: { icon?: string; className?: string }) {
  if (icon && /^data:image\//i.test(icon)) {
    return <img src={icon} alt="" className={className ?? 'size-10 rounded object-cover'} referrerPolicy="no-referrer" />;
  }
  return (
    <span className={className ?? 'flex size-10 items-center justify-center rounded bg-muted text-lg'}>
      {icon || '🧩'}
    </span>
  );
}
