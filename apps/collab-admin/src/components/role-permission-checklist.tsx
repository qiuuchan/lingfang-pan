// 权限勾选公共组件：两级（模块 → 操作）勾选树，供平台角色 / 团队角色编辑面板复用。
//
// 设计：
//  - buildModules：把扁平 PermissionEntry[] 按模块折叠为两级 PermissionModule[]（按 sortOrder 排序）。
//    显示名优先用自定义分组覆盖（groupLabelOverride），否则用权限自带 moduleLabel。
//  - PermissionChecklist：受控组件，selected（权限码集合）+ toggle/toggleAll 回调驱动勾选。
//    lock=true 时整面板只读（用于内置系统角色权限锁定）。
import { useMemo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { PermissionEntry, PermissionModule } from '@/lib/types';

/** 把扁平权限码按模块折叠为两级结构（moduleKey → operations）。
 *  显示名优先用自定义分组覆盖，否则用权限自带 moduleLabel。 */
export function buildModules(
  permissions: PermissionEntry[],
  groupLabelOverride: Map<string, string>
): PermissionModule[] {
  const map = new Map<string, PermissionModule>();
  for (const p of permissions) {
    let m = map.get(p.moduleKey);
    if (!m) {
      m = {
        moduleKey: p.moduleKey,
        moduleLabel: groupLabelOverride.get(p.moduleKey) ?? p.moduleLabel,
        scope: p.scope,
        sortOrder: p.moduleOrder,
        operations: [],
      };
      map.set(p.moduleKey, m);
    }
    m.operations.push(p);
  }
  return [...map.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.moduleKey.localeCompare(b.moduleKey)
  );
}

/** 两级权限勾选面板：模块父级（全选/取消全选）→ 操作子项。
 *  受控：selected 权限码集合 + toggle(code) / toggleAll(codes) 回调。
 *  lock=true 时整面板只读（pointer-events 禁用 + 视觉降透明）。 */
export function PermissionChecklist({
  permissions,
  groupLabelOverride,
  selected,
  onToggle,
  onToggleAll,
  lock = false,
}: {
  permissions: PermissionEntry[];
  groupLabelOverride: Map<string, string>;
  selected: Set<string>;
  onToggle: (code: string) => void;
  onToggleAll: (codes: string[]) => void;
  lock?: boolean;
}) {
  const modules = useMemo(
    () => buildModules(permissions, groupLabelOverride),
    [permissions, groupLabelOverride]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          权限分配
          {lock && <span className="ml-2 text-xs text-muted-foreground">（内置角色锁定）</span>}
        </Label>
        <span className="text-xs text-muted-foreground">
          已选 {selected.size} / {permissions.length}
        </span>
      </div>
      <div className={`rounded-md border p-3 ${lock ? 'pointer-events-none opacity-60' : ''}`}>
        <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
          {modules.map((m) => {
            const codes = m.operations.map((op) => op.code);
            const allOn = codes.every((c) => selected.has(c));
            return (
              <div key={m.moduleKey}>
                <div className="mb-1.5 flex items-center gap-2">
                  <Checkbox checked={allOn} onCheckedChange={() => onToggleAll(codes)} />
                  <span className="text-sm font-medium">{m.moduleLabel}</span>
                  <span className="text-xs text-muted-foreground">{m.moduleKey}</span>
                </div>
                <div className="ml-6 space-y-1.5">
                  {m.operations.map((p) => (
                    <label key={p.code} className="flex cursor-pointer items-start gap-2 text-sm">
                      <Checkbox
                        checked={selected.has(p.code)}
                        onCheckedChange={() => onToggle(p.code)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">{p.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
