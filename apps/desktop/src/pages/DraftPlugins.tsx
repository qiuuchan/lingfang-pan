import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DownloadIcon,
  EyeIcon,
  FileArchiveIcon,
  FileEditIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import {
  createDraftWorkspace,
  deleteLocalCreatorConversation,
  deleteDraftWorkspace,
  exportDraftWorkspace,
  importDraftWorkspace,
  listDraftWorkspaces,
  loadDraftWorkspacePlugin,
  publishDraftWorkspace,
  type TransferProgress,
  type Workspace,
} from '@/lib/plugin-registry';

export function DraftPlugins() {
  const { session, setRunningPlugin, setPendingDraftEdit, setCurrentDraft, setView } = useApp();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Workspace['diagnosticStatus']>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<TransferProgress | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setWorkspaces(await listDraftWorkspaces()); }
    catch (caught) { toast.error(errorMessage(caught, '草稿加载失败')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return workspaces.filter((workspace) => {
      const matchesQuery = !keyword || workspace.title.toLowerCase().includes(keyword) || workspace.manifestId.toLowerCase().includes(keyword);
      return matchesQuery && (status === 'all' || workspace.diagnosticStatus === status);
    });
  }, [query, status, workspaces]);

  const loadPlugin = async (workspace: Workspace) => {
    setBusy(workspace.workspaceId);
    try { return await loadDraftWorkspacePlugin(workspace); }
    finally { setBusy(''); }
  };

  const editWorkspace = async (workspace: Workspace) => {
    try {
      const plugin = await loadPlugin(workspace);
      setCurrentDraft({ id: plugin.id, status: 'ready', files: plugin.files || [], turns: [], diagnostics: [] });
      setPendingDraftEdit({ draft: plugin, turns: [] });
      setView('develop-plugins');
    } catch (caught) { toast.error(errorMessage(caught, '打开草稿失败')); }
  };

  const previewWorkspace = async (workspace: Workspace) => {
    try { setRunningPlugin(await loadPlugin(workspace)); }
    catch (caught) { toast.error(errorMessage(caught, '预览草稿失败')); }
  };

  const publishWorkspace = async (workspace: Workspace) => {
    setBusy(workspace.workspaceId);
    setProgress(null);
    try {
      const result = await publishDraftWorkspace(workspace, setProgress);
      toast.success(`已发布团队版本 v${result.release.version}`);
      await reload();
    } catch (caught) { toast.error(errorMessage(caught, '发布失败')); }
    finally { setBusy(''); setProgress(null); }
  };

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">草稿</h1><p className="text-sm text-muted-foreground">每条草稿对应一个可编辑插件工作区</p></div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}><UploadIcon />导入</Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}><PlusIcon />新建草稿</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1"><SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或 manifest ID" className="pl-9" /></div>
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem><SelectItem value="idle">未诊断</SelectItem><SelectItem value="ready">可发布</SelectItem><SelectItem value="warning">有警告</SelectItem><SelectItem value="error">有错误</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" title="刷新" onClick={() => void reload()}><RefreshCwIcon className={loading ? 'animate-spin' : ''} /></Button>
      </div>

      {progress && <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm">{progress.message || '正在发布制品'}{progress.total ? ` ${Math.round(progress.transferred / progress.total * 100)}%` : ''}</div>}

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground"><Loader2Icon className="mr-2 animate-spin" />正在加载草稿</div>
      ) : filtered.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground"><FileEditIcon className="size-5" />暂无符合条件的草稿</div>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((workspace) => (
            <div key={workspace.workspaceId} className="flex min-h-24 items-center gap-4 px-4 py-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"><FileArchiveIcon className="size-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{workspace.title}</span><Badge variant="outline">v{workspace.currentVersion}</Badge><DiagnosticBadge value={workspace.diagnosticStatus} /></div>
                <div className="mt-1 text-xs text-muted-foreground">{workspace.manifestId} · 更新于 {new Date(workspace.updatedAt).toLocaleString()}</div>
                {workspace.lastPublishedVersion && <div className="mt-1 text-xs text-emerald-600">最近发布 v{workspace.lastPublishedVersion}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon-sm" title="预览" disabled={busy === workspace.workspaceId} onClick={() => void previewWorkspace(workspace)}><EyeIcon /></Button>
                <Button variant="ghost" size="icon-sm" title="导出压缩包" onClick={async () => {
                  try { toast.success(`已导出到 ${await exportDraftWorkspace(workspace.workspaceId)}`); }
                  catch (caught) { toast.error(errorMessage(caught, '导出失败')); }
                }}><DownloadIcon /></Button>
                <Button variant="outline" size="sm" disabled={busy === workspace.workspaceId} onClick={() => void editWorkspace(workspace)}><FileEditIcon />继续编辑</Button>
                <Button size="sm" disabled={busy === workspace.workspaceId} onClick={() => void publishWorkspace(workspace)}>{busy === workspace.workspaceId ? <Loader2Icon className="animate-spin" /> : <SendIcon />}发布</Button>
                <Button variant="ghost" size="icon-sm" title="删除草稿" onClick={() => setDeleteTarget(workspace)}><Trash2Icon /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateWorkspaceDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (workspace) => { setCreateOpen(false); await reload(); await editWorkspace(workspace); }} />
      <ImportWorkspaceDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={async () => { setImportOpen(false); await reload(); }} />
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent><DialogHeader><DialogTitle>删除草稿？</DialogTitle><DialogDescription>只删除本地工作区和关联编辑记录，不影响已发布版本或已安装插件。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="destructive" onClick={async () => {
          if (!deleteTarget) return;
          try {
            await deleteDraftWorkspace(deleteTarget.workspaceId);
            deleteLocalCreatorConversation(deleteTarget.conversationId, session.userId, session.tenantId);
            toast.success('草稿已删除'); setDeleteTarget(null); await reload();
          }
          catch (caught) { toast.error(errorMessage(caught, '删除失败')); }
        }}><Trash2Icon />删除</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}

function DiagnosticBadge({ value }: { value: Workspace['diagnosticStatus'] }) {
  const label = { idle: '未诊断', checking: '诊断中', ready: '可发布', warning: '有警告', error: '有错误' }[value];
  return <Badge variant={value === 'error' ? 'destructive' : value === 'ready' ? 'secondary' : 'outline'}>{label}</Badge>;
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [title, setTitle] = useState(''); const [manifestId, setManifestId] = useState(''); const [runtime, setRuntime] = useState<'client' | 'nodejs' | 'python'>('client'); const [busy, setBusy] = useState(false);
  return <Dialog open={open} onOpenChange={(next) => !next && onClose()}><DialogContent><DialogHeader><DialogTitle>新建插件草稿</DialogTitle><DialogDescription>创建独立工作区后进入开发插件界面。</DialogDescription></DialogHeader><div className="grid gap-3"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="插件名称" /><Input value={manifestId} onChange={(event) => setManifestId(event.target.value)} placeholder="manifest ID，例如 team.demo" /><Select value={runtime} onValueChange={(value) => setRuntime(value as typeof runtime)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="client">网页插件</SelectItem><SelectItem value="python">Python</SelectItem><SelectItem value="nodejs">Node.js</SelectItem></SelectContent></Select></div><DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button disabled={busy || !title.trim() || !manifestId.trim()} onClick={async () => { setBusy(true); try { onCreated(await createDraftWorkspace({ title, manifestId, version: '0.1.0', runtime })); } catch (caught) { toast.error(errorMessage(caught, '创建失败')); } finally { setBusy(false); } }}>{busy && <Loader2Icon className="animate-spin" />}创建</Button></DialogFooter></DialogContent></Dialog>;
}

function ImportWorkspaceDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [path, setPath] = useState(''); const [busy, setBusy] = useState(false);
  return <Dialog open={open} onOpenChange={(next) => !next && onClose()}><DialogContent><DialogHeader><DialogTitle>导入草稿压缩包</DialogTitle><DialogDescription>选择本机 `.lfplugin` v4 文件路径，导入为可编辑工作区。</DialogDescription></DialogHeader><Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\path\\plugin.lfplugin" /><DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button disabled={busy || !path.trim()} onClick={async () => { setBusy(true); try { await importDraftWorkspace(path.trim()); toast.success('草稿已导入'); onImported(); } catch (caught) { toast.error(errorMessage(caught, '导入失败')); } finally { setBusy(false); } }}>{busy && <Loader2Icon className="animate-spin" />}导入</Button></DialogFooter></DialogContent></Dialog>;
}
