import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from '../Info';
import { capitalizeModel, type AssistantSessionState } from '@/lib/plugin-draft';

// 命令预览摘要：保留二进制名与所有 flags（--model/--output-format 等），
// 仅把 -p 后的超长 prompt/systemPrompt 内容截断为「<prompt …>」，避免面板被几 KB 文本占满。
function summarizeCommand(preview: string[]): string {
  if (!preview.length) return '无命令信息';
  const out: string[] = [];
  for (let i = 0; i < preview.length; i++) {
    const tok = preview[i];
    if (tok === '-p' || tok === '--print') {
      // 跳过下一个 token（prompt 正文），用占位符代替。
      out.push(tok, '<prompt…>');
      i += 1;
    } else if (tok.length > 80) {
      // 其他超长 token（理论上不应有）也截断。
      out.push(`${tok.slice(0, 40)}…${tok.slice(-8)}`);
    } else {
      out.push(tok);
    }
  }
  return out.join(' ');
}

export function SessionStatusPanel({ session }: { session: AssistantSessionState | null }) {
  if (!session) {
  return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">对话信息</CardTitle>
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
        <CardTitle className="text-base">对话信息</CardTitle>
        <CardDescription className="font-mono">{session.providerLabel} · {session.model === 'default' ? '默认模型' : capitalizeModel(session.model)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Info label="状态" value={statusLabel[session.status] || session.status} truncate />
          <Info label="运行结果" value={session.exitCode === undefined ? '运行中' : session.exitCode === null ? '无' : String(session.exitCode)} truncate />
          <Info label="进程号" value={session.pid ? String(session.pid) : '未提供'} />
          <Info label="记录" value={session.transcriptPath || '未提供'} />
        </div>
        <div className="space-y-1">
          <div className="font-medium">对话</div>
          <p className="break-all rounded-lg bg-muted p-2 font-mono text-xs text-muted-foreground">{session.sessionId}</p>
        </div>
        <div className="space-y-1">
          <div className="font-medium">命令</div>
          {/* 只展示二进制 + 关键 flags，隐藏 -p 后的超长 prompt/systemPrompt 内容（避免面板被占满） */}
          <p className="break-all rounded-lg bg-muted p-2 font-mono text-xs text-muted-foreground">{summarizeCommand(session.commandPreview)}</p>
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