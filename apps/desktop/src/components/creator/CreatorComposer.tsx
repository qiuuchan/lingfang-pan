import { useState, type ComponentType, type ReactNode } from 'react';
import {
  ArrowUpIcon,
  AtSignIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CrownIcon,
  FolderOpenIcon,
  GaugeIcon,
  MicIcon,
  PackageIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
  WandSparklesIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LoadedPlugin } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';
import type { CreatorMode } from '@/lib/plugin-creator/creator-input';

export interface CreatorSelectedFile {
  id: string;
  name: string;
  file: File;
}

const CONTROL_CLASS = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45';

function MenuAction({
  children,
  disabled,
  icon: Icon,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-popover-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-45"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function SelectOption({
  active,
  children,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1">{children}</span>
      {active && <CheckIcon className="size-3.5 text-primary" />}
    </button>
  );
}

export function CreatorComposer({
  activeSkillCount,
  busy,
  canInspectContext,
  compressHint,
  contextUsagePct,
  contextUsageLabel,
  input,
  mode,
  onClearFiles,
  onImportFiles,
  onOpenContext,
  onOpenSkills,
  onOpenWorkspace,
  onInputChange,
  onModeChange,
  onOptimizePrompt,
  onPickFiles,
  onPickFolder,
  onRefreshWorkspace,
  onRemoveFile,
  onSend,
  onSelectReferencedPlugin,
  onSelectTier,
  onStop,
  onToggleVoice,
  recentPlugins,
  selectedFiles,
  optimizingPrompt,
  tier,
  referencedPlugin,
  voiceListening,
  workspacePath,
  workspacePluginId,
}: {
  activeSkillCount: number;
  busy: boolean;
  canInspectContext: boolean;
  compressHint?: string;
  contextUsagePct: number | null;
  contextUsageLabel?: string;
  input: string;
  mode: CreatorMode;
  onClearFiles: () => void;
  onImportFiles: () => void;
  onOpenContext: () => void;
  onOpenSkills: () => void;
  onOpenWorkspace: () => void;
  onInputChange: (value: string) => void;
  onModeChange: (mode: CreatorMode) => void;
  onOptimizePrompt: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onRefreshWorkspace: () => void;
  onRemoveFile: (id: string) => void;
  onSend: () => void;
  onSelectReferencedPlugin: (plugin: LoadedPlugin | null) => void;
  onSelectTier: (tier: 'fast' | 'premium') => void;
  onStop: () => void;
  onToggleVoice: () => void;
  recentPlugins: LoadedPlugin[];
  selectedFiles: CreatorSelectedFile[];
  optimizingPrompt: boolean;
  tier: 'fast' | 'premium';
  referencedPlugin: LoadedPlugin | null;
  voiceListening: boolean;
  workspacePath: string | null;
  workspacePluginId: string | null;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const selectedModelLabel = tier === 'fast' ? '快速' : '高级';
  const hasContextChips = selectedFiles.length > 0 || referencedPlugin != null || workspacePluginId != null;

  function runMoreAction(action: () => void) {
    setMoreOpen(false);
    action();
  }

  return (
    <div className="shrink-0 bg-background/95 px-3 pb-4 pt-2 backdrop-blur-sm sm:px-5 sm:pb-5">
      <div className={CREATOR_COLUMN_CLASS}>
        <div className="overflow-hidden rounded-lg border border-border/80 bg-card shadow-lg transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:shadow-xl">
          {hasContextChips && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 px-3 py-2">
              {workspacePluginId && (
                <div className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  <button type="button" onClick={onOpenWorkspace} className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground" title={workspacePath ?? workspacePluginId}>
                    <FolderOpenIcon className="size-3.5 shrink-0" />
                    <span className="max-w-44 truncate">{workspacePath ?? workspacePluginId}</span>
                  </button>
                  <button type="button" onClick={onRefreshWorkspace} className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" title="刷新工作区" aria-label="刷新工作区">
                    <RefreshCwIcon className="size-3" />
                  </button>
                </div>
              )}
              {referencedPlugin && (
                <div className="inline-flex min-w-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                  <AtSignIcon className="size-3.5 shrink-0" />
                  <span className="max-w-36 truncate">{referencedPlugin.name}</span>
                  <button type="button" onClick={() => onSelectReferencedPlugin(null)} className="rounded-sm p-0.5 hover:bg-primary/10" title="取消引用" aria-label="取消引用">
                    <XIcon className="size-3" />
                  </button>
                </div>
              )}
              {selectedFiles.slice(0, 4).map((file) => (
                <div key={file.id} className="inline-flex min-w-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  <PaperclipIcon className="size-3.5 shrink-0" />
                  <span className="max-w-32 truncate" title={file.name}>{file.name}</span>
                  <button type="button" onClick={() => onRemoveFile(file.id)} className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" title="移除文件" aria-label="移除文件">
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
              {selectedFiles.length > 4 && <span className="text-xs text-muted-foreground">+{selectedFiles.length - 4}</span>}
            </div>
          )}

          <Textarea
            placeholder="描述要创建或修改的插件…"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={1}
            className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-3.5 py-2.5 text-sm leading-6 shadow-none outline-none placeholder:text-muted-foreground/60 focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:opacity-60 dark:bg-transparent dark:disabled:bg-transparent"
            disabled={busy}
          />

          <div className="flex min-h-10 items-center justify-between gap-2 border-t border-border/60 px-2 py-1">
            <div className="flex min-w-0 items-center gap-1">
              <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                <PopoverTrigger render={
                  <button
                    type="button"
                    className={cn(CONTROL_CLASS, 'relative size-8 px-0')}
                    title="添加上下文与更多操作"
                    aria-label="添加上下文与更多操作"
                  />
                }>
                  <PlusIcon className="size-4" />
                </PopoverTrigger>
                <PopoverContent className="w-72 p-2" align="start" side="top" sideOffset={8}>
                  <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">添加到本轮</div>
                  <MenuAction icon={PaperclipIcon} onClick={() => runMoreAction(onPickFiles)}>选择文件</MenuAction>
                  <MenuAction icon={FolderOpenIcon} onClick={() => runMoreAction(onPickFolder)}>选择文件夹</MenuAction>
                  {selectedFiles.length > 0 && (
                    <>
                      <MenuAction icon={PackageIcon} disabled={busy} onClick={() => runMoreAction(onImportFiles)}>将已选文件导入为插件</MenuAction>
                      <MenuAction icon={XIcon} onClick={() => runMoreAction(onClearFiles)}>清空已选文件</MenuAction>
                    </>
                  )}
                  <MenuAction icon={SparklesIcon} onClick={() => runMoreAction(onOpenSkills)}>技能（已启用 {activeSkillCount} 个）</MenuAction>
                  <MenuAction icon={WandSparklesIcon} disabled={busy || optimizingPrompt || !input.trim()} onClick={() => runMoreAction(onOptimizePrompt)}>
                    {optimizingPrompt ? '正在优化提示词…' : '优化提示词'}
                  </MenuAction>
                  <MenuAction icon={MicIcon} disabled={busy} onClick={() => runMoreAction(onToggleVoice)}>{voiceListening ? '停止语音输入' : '语音输入'}</MenuAction>

                  {workspacePluginId && (
                    <>
                      <div className="my-1 border-t" />
                      <MenuAction icon={FolderOpenIcon} onClick={() => runMoreAction(onOpenWorkspace)}>打开插件工作区</MenuAction>
                      <MenuAction icon={RefreshCwIcon} onClick={() => runMoreAction(onRefreshWorkspace)}>刷新插件工作区</MenuAction>
                    </>
                  )}

                  {recentPlugins.length > 0 && (
                    <>
                      <div className="my-1 border-t" />
                      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">引用已有插件</div>
                      <div className="max-h-40 overflow-y-auto">
                        {recentPlugins.map((plugin) => {
                          const active = referencedPlugin?.id === plugin.id;
                          return (
                            <button
                              key={plugin.id}
                              type="button"
                              onClick={() => runMoreAction(() => onSelectReferencedPlugin(active ? null : plugin))}
                              className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent', active && 'bg-accent')}
                            >
                              <AtSignIcon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{plugin.name}</span>
                              {active && <CheckIcon className="size-3.5 text-primary" />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </PopoverContent>
              </Popover>

              <Popover open={modeOpen} onOpenChange={setModeOpen}>
                <PopoverTrigger render={<button type="button" disabled={busy} className={CONTROL_CLASS} title="选择工作模式" />}>
                  <BrainIcon className="size-3.5" />
                  <span>{mode === 'plan' ? 'Plan' : 'Agent'}</span>
                  <ChevronDownIcon className="size-3 opacity-65" />
                </PopoverTrigger>
                <PopoverContent className="w-48 p-2" align="start" side="top" sideOffset={8}>
                  <SelectOption active={mode === 'agent'} icon={SparklesIcon} onClick={() => { onModeChange('agent'); setModeOpen(false); }}>Agent</SelectOption>
                  <SelectOption active={mode === 'plan'} icon={BrainIcon} onClick={() => { onModeChange('plan'); setModeOpen(false); }}>Plan</SelectOption>
                </PopoverContent>
              </Popover>

              <Popover open={modelOpen} onOpenChange={setModelOpen}>
                <PopoverTrigger render={<button type="button" disabled={busy} className={CONTROL_CLASS} title="选择模型档位" />}>
                  <span>{selectedModelLabel}</span>
                  <ChevronDownIcon className="size-3 opacity-65" />
                </PopoverTrigger>
                <PopoverContent className="w-44 p-2" align="start" side="top" sideOffset={8}>
                  <SelectOption active={tier === 'fast'} icon={ZapIcon} onClick={() => { onSelectTier('fast'); setModelOpen(false); }}>快速</SelectOption>
                  <SelectOption active={tier === 'premium'} icon={CrownIcon} onClick={() => { onSelectTier('premium'); setModelOpen(false); }}>高级</SelectOption>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {canInspectContext && contextUsagePct != null && (
                <button
                  type="button"
                  onClick={onOpenContext}
                  className={cn(CONTROL_CLASS, contextUsagePct >= 80 && 'text-amber-600 dark:text-amber-400')}
                  title={`查看上下文详情${contextUsageLabel ? ` · ${contextUsageLabel}` : ''}${compressHint ? ` · ${compressHint}` : ''}`}
                >
                  <GaugeIcon className="size-3.5" />
                  <span className="font-mono tabular-nums">{contextUsagePct === 0 ? '<1%' : `${contextUsagePct}%`}</span>
                </button>
              )}
              {busy ? (
                <button type="button" onClick={onStop} title="停止" aria-label="停止" className="inline-flex size-9 items-center justify-center rounded-md bg-foreground text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <SquareIcon className="size-3.5 fill-current" />
                </button>
              ) : (
                <button type="button" onClick={onSend} disabled={!input.trim()} title="发送" aria-label="发送" className="inline-flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40">
                  <ArrowUpIcon className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground/60">AI 生成内容可能有误，请在发布前检查</p>
      </div>
    </div>
  );
}
