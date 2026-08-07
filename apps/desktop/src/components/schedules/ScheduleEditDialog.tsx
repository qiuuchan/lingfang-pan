// ScheduleEditDialog.tsx —— 本地定时任务的新建/编辑对话框（PRD R4）。
//
// 字段：
// - 名称（所有类型）
// - 类型选择（AGENT_PROMPT / PLUGIN_ACTION / NOTIFY）
// - 触发器选择（ONCE / CRON）
//   · ONCE：日期时间选择
//   · CRON：cron 表达式 + 时区（默认系统时区）
// - payload 编辑（按类型切换）：
//   · AGENT_PROMPT：prompt 文本框（最多 10000 字符）
//   · PLUGIN_ACTION：plugin_id / action / input (JSON)
//   · NOTIFY：title / body
// - timeout_ms（默认 30 分钟）
//
// 编辑模式（editing != null）：预填字段，调 schedulerUpdate。
// 新建模式（editing == null）：字段清空，调 schedulerCreate。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BotIcon, PackageIcon, BellIcon, ClockIcon, CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { schedulerCreate, schedulerUpdate } from '@/lib/local-scheduler';
import {
  LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT,
  LOCAL_SCHEDULE_TIMEOUT_MS_MIN,
  LOCAL_SCHEDULE_TIMEOUT_MS_MAX,
} from '@lingfang/contract';
import type {
  LocalSchedule,
  LocalScheduleTrigger,
  LocalTaskPayload,
  LocalTaskType,
  WorkflowJsonValue,
} from '@lingfang/contract';

interface Props {
  open: boolean;
  editing: LocalSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}

const SYSTEM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function ScheduleEditDialog({ open, editing, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<LocalTaskType>('AGENT_PROMPT');
  const [triggerKind, setTriggerKind] = useState<'ONCE' | 'CRON'>('CRON');
  // ONCE 触发：用 datetime-local 字符串（ yyyy-MM-ddTHH:mm ）。
  const [runAtLocal, setRunAtLocal] = useState('');
  // CRON 触发。
  const [cron, setCron] = useState('0 9 * * *');
  const [timeZone, setTimeZone] = useState(SYSTEM_TIMEZONE);
  // payload 字段。
  const [prompt, setPrompt] = useState('');
  const [pluginId, setPluginId] = useState('');
  const [action, setAction] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyBody, setNotifyBody] = useState('');
  const [timeoutMin, setTimeoutMin] = useState(LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT / 60_000);
  const [saving, setSaving] = useState(false);

  // open 或 editing 变化时同步字段。
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setTaskType(editing.payload.type);
      setTriggerKind(editing.trigger.kind);
      if (editing.trigger.kind === 'ONCE') {
        setRunAtLocal(isoToLocalDatetime(editing.trigger.run_at));
      } else {
        setCron(editing.trigger.cron);
        setTimeZone(editing.trigger.time_zone);
      }
      if (editing.payload.type === 'AGENT_PROMPT') setPrompt(editing.payload.prompt);
      else if (editing.payload.type === 'PLUGIN_ACTION') {
        setPluginId(editing.payload.plugin_id);
        setAction(editing.payload.action);
        setInputJson(JSON.stringify(editing.payload.input, null, 2));
      } else {
        setNotifyTitle(editing.payload.title);
        setNotifyBody(editing.payload.body);
      }
      setTimeoutMin(Math.round(editing.timeout_ms / 60_000));
    } else {
      // 新建默认值。
      setName('');
      setTaskType('AGENT_PROMPT');
      setTriggerKind('CRON');
      setRunAtLocal('');
      setCron('0 9 * * *');
      setTimeZone(SYSTEM_TIMEZONE);
      setPrompt('');
      setPluginId('');
      setAction('');
      setInputJson('{}');
      setNotifyTitle('');
      setNotifyBody('');
      setTimeoutMin(LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT / 60_000);
    }
  }, [open, editing]);

  async function onSave() {
    // 基本校验。
    if (!name.trim()) return toast.error('请填写任务名称');
    if (triggerKind === 'ONCE' && !runAtLocal) return toast.error('请选择触发时间');
    if (triggerKind === 'CRON' && !cron.trim()) return toast.error('请填写 cron 表达式');

    let trigger: LocalScheduleTrigger;
    if (triggerKind === 'ONCE') {
      const iso = localDatetimeToIso(runAtLocal);
      if (!iso) return toast.error('触发时间格式无效');
      trigger = { kind: 'ONCE', run_at: iso };
    } else {
      trigger = { kind: 'CRON', cron: cron.trim(), time_zone: timeZone };
    }

    let payload: LocalTaskPayload;
    if (taskType === 'AGENT_PROMPT') {
      if (!prompt.trim()) return toast.error('请填写 prompt');
      if (prompt.length > 10000) return toast.error('prompt 超过 10000 字符上限');
      payload = { type: 'AGENT_PROMPT', prompt };
    } else if (taskType === 'PLUGIN_ACTION') {
      if (!pluginId.trim() || !action.trim()) return toast.error('请填写 plugin_id 和 action');
      let parsed: unknown;
      try {
        parsed = JSON.parse(inputJson);
      } catch {
        return toast.error('input 不是有效的 JSON');
      }
      payload = {
        type: 'PLUGIN_ACTION',
        plugin_id: pluginId.trim(),
        action: action.trim(),
        input: parsed as WorkflowJsonValue,
      };
    } else {
      if (!notifyTitle.trim()) return toast.error('请填写通知标题');
      payload = { type: 'NOTIFY', title: notifyTitle.trim(), body: notifyBody };
    }

    const timeoutMs = Math.max(
      LOCAL_SCHEDULE_TIMEOUT_MS_MIN,
      Math.min(LOCAL_SCHEDULE_TIMEOUT_MS_MAX, Math.round(timeoutMin * 60_000))
    );

    setSaving(true);
    try {
      if (editing) {
        await schedulerUpdate(editing.id, {
          name: name.trim(),
          trigger,
          payload,
          timeout_ms: timeoutMs,
        });
        toast.success('已保存');
      } else {
        await schedulerCreate({
          name: name.trim(),
          trigger,
          payload,
          timeout_ms: timeoutMs,
          status: 'ACTIVE',
        });
        toast.success('已创建');
      }
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e, editing ? '保存失败' : '创建失败'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] w-[92vw] max-w-2xl flex-col gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
          <DialogDescription>配置触发规则与执行内容；任务仅在应用运行时触发</DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          {/* 名称 */}
          <Field className="gap-1.5">
            <FieldLabel htmlFor="schedule-name" className="text-xs font-medium">
              任务名称
            </FieldLabel>
            <Input
              id="schedule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：每日早报生成"
              maxLength={100}
            />
          </Field>

          {/* 类型 */}
          <Field className="gap-1.5">
            <FieldLabel htmlFor="schedule-task-type" className="text-xs font-medium">
              执行类型
            </FieldLabel>
            <Select value={taskType} onValueChange={(v) => setTaskType(v as LocalTaskType)}>
              <SelectTrigger id="schedule-task-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AGENT_PROMPT">
                  <span className="flex items-center gap-2">
                    <BotIcon className="size-4" />
                    Agent Prompt（跑一段 Agent 对话）
                  </span>
                </SelectItem>
                <SelectItem value="PLUGIN_ACTION">
                  <span className="flex items-center gap-2">
                    <PackageIcon className="size-4" />
                    插件 Action（调用插件能力）
                  </span>
                </SelectItem>
                <SelectItem value="NOTIFY">
                  <span className="flex items-center gap-2">
                    <BellIcon className="size-4" />
                    系统通知（仅发提醒）
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* 触发器 */}
          <Field className="gap-1.5">
            <FieldLabel htmlFor="schedule-trigger-kind" className="text-xs font-medium">
              触发规则
            </FieldLabel>
            <Select value={triggerKind} onValueChange={(v) => setTriggerKind(v as 'ONCE' | 'CRON')}>
              <SelectTrigger id="schedule-trigger-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CRON">
                  <span className="flex items-center gap-2">
                    <ClockIcon className="size-4" />
                    周期触发（cron 表达式）
                  </span>
                </SelectItem>
                <SelectItem value="ONCE">
                  <span className="flex items-center gap-2">
                    <CalendarIcon className="size-4" />
                    一次性触发
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {triggerKind === 'ONCE' ? (
            <Field className="gap-1.5">
              <FieldLabel htmlFor="schedule-run-at" className="text-xs font-medium">
                触发时间
              </FieldLabel>
              <Input
                id="schedule-run-at"
                type="datetime-local"
                value={runAtLocal}
                onChange={(e) => setRunAtLocal(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-cron" className="text-xs font-medium">
                  cron 表达式
                </FieldLabel>
                <Input
                  id="schedule-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * *"
                  className="font-mono"
                />
                <FieldDescription className="text-xs">
                  5 字段：分 时 日 月 周（如每天 9 点：0 9 * * *）
                </FieldDescription>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-time-zone" className="text-xs font-medium">
                  时区
                </FieldLabel>
                <Input
                  id="schedule-time-zone"
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                />
                <FieldDescription className="text-xs">IANA 时区名，默认系统时区</FieldDescription>
              </Field>
            </>
          )}

          {/* payload 按类型切换 */}
          {taskType === 'AGENT_PROMPT' && (
            <Field className="gap-1.5">
              <FieldLabel htmlFor="schedule-prompt" className="text-xs font-medium">
                Prompt
              </FieldLabel>
              <Textarea
                id="schedule-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="如：生成本周工作日报，输出 Markdown 格式摘要"
                rows={6}
                maxLength={10000}
                className="resize-y"
              />
              <FieldDescription className="text-xs">
                {`Agent 任务指令，最多 10000 字符（当前 ${prompt.length}）`}
              </FieldDescription>
            </Field>
          )}
          {taskType === 'PLUGIN_ACTION' && (
            <>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-plugin-id" className="text-xs font-medium">
                  插件 ID
                </FieldLabel>
                <Input
                  id="schedule-plugin-id"
                  value={pluginId}
                  onChange={(e) => setPluginId(e.target.value)}
                  placeholder="plugin id"
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-action" className="text-xs font-medium">
                  Action 名
                </FieldLabel>
                <Input
                  id="schedule-action"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  placeholder="action name"
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-input-json" className="text-xs font-medium">
                  入参（JSON）
                </FieldLabel>
                <Textarea
                  id="schedule-input-json"
                  value={inputJson}
                  onChange={(e) => setInputJson(e.target.value)}
                  rows={4}
                  className="resize-y font-mono"
                />
              </Field>
            </>
          )}
          {taskType === 'NOTIFY' && (
            <>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-notify-title" className="text-xs font-medium">
                  通知标题
                </FieldLabel>
                <Input
                  id="schedule-notify-title"
                  value={notifyTitle}
                  onChange={(e) => setNotifyTitle(e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="schedule-notify-body" className="text-xs font-medium">
                  通知正文
                </FieldLabel>
                <Textarea
                  id="schedule-notify-body"
                  value={notifyBody}
                  onChange={(e) => setNotifyBody(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="resize-y"
                />
              </Field>
            </>
          )}

          {/* timeout */}
          {/* *:data-[slot=input-group]:w-32 保住原来的窄输入框宽度（Field 默认给子元素 w-full）。 */}
          <Field className="gap-1.5 *:data-[slot=input-group]:w-32">
            <FieldLabel htmlFor="schedule-timeout" className="text-xs font-medium">
              单次执行超时
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="schedule-timeout"
                type="number"
                min={1}
                max={60}
                value={timeoutMin}
                onChange={(e) => setTimeoutMin(Number(e.target.value) || 30)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>分钟</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription className="text-xs">范围 1-60 分钟，默认 30</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? '保存中…' : editing ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** datetime-local 字符串 → ISO（UTC）。 */
function localDatetimeToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** ISO → datetime-local 字符串（按系统时区）。 */
function isoToLocalDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    // toLocaleString 拆分得到 yyyy-MM-ddTHH:mm（datetime-local 格式）。
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}
