import { createHash } from 'node:crypto';
import {
  CnyCents,
  MarketplacePriceVersion,
  marketplaceJournalNet,
  splitMarketplacePrice,
  type MarketplaceJournalEntry,
  type MarketplaceOrderStatus,
  type MarketplacePriceProjection,
} from '@lingfang/contract';

export type MarketplaceDiscountFact = {
  id: string;
  revision: number;
  priceCents: number;
  startsAt: Date;
  endsAt: Date;
  canceledAt: Date | null;
};

export type MarketplacePriceWindowPhase = 'BASE' | 'BEFORE' | 'ACTIVE' | 'AFTER' | 'CANCELED';

export type MarketplaceOrderFundsProjection = {
  clearingReserveCents: number;
  sellerReceivableCents: number;
  platformReceivableCents: number;
  settleable: boolean;
  heldForRefundReview: boolean;
};

function canonicalPriceFacts(value: {
  priceRevision: number;
  discountId: string | null;
  discountRevision: number | null;
  windowPhase: MarketplacePriceWindowPhase;
}): string {
  return JSON.stringify({
    active_discount_id: value.discountId,
    active_discount_revision: value.discountRevision,
    price_revision: value.priceRevision,
    window_phase: value.windowPhase,
  });
}

export function marketplaceDiscountPhase(
  discount: MarketplaceDiscountFact | null,
  now: Date
): MarketplacePriceWindowPhase {
  if (!discount) return 'BASE';
  if (discount.canceledAt) return 'CANCELED';
  if (now < discount.startsAt) return 'BEFORE';
  if (now >= discount.endsAt) return 'AFTER';
  return 'ACTIVE';
}

export function validateMarketplaceDiscount(
  listPriceCents: number,
  discount: MarketplaceDiscountFact
): void {
  const listPrice = CnyCents.parse(listPriceCents);
  const discountPrice = CnyCents.parse(discount.priceCents);
  if (discountPrice < 1 || discountPrice >= listPrice)
    throw new Error('marketplace_discount_invalid_price');
  if (!Number.isInteger(discount.revision) || discount.revision < 1)
    throw new Error('marketplace_discount_invalid_revision');
  if (
    Number.isNaN(discount.startsAt.getTime()) ||
    Number.isNaN(discount.endsAt.getTime()) ||
    discount.startsAt >= discount.endsAt
  ) {
    throw new Error('marketplace_discount_invalid_window');
  }
  if (discount.endsAt.getTime() - discount.startsAt.getTime() > 90 * 24 * 60 * 60 * 1000)
    throw new Error('marketplace_discount_window_too_long');
}

export function resolveMarketplacePrice(input: {
  listPriceCents: number;
  priceRevision: number;
  discount: MarketplaceDiscountFact | null;
  now: Date;
}): MarketplacePriceProjection & {
  window_phase: MarketplacePriceWindowPhase;
  internal_price_revision: number;
} {
  const listPrice = CnyCents.parse(input.listPriceCents);
  if (!Number.isInteger(input.priceRevision) || input.priceRevision < 1)
    throw new Error('marketplace_price_invalid_revision');
  if (Number.isNaN(input.now.getTime())) throw new Error('marketplace_price_invalid_clock');
  if (input.discount) validateMarketplaceDiscount(listPrice, input.discount);
  const phase = marketplaceDiscountPhase(input.discount, input.now);
  const active = phase === 'ACTIVE' ? input.discount : null;
  const effectivePrice = active?.priceCents ?? listPrice;
  const digest = createHash('sha256')
    .update(
      canonicalPriceFacts({
        priceRevision: input.priceRevision,
        discountId: input.discount?.id ?? null,
        discountRevision: input.discount?.revision ?? null,
        windowPhase: phase,
      })
    )
    .digest('base64url');
  const priceVersion = MarketplacePriceVersion.parse(`pv1.${digest}`);
  return {
    currency_code: 'CNY',
    list_price_cents: listPrice,
    discount_amount_cents: listPrice - effectivePrice,
    effective_price_cents: effectivePrice,
    price_cents: effectivePrice,
    price_version: priceVersion,
    discount: active
      ? {
          id: active.id,
          revision: active.revision,
          price_cents: active.priceCents,
          starts_at: active.startsAt.toISOString(),
          ends_at: active.endsAt.toISOString(),
        }
      : null,
    window_phase: phase,
    internal_price_revision: input.priceRevision,
  };
}

function balanced(entries: MarketplaceJournalEntry[]): MarketplaceJournalEntry[] {
  if (marketplaceJournalNet(entries) !== 0) throw new Error('marketplace_journal_unbalanced');
  return entries;
}

export function purchaseJournal(grossCents: number): MarketplaceJournalEntry[] {
  const gross = CnyCents.parse(grossCents);
  return balanced([
    { entry_kind: 'BUYER_PURCHASE_DEBIT', direction: 'DEBIT', amount_cents: gross },
    { entry_kind: 'PLATFORM_PURCHASE_CLEARING_CREDIT', direction: 'CREDIT', amount_cents: gross },
  ]);
}

export function refundJournal(grossCents: number): MarketplaceJournalEntry[] {
  const gross = CnyCents.parse(grossCents);
  return balanced([
    { entry_kind: 'PLATFORM_REFUND_CLEARING_DEBIT', direction: 'DEBIT', amount_cents: gross },
    { entry_kind: 'BUYER_REFUND_CREDIT', direction: 'CREDIT', amount_cents: gross },
  ]);
}

export function settlementJournal(
  grossCents: number,
  platformFeeBps: number
): MarketplaceJournalEntry[] {
  const split = splitMarketplacePrice(grossCents, platformFeeBps);
  return balanced([
    {
      entry_kind: 'PLATFORM_SETTLEMENT_CLEARING_DEBIT',
      direction: 'DEBIT',
      amount_cents: split.gross_cents,
    },
    {
      entry_kind: 'SELLER_SETTLEMENT_CREDIT',
      direction: 'CREDIT',
      amount_cents: split.seller_amount_cents,
    },
    {
      entry_kind: 'PLATFORM_SETTLEMENT_CREDIT',
      direction: 'CREDIT',
      amount_cents: split.platform_amount_cents,
    },
  ]);
}

export function projectMarketplaceOrderFunds(input: {
  status: MarketplaceOrderStatus;
  priceCents: number;
  platformAmountCents: number;
  sellerAmountCents: number;
  settleAt: Date;
  now: Date;
}): MarketplaceOrderFundsProjection {
  const gross = CnyCents.parse(input.priceCents);
  const platform = CnyCents.parse(input.platformAmountCents);
  const seller = CnyCents.parse(input.sellerAmountCents);
  if (platform + seller !== gross) throw new Error('marketplace_order_split_invalid');
  const awaitingTerminal =
    input.status === 'PENDING_SETTLEMENT' || input.status === 'REFUND_REQUESTED';
  return {
    clearingReserveCents: awaitingTerminal ? gross : 0,
    sellerReceivableCents: awaitingTerminal ? seller : 0,
    platformReceivableCents: awaitingTerminal ? platform : 0,
    settleable: input.status === 'PENDING_SETTLEMENT' && input.settleAt <= input.now,
    heldForRefundReview: input.status === 'REFUND_REQUESTED',
  };
}
