import { describe, expect, it } from 'vitest';
import { normalizeBillingPage } from './admin-billing-data';

describe('normalizeBillingPage', () => {
  it('applies stable defaults and skip', () => {
    expect(normalizeBillingPage({})).toEqual({ page: 1, pageSize: 20, skip: 0, q: undefined });
    expect(normalizeBillingPage({ page: '3', pageSize: '25', q: ' model ' })).toEqual({ page: 3, pageSize: 25, skip: 50, q: 'model' });
  });

  it('bounds hostile or invalid pagination values', () => {
    expect(normalizeBillingPage({ page: '-2', pageSize: '1000' })).toMatchObject({ page: 1, pageSize: 100, skip: 0 });
    expect(normalizeBillingPage({ page: 'nope', pageSize: '0' })).toMatchObject({ page: 1, pageSize: 20 });
  });
});
