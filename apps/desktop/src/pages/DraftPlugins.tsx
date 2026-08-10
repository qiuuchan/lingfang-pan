import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DownloadIcon,
  EyeIcon,
  FileArchiveIcon,
  FileEditIcon,
  FileTextIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageCheckIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { Pagination } from '@/components/pagination';
import { PluginSourceBadge } from '@/components/plugins/PluginSourceBadge';
import { PublishPluginDialog } from '@/components/plugins/PublishPluginDialog';
import { PublishedPluginList } from '@/components/plugins/PublishedPluginList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api';
import { DEFAULT_PAGE_SIZE, paginateItems } from '@/lib/pagination';
import {
  createDraftWorkspace,
  deleteLocalCreatorConversation,
  deleteDraftWorkspace,
  exportDraftWorkspace,
  importDraftWorkspace,
  listDraftWorkspaces,
  loadDraftWorkspacePlugin,
  selectPluginArtifact,
  type Workspace,
} from '@/lib/plugin-registry';

type WorkspaceTab = 'local' | 'published';

const UPLOAD_AGREEMENT_KEY = 'lf:plugin-upload-agreement:v1';

function hasAcceptedUploadAgreement(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(UPLOAD_AGREEMENT_KEY) === 'accepted';
  } catch {
    return false;
  }
}

function acceptUploadAgreement(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UPLOAD_AGREEMENT_KEY, 'accepted');
  } catch {
    // ignore
  }
}

export function DraftPlugins() {
  const { session, setRunningPlugin, setPendingDraftEdit, setCurrentDraft, setView } = useApp();
  const [tab, setTab] = useState<WorkspaceTab>('local');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Workspace['diagnosticStatus']>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [artifactPublishOpen, setArtifactPublishOpen] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [publishWorkspace, setPublishWorkspace] = useState<Workspace | null>(null);
  const [publishedRefreshKey, setPublishedRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState('');

  const handleUploadClick = () => {
    if (hasAcceptedUploadAgreement()) {
      setArtifactPublishOpen(true);
    } else {
      setAgreementOpen(true);
    }
  };

  const handleAgreementAccept = () => {
    acceptUploadAgreement();
    setAgreementOpen(false);
    setArtifactPublishOpen(true);
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setWorkspaces(await listDraftWorkspaces());
    } catch (caught) {
      toast.error(errorMessage(caught, '草稿加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return workspaces.filter((workspace) => {
      const matchesQuery =
        !keyword ||
        workspace.title.toLowerCase().includes(keyword) ||
        workspace.manifestId.toLowerCase().includes(keyword);
      return matchesQuery && (status === 'all' || workspace.diagnosticStatus === status);
    });
  }, [query, status, workspaces]);

  const paged = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const loadPlugin = async (workspace: Workspace) => {
    setBusy(workspace.workspaceId);
    try {
      return await loadDraftWorkspacePlugin(workspace);
    } finally {
      setBusy('');
    }
  };

  const editWorkspace = async (workspace: Workspace) => {
    try {
      const plugin = await loadPlugin(workspace);
      setCurrentDraft({
        id: plugin.id,
        status: 'ready',
        files: plugin.files || [],
        turns: [],
        diagnostics: [],
      });
      setPendingDraftEdit({ draft: plugin, turns: [] });
      setView('develop-plugins');
    } catch (caught) {
      toast.error(errorMessage(caught, '打开草稿失败'));
    }
  };

  const previewWorkspace = async (workspace: Workspace) => {
    try {
      setRunningPlugin(await loadPlugin(workspace));
    } catch (caught) {
      toast.error(errorMessage(caught, '预览草稿失败'));
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">插件开发</h1>
          <p className="text-sm text-muted-foreground">本地工作区与团队发布治理共用一个工作台</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleUploadClick()}>
            <UploadIcon />
            上传本地插件
          </Button>
          {tab === 'local' && (
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FolderOpenIcon />
              导入为草稿
            </Button>
          )}
          {tab === 'local' && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              新建草稿
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as WorkspaceTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="local">
            <FileEditIcon />
            本地草稿
          </TabsTrigger>
          <TabsTrigger value="published">
            <PackageCheckIcon />
            已发布
          </TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索名称或 manifest ID"
                className="pl-9"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as typeof status);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="idle">未诊断</SelectItem>
                <SelectItem value="ready">可发布</SelectItem>
                <SelectItem value="warning">有警告</SelectItem>
                <SelectItem value="error">有错误</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" title="刷新" onClick={() => void reload()}>
              <RefreshCwIcon className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>

          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2Icon className="mr-2 animate-spin" />
              正在加载草稿
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
              <FileEditIcon className="size-5" />
              暂无符合条件的草稿
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {paged.items.map((workspace) => (
                <div
                  key={workspace.workspaceId}
                  className="flex min-h-24 items-center gap-4 px-4 py-3"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <FileArchiveIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{workspace.title}</span>
                      <Badge variant="outline">v{workspace.currentVersion}</Badge>
                      <DiagnosticBadge value={workspace.diagnosticStatus} />
                      <PluginSourceBadge
                        sourceKind={workspace.sourceKind}
                        sourceLabel={workspace.sourceLabel}
                      />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {workspace.manifestId} · 更新于{' '}
                      {new Date(workspace.updatedAt).toLocaleString()}
                    </div>
                    {workspace.lastPublishedVersion && (
                      <div className="mt-1 text-xs text-success">
                        最近发布 v{workspace.lastPublishedVersion}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="预览"
                      disabled={busy === workspace.workspaceId}
                      onClick={() => void previewWorkspace(workspace)}
                    >
                      <EyeIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="导出压缩包"
                      onClick={async () => {
                        try {
                          toast.success(
                            `已导出到 ${await exportDraftWorkspace(workspace.workspaceId)}`
                          );
                        } catch (caught) {
                          toast.error(errorMessage(caught, '导出失败'));
                        }
                      }}
                    >
                      <DownloadIcon />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === workspace.workspaceId}
                      onClick={() => void editWorkspace(workspace)}
                    >
                      <FileEditIcon />
                      继续编辑
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy === workspace.workspaceId}
                      onClick={() => setPublishWorkspace(workspace)}
                    >
                      <SendIcon />
                      发布
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除草稿"
                      onClick={() => setDeleteTarget(workspace)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && (
            <Pagination
              page={paged.currentPage}
              totalPages={paged.totalPages}
              total={paged.total}
              pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="published">
          <PublishedPluginList refreshKey={publishedRefreshKey} />
        </TabsContent>
      </Tabs>

      <CreateWorkspaceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (workspace) => {
          setCreateOpen(false);
          await reload();
          await editWorkspace(workspace);
        }}
      />
      <ImportWorkspaceDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async () => {
          setImportOpen(false);
          await reload();
        }}
      />
      <PublishPluginDialog
        open={Boolean(publishWorkspace)}
        onOpenChange={(open) => !open && setPublishWorkspace(null)}
        workspace={publishWorkspace}
        defaultSourceKind={publishWorkspace?.sourceKind}
        defaultSourceLabel={publishWorkspace?.sourceLabel}
        onPublished={async () => {
          toast.success('插件版本已发布');
          setPublishedRefreshKey((value) => value + 1);
          await reload();
        }}
      />
      <PublishPluginDialog
        open={artifactPublishOpen}
        onOpenChange={setArtifactPublishOpen}
        defaultSourceKind="EXTERNAL_TOOL"
        defaultSourceLabel="外部开发工具"
        onPublished={() => {
          toast.success('本地插件已发布');
          setPublishedRefreshKey((value) => value + 1);
          setTab('published');
        }}
      />
      <UploadAgreementDialog
        open={agreementOpen}
        onClose={() => setAgreementOpen(false)}
        onAccept={handleAgreementAccept}
      />
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除草稿？</DialogTitle>
            <DialogDescription>
              只删除本地工作区和关联编辑记录，不影响已发布版本或已安装插件。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await deleteDraftWorkspace(deleteTarget.workspaceId);
                  deleteLocalCreatorConversation(
                    deleteTarget.conversationId,
                    session.userId,
                    session.tenantId
                  );
                  toast.success('草稿已删除');
                  setDeleteTarget(null);
                  await reload();
                } catch (caught) {
                  toast.error(errorMessage(caught, '删除失败'));
                }
              }}
            >
              <Trash2Icon />
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DiagnosticBadge({ value }: { value: Workspace['diagnosticStatus'] }) {
  const label = {
    idle: '未诊断',
    checking: '诊断中',
    ready: '可发布',
    warning: '有警告',
    error: '有错误',
  }[value];
  return (
    <Badge
      variant={value === 'error' ? 'destructive' : value === 'ready' ? 'secondary' : 'outline'}
    >
      {label}
    </Badge>
  );
}

function CreateWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}) {
  const [title, setTitle] = useState('');
  const [manifestId, setManifestId] = useState('');
  const [runtime, setRuntime] = useState<'client' | 'cloud' | 'nodejs' | 'python'>('client');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建插件草稿</DialogTitle>
          <DialogDescription>创建独立工作区后进入开发插件界面。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="插件名称"
          />
          <Input
            value={manifestId}
            onChange={(event) => setManifestId(event.target.value)}
            placeholder="manifest ID，例如 team.demo"
          />
          <Select value={runtime} onValueChange={(value) => setRuntime(value as typeof runtime)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="client">网页插件</SelectItem>
              <SelectItem value="cloud">云端插件</SelectItem>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="nodejs">Node.js</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !title.trim() || !manifestId.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                onCreated(
                  await createDraftWorkspace({
                    title,
                    manifestId,
                    version: '0.1.0',
                    runtime,
                    sourceKind: 'LINGFANG_CREATOR',
                    sourceLabel: '灵枋创建器',
                  })
                );
              } catch (caught) {
                toast.error(errorMessage(caught, '创建失败'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportWorkspaceDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    try {
      const selected = await selectPluginArtifact();
      if (selected) setPath(selected);
    } catch (caught) {
      toast.error(errorMessage(caught, '选择插件制品失败'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入草稿压缩包</DialogTitle>
          <DialogDescription>
            选择本机 `.lfplugin` v4 文件，导入为可编辑工作区。开发环境可使用路径输入回退。
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="选择 .lfplugin 文件"
          />
          <Button variant="outline" size="icon" title="选择插件制品" onClick={() => void choose()}>
            <FolderOpenIcon />
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !path.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await importDraftWorkspace(path.trim());
                toast.success('草稿已导入');
                onImported();
              } catch (caught) {
                toast.error(errorMessage(caught, '导入失败'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadAgreementDialog({
  open,
  onClose,
  onAccept,
}: {
  open: boolean;
  onClose: () => void;
  onAccept: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileTextIcon className="size-4" />
            灵坊承载插件适用细则
          </DialogTitle>
          <DialogDescription>
            在将插件上传至灵坊平台前，请确认你已阅读并理解以下条款。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm leading-relaxed text-foreground">
          <p>
            你即将上传的插件将由<strong>灵坊平台承载</strong>，包括但不限于：存储、解析、运行、展示、分发及必要的安全扫描。
          </p>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              <strong>授权范围</strong>：你保留插件的著作权，但授予灵坊为实现平台功能所必需的复制、传输、执行、展示及向授权用户分发的权利。
            </li>
            <li>
              <strong>禁止内容</strong>：不得上传含有恶意代码、病毒、蠕虫、后门，或用于网络攻击、数据窃取、欺诈、骚扰、侵权、洗钱及其他违法违规用途的插件。
            </li>
            <li>
              <strong>第三方权益</strong>：你应确保插件不侵犯任何第三方的知识产权、肖像权、隐私权或其他合法权益；若引发纠纷，由你自行承担法律责任。
            </li>
            <li>
              <strong>平台治理</strong>：灵坊有权依据安全扫描、用户投诉、合规审查等结果，对插件进行审核、下架、限制传播或终止服务，无需事先征得你的同意。
            </li>
            <li>
              <strong>责任边界</strong>：灵坊仅提供插件承载与分发能力，不对插件具体功能、运行结果或由此产生的直接或间接损失承担责任。
            </li>
            <li>
              <strong>变更与通知</strong>：灵坊可适时修订本细则；继续使用上传功能即视为接受修订后的条款。
            </li>
          </ol>

          <div className="rounded-lg border bg-muted/20 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 font-medium">
              <FileTextIcon className="size-4" />
              技术承载要求
            </h4>
            <p className="mb-2 text-xs text-muted-foreground">
              灵坊对承载插件有明确技术边界，不是所有项目都能直接运行。上传前请确认插件满足以下要求：
            </p>
            <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
              <li>
                <strong>插件格式</strong>：必须是灵坊 v4 插件制品（<code>.lfplugin</code>），推荐使用 SDK CLI（<code>lingfang-plugin build</code>）构建；直接手工压缩的 zip 不会被识别为合法制品。
              </li>
              <li>
                <strong>manifest.json</strong>：必须包含合法字段，包括 <code>id</code>（英文字母开头，仅含字母/数字/点/下划线/连字符）、<code>name</code>、严格 SemVer 格式的 <code>version</code>、<code>runtime_type</code>、<code>entry</code> 入口路径，以及符合规范的 <code>capabilities</code> 能力声明。
              </li>
              <li>
                <strong>受支持的运行时</strong>：目前仅支持 <code>client</code>（前端 UI / iframe）、<code>nodejs</code>、<code>python</code>、<code>cloud</code>、<code>workflow</code>；运行时类型、入口文件扩展名与实际代码必须一致。
              </li>
              <li>
                <strong>能力声明</strong>：插件代码中实际调用的平台能力（如 <code>llm.chat</code>、<code>net.fetch</code>、<code>fs.write</code> 等）必须在 manifest 的 <code>capabilities</code> 中显式声明；未声明的能力在运行时被能力网关拒绝。
              </li>
              <li>
                <strong>隔离与安全边界</strong>：插件不得直接连接第三方 AI 服务、不得硬编码 API 密钥 / base_url / provider / 真实模型名，所有越权操作必须通过灵坊宿主桥（<code>window.__lingfangInvoke</code> 或脚本桥）中转。
              </li>
              <li>
                <strong>可见性</strong>：上传时 manifest 的 <code>visibility</code> 只允许 <code>private</code> 或 <code>tenant</code>；公开上架需经过平台市场审核流程。
              </li>
              <li>
                <strong>适配校验</strong>：建议在上传前通过桌面端「适配校验并打包」或 SDK CLI（<code>lingfang-plugin adapt</code>）完成静态校验与确定性改造；存在无法自动修复的问题时，需人工处理后再上传。
              </li>
              <li>
                <strong>技术拒绝</strong>：不符合上述技术边界、无法通过安全扫描或运行时确证的插件，灵坊有权拒绝上传、发布或运行。
              </li>
            </ol>
          </div>

          <p className="text-xs text-muted-foreground">
            点击"同意并继续"即表示你同意遵守上述细则。如不同意，请勿上传插件。
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3">
          <input
            id="upload-agreement-checkbox"
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
          />
          <label
            htmlFor="upload-agreement-checkbox"
            className="cursor-pointer text-xs leading-5 text-muted-foreground"
          >
            我已阅读并同意《灵坊承载插件适用细则》
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onAccept} disabled={!accepted}>
            同意并继续
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
