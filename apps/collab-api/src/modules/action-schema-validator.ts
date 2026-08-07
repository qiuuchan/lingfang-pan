import { AppError } from '../common';
import { ArtifactRefV1 } from '@lingfang/contract';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const invalid = (phase: 'input' | 'output', message: string): never => {
  throw new AppError(
    400,
    phase === 'input' ? 'action_input_invalid' : 'action_output_invalid',
    message
  );
};
export function assertActionValue(
  schema: unknown,
  value: unknown,
  phase: 'input' | 'output',
  path = '$'
): void {
  if (!isRecord(schema))
    throw new AppError(409, 'action_contract_mismatch', 'Action schema 不可用');
  if (schema.$ref === 'lingfang://schemas/artifact-ref/v1') {
    if (!ArtifactRefV1.safeParse(value).success) invalid(phase, `${path} 必须是 ArtifactRefV1`);
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value === 'number'
            ? 'number'
            : typeof value;
  if (!types.includes(actual) && !(actual === 'integer' && types.includes('number')))
    invalid(phase, `${path} 类型不符合 Action schema`);
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    invalid(phase, `${path} 不在允许值中`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value))
    invalid(phase, `${path} 不符合固定值`);
  if (
    typeof value === 'string' &&
    ((typeof schema.minLength === 'number' && value.length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && value.length > schema.maxLength))
  )
    invalid(phase, `${path} 字符串长度无效`);
  if (
    typeof value === 'number' &&
    ((typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum))
  )
    invalid(phase, `${path} 数值超出范围`);
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    )
      invalid(phase, `${path} 数组长度无效`);
    value.forEach((item, index) =>
      assertActionValue(schema.items, item, phase, `${path}/${index}`)
    );
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required)
      if (typeof key === 'string' && !(key in value)) invalid(phase, `${path}/${key} 为必填字段`);
    for (const [key, child] of Object.entries(value)) {
      if (!(key in properties)) invalid(phase, `${path}/${key} 不是允许字段`);
      assertActionValue(properties[key], child, phase, `${path}/${key}`);
    }
  }
}
