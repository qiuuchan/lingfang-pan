import { useEffect, useState } from 'react';
import type { PortableJsonSchemaNode } from '@lingfang/contract';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  initialWorkflowInput,
  setWorkflowInputValue,
  type WorkflowInputIssue,
} from '@/lib/workflow-runtime';

type Props = {
  schema: PortableJsonSchemaNode;
  value: unknown;
  issues: WorkflowInputIssue[];
  disabled?: boolean;
  onChange: (value: unknown) => void;
};

function typeOf(schema: PortableJsonSchemaNode): string | undefined {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.find((item) => item !== 'null');
}

function pointer(path: string[]): string {
  return path.length ? `/${path.join('/')}` : '/';
}

function dateTimeLocalValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function FieldIssues({ issues, path }: { issues: WorkflowInputIssue[]; path: string[] }) {
  const exact = issues.filter((issue) => issue.path === pointer(path));
  if (!exact.length) return null;
  return (
    <FieldError className="flex flex-col gap-0.5 text-xs">
      {exact.map((issue, index) => (
        <p key={`${issue.path}-${index}`}>{issue.message}</p>
      ))}
    </FieldError>
  );
}

function JsonField({
  value,
  onChange,
  disabled,
  artifact,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  artifact?: boolean;
}) {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2)
  );
  const [error, setError] = useState('');
  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value, null, 2));
  }, [value]);
  const commit = () => {
    try {
      onChange(JSON.parse(text));
      setError('');
    } catch {
      setError('请输入有效 JSON');
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={text}
        disabled={disabled}
        rows={artifact ? 9 : 5}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={artifact ? '{\n  "type": "artifact_ref",\n  ...\n}' : '[]'}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  value,
  path,
  required,
  issues,
  disabled,
  onChange,
}: {
  name: string;
  schema: PortableJsonSchemaNode;
  value: unknown;
  path: string[];
  required: boolean;
  issues: WorkflowInputIssue[];
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const type = typeOf(schema);
  const controlId = `workflow-${path.join('-')}`;
  if (!required && value === undefined) {
    return (
      <Field
        orientation="horizontal"
        className="justify-between gap-3 rounded-lg border border-dashed p-3"
      >
        <div className="flex flex-col gap-0.5">
          <FieldLabel>{name}</FieldLabel>
          <FieldDescription className="text-xs">可选 · {type || 'JSON'}</FieldDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(initialWorkflowInput(schema))}
        >
          <PlusIcon className="size-3.5" />
          填写
        </Button>
      </Field>
    );
  }

  const removable = !required;
  const heading = (
    <div className="flex items-center justify-between gap-2">
      <FieldLabel htmlFor={controlId}>
        {name}
        {required && <span className="ml-1 text-destructive">*</span>}
      </FieldLabel>
      {removable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(undefined)}
        >
          <Trash2Icon className="size-3.5" />
          清除
        </Button>
      )}
    </div>
  );

  if (schema.$ref) {
    return (
      <Field>
        {heading}
        <FieldDescription className="text-xs">
          ArtifactRef（仅填写平台返回的引用，不粘贴二进制正文）
        </FieldDescription>
        <JsonField artifact value={value} disabled={disabled} onChange={onChange} />
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  if ('const' in schema) {
    return (
      <Field>
        {heading}
        <pre className="overflow-auto rounded-md border bg-muted/50 p-2 text-xs">
          {JSON.stringify(schema.const, null, 2)}
        </pre>
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  if (schema.enum?.length) {
    return (
      <Field>
        {heading}
        <Select
          value={JSON.stringify(value)}
          disabled={disabled}
          onValueChange={(next) => {
            if (next != null) onChange(JSON.parse(next));
          }}
        >
          <SelectTrigger id={controlId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schema.enum.map((item, index) => (
              <SelectItem key={index} value={JSON.stringify(item)}>
                {typeof item === 'string' ? item : JSON.stringify(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  if (type === 'object') {
    const record =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const requiredChildren = new Set(schema.required ?? []);
    return (
      <fieldset className="space-y-3 rounded-lg border p-3" disabled={disabled}>
        <legend className="px-1 text-sm font-medium">
          {name}
          {required && <span className="ml-1 text-destructive">*</span>}
        </legend>
        <FieldGroup className="gap-3">
          {Object.entries(schema.properties ?? {}).map(([childName, childSchema]) => (
            <SchemaField
              key={childName}
              name={childName}
              schema={childSchema}
              value={record[childName]}
              path={[...path, childName]}
              required={requiredChildren.has(childName)}
              issues={issues}
              disabled={disabled}
              onChange={(next) => onChange(setWorkflowInputValue(record, [childName], next))}
            />
          ))}
          <FieldIssues issues={issues} path={path} />
        </FieldGroup>
      </fieldset>
    );
  }
  if (type === 'array') {
    return (
      <Field>
        {heading}
        <JsonField value={value} disabled={disabled} onChange={onChange} />
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  if (type === 'boolean') {
    return (
      <Field>
        <Field orientation="horizontal">
          <Checkbox
            id={controlId}
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(Boolean(checked))}
          />
          <FieldLabel htmlFor={controlId}>
            {name}
            {required && <span className="ml-1 text-destructive">*</span>}
          </FieldLabel>
        </Field>
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <Field>
        {heading}
        <Input
          id={controlId}
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={schema.minimum}
          max={schema.maximum}
          step={type === 'integer' ? 1 : (schema.multipleOf ?? 'any')}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
        <FieldIssues issues={issues} path={path} />
      </Field>
    );
  }
  return (
    <Field>
      {heading}
      <Input
        id={controlId}
        type={schema.format === 'date-time' ? 'datetime-local' : 'text'}
        value={
          schema.format === 'date-time'
            ? dateTimeLocalValue(value)
            : typeof value === 'string'
              ? value
              : ''
        }
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            schema.format === 'date-time' && event.target.value
              ? new Date(event.target.value).toISOString()
              : event.target.value
          )
        }
      />
      <FieldIssues issues={issues} path={path} />
    </Field>
  );
}

export function WorkflowInputForm({ schema, value, issues, disabled, onChange }: Props) {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  if (!properties.length)
    return (
      <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        此工作流不需要输入参数。
      </p>
    );
  return (
    <FieldGroup className="gap-4">
      {properties.map(([name, childSchema]) => (
        <SchemaField
          key={name}
          name={name}
          schema={childSchema}
          value={record[name]}
          path={[name]}
          required={required.has(name)}
          issues={issues}
          disabled={disabled}
          onChange={(next) => onChange(setWorkflowInputValue(record, [name], next))}
        />
      ))}
      <FieldIssues issues={issues} path={[]} />
    </FieldGroup>
  );
}
