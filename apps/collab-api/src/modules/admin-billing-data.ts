export interface BillingPageQuery {
  page?: string | number;
  pageSize?: string | number;
  q?: string;
}

export function normalizeBillingPage(query: BillingPageQuery) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  return { page, pageSize, skip: (page - 1) * pageSize, q: query.q?.trim() || undefined };
}
