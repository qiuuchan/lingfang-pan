import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertActionValue } from './action-schema-validator';

const schema = { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 4 } } };

describe('assertActionValue', () => {
  it('accepts a value matching the restricted action schema', () => {
    expect(() => assertActionValue(schema, { prompt: 'hello', count: 2 }, 'input')).not.toThrow();
  });
  it('rejects missing, unknown and out-of-range fields with stable phase codes', () => {
    expect(() => assertActionValue(schema, { count: 2 }, 'input')).toThrow(/必填/);
    expect(() => assertActionValue(schema, { prompt: 'x', extra: true }, 'input')).toThrow(/不是允许字段/);
    try { assertActionValue(schema, { prompt: 'x', count: 8 }, 'output'); } catch (error) { expect(error).toMatchObject({ code: 'action_output_invalid' }); }
  });
});

describe('shared action adapter conformance fixtures', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../desktop/action-adapter-conformance/fixtures.json', import.meta.url), 'utf8')) as {
    input_schema: unknown;
    output_schema: unknown;
    cases: Array<{ id: string; input: unknown; expected_output?: unknown; expected_error?: string }>;
  };

  for (const fixture of fixtures.cases) {
    it(`uses authoritative restricted schemas for ${fixture.id}`, () => {
      if (fixture.id === 'bad_input' || fixture.id === 'bad_artifact') {
        try { assertActionValue(fixtures.input_schema, fixture.input, 'input'); }
        catch (error) { expect(error).toMatchObject({ code: fixture.expected_error }); return; }
        throw new Error(`${fixture.id} unexpectedly passed input validation`);
      }
      expect(() => assertActionValue(fixtures.input_schema, fixture.input, 'input')).not.toThrow();
      if (fixture.id === 'bad_output') {
        try { assertActionValue(fixtures.output_schema, { ok: 'yes', echoed: 'broken' }, 'output'); }
        catch (error) { expect(error).toMatchObject({ code: fixture.expected_error }); return; }
        throw new Error('bad_output unexpectedly passed output validation');
      }
      if (fixture.expected_output) expect(() => assertActionValue(fixtures.output_schema, fixture.expected_output, 'output')).not.toThrow();
    });
  }
});
