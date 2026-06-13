import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from '../Info';
import type { AssistantSessionState } from '@/lib/plugin-draft';

export function SessionStatusPanel({ session }: { session: AssistantSessionState | null }) {
  if (!session) {
  return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">长任务</CardTitle>
        </CardHeader>
      </Card>
    );
  }
  const statusLabel: Record<AssistantSessionState['status'], string> = {
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    exited: '已结束',
    failed: '异常',
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">长任务</CardTitle>
        <CardDescription className="font-mono">{session.providerLabel} · {session.model === 'default' ? '默认模型' : session.model}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Info label="状态" value={statusLabel[session.status] || session.status} truncate />
          <Info label="退出码" value={session.exitCode === undefined ? '运行中' : session.exitCode === null ? '无' : String(session.exitCode)} truncate />
          <Info label="PID" value={session.pid ? String(session.pid) : '未返回'} />
          <Info label="Transcript" value={session.transcriptPath || '未返回'} />
        </div>
        <div className="space-y-1">
          <div className="font-medium">Session</div>
          <p className="break-all rounded-lg bg-muted p-2 font-mono text-xs text-muted-foreground">{session.sessionId}</p>
        </div>
        <div className="space-y-1">
          <div className="font-medium">命令</div>
          <p className="break-all rounded-lg bg-muted p-2 font-mono text-xs text-muted-foreground">{session.commandPreview.join(' ') || '未返回命令预览'}</p>
        </div>
        {(session.stdout || session.stderr) && (
          <div className="space-y-2">
            {session.stdout && <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono text-xs">{session.stdout}</pre>}
            {session.stderr && <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50 p-2 font-mono text-xs text-amber-900">{session.stderr}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}