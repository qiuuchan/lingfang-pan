import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type FixtureCase = {
  id: string;
  input: Record<string, unknown>;
  expected_output?: Record<string, unknown>;
  expected_error?: string;
};

type Fixtures = {
  cases: FixtureCase[];
};

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Fixtures;
const cases = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));

const handlerSource = `
export async function run(input) {
  switch (input.mode) {
    case 'good':
    case 'base':
      return { ok: true, echoed: input.message };
    case 'artifact':
      return { ok: true, echoed: input.message, artifact: input.artifact };
    case 'bad_output':
      return 'not-an-object';
    case 'handler_error':
      throw new Error('fixture handler failed');
    case 'timeout':
    case 'cancel':
      return await new Promise(() => {});
    default:
      throw new Error('unknown fixture mode');
  }
}
`;

function fixture(id: string): FixtureCase {
  const value = cases.get(id);
  if (!value) throw new Error(`Missing action adapter fixture: ${id}`);
  return value;
}

async function executeInBrowser(
  page: Page,
  selected: FixtureCase,
  options: { timeoutMs?: number; cancelAfterMs?: number } = {},
) {
  return page.evaluate(async ({ input, source, timeoutMs, cancelAfterMs }) => {
    const { executeClientActionAdapter } = await import('/src/lib/plugin-action-client-adapter.ts');
    const controller = cancelAfterMs === undefined ? undefined : new AbortController();
    if (controller) window.setTimeout(() => controller.abort(), cancelAfterMs);
    try {
      const output = await executeClientActionAdapter({
        invocationId: crypto.randomUUID(),
        source,
        exportName: 'run',
        input,
        timeoutMs,
        signal: controller?.signal,
        onCapability: async () => { throw new Error('fixture handler must not call host capabilities'); },
      });
      return { output, errorCode: null, errorMessage: null, remainingFrames: document.querySelectorAll('iframe').length };
    } catch (error) {
      return {
        output: null,
        errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : null,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : null,
        remainingFrames: document.querySelectorAll('iframe').length,
      };
    }
  }, {
    input: selected.input,
    source: handlerSource,
    timeoutMs: options.timeoutMs ?? 1_000,
    cancelAfterMs: options.cancelAfterMs,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/action-adapter-conformance/harness.html');
});

for (const id of ['good', 'base', 'artifact']) {
  test(`executes the ${id} fixture in a real opaque sandbox iframe`, async ({ page }) => {
    const selected = fixture(id);
    const result = await executeInBrowser(page, selected);
    expect(result.errorMessage, result.errorStack ?? undefined).toBeNull();
    expect(result.errorCode, result.errorMessage ?? undefined).toBeNull();
    expect(result.output).toEqual(selected.expected_output);
    expect(result.remainingFrames).toBe(0);
  });
}

for (const id of ['bad_output', 'handler_error']) {
  test(`returns the stable ${fixture(id).expected_error} code for ${id}`, async ({ page }) => {
    const selected = fixture(id);
    const result = await executeInBrowser(page, selected);
    expect(result.errorCode).toBe(selected.expected_error);
    expect(result.remainingFrames).toBe(0);
  });
}

test('returns action_timeout and tears down the pending sandbox', async ({ page }) => {
  const selected = fixture('timeout');
  const result = await executeInBrowser(page, selected, { timeoutMs: 30 });
  expect(result.errorCode).toBe(selected.expected_error);
  expect(result.remainingFrames).toBe(0);
});

test('honors AbortSignal with action_cancelled and tears down the pending sandbox', async ({ page }) => {
  const selected = fixture('cancel');
  const result = await executeInBrowser(page, selected, { timeoutMs: 5_000, cancelAfterMs: 30 });
  expect(result.errorCode).toBe(selected.expected_error);
  expect(result.remainingFrames).toBe(0);
});
