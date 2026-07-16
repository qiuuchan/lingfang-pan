import { describe, expect, it } from 'vitest';
import { marketplaceJournalNet } from '@lingfang/contract';
import {
  projectMarketplaceOrderFunds,
  purchaseJournal,
  refundJournal,
  resolveMarketplacePrice,
  settlementJournal,
  validateMarketplaceDiscount,
} from './marketplace-commerce-calculator';

const before = new Date('2026-07-15T00:00:00.000Z');
const start = new Date('2026-07-16T00:00:00.000Z');
const active = new Date('2026-07-17T00:00:00.000Z');
const end = new Date('2026-07-20T00:00:00.000Z');
const discount = { id: '11111111-1111-4111-8111-111111111111', revision: 1, priceCents: 80, startsAt: start, endsAt: end, canceledAt: null };

describe('marketplace commerce calculator', () => {
  it('keeps priceVersion opaque and changes it across revision/window facts', () => {
    const base = resolveMarketplacePrice({ listPriceCents: 100, priceRevision: 1, discount: null, now: active });
    const scheduled = resolveMarketplacePrice({ listPriceCents: 100, priceRevision: 1, discount, now: before });
    const discounted = resolveMarketplacePrice({ listPriceCents: 100, priceRevision: 1, discount, now: active });
    const revised = resolveMarketplacePrice({ listPriceCents: 100, priceRevision: 2, discount, now: active });
    expect(base.price_cents).toBe(100);
    expect(scheduled.price_cents).toBe(100);
    expect(discounted).toMatchObject({ price_cents: 80, discount_amount_cents: 20, window_phase: 'ACTIVE' });
    expect(new Set([base.price_version, scheduled.price_version, discounted.price_version, revised.price_version]).size).toBe(4);
  });

  it('validates absolute discount price and the 90-day maximum window', () => {
    expect(() => validateMarketplaceDiscount(100, { ...discount, priceCents: 0 })).toThrow('invalid_price');
    expect(() => validateMarketplaceDiscount(100, { ...discount, priceCents: 100 })).toThrow('invalid_price');
    expect(() => validateMarketplaceDiscount(100, { ...discount, endsAt: new Date(start.getTime() + 91 * 24 * 60 * 60 * 1000) })).toThrow('too_long');
  });

  it('builds complete balanced journals including a zero platform settlement row', () => {
    expect(marketplaceJournalNet(purchaseJournal(1))).toBe(0);
    expect(marketplaceJournalNet(refundJournal(1))).toBe(0);
    const settlement = settlementJournal(1, 2000);
    expect(marketplaceJournalNet(settlement)).toBe(0);
    expect(settlement).toContainEqual({ entry_kind: 'PLATFORM_SETTLEMENT_CREDIT', direction: 'CREDIT', amount_cents: 0 });
  });

  it('separates clearing reserve, seller receivable and settlement readiness', () => {
    const due = new Date('2026-07-23T00:00:00.000Z');
    expect(projectMarketplaceOrderFunds({ status: 'PENDING_SETTLEMENT', priceCents: 100, platformAmountCents: 20, sellerAmountCents: 80, settleAt: due, now: due })).toEqual({
      clearingReserveCents: 100, sellerReceivableCents: 80, platformReceivableCents: 20, settleable: true, heldForRefundReview: false,
    });
    expect(projectMarketplaceOrderFunds({ status: 'REFUND_REQUESTED', priceCents: 100, platformAmountCents: 20, sellerAmountCents: 80, settleAt: due, now: due })).toMatchObject({
      clearingReserveCents: 100, settleable: false, heldForRefundReview: true,
    });
    expect(projectMarketplaceOrderFunds({ status: 'SETTLED', priceCents: 100, platformAmountCents: 20, sellerAmountCents: 80, settleAt: due, now: due })).toMatchObject({
      clearingReserveCents: 0, sellerReceivableCents: 0, platformReceivableCents: 0, settleable: false,
    });
  });
});
