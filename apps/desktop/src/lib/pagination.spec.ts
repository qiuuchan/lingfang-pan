import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, paginateItems } from './pagination';

describe('pagination helpers', () => {
  it('defaults to 5 items per page with 5/10/20/50 options', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(5);
    expect(PAGE_SIZE_OPTIONS).toEqual([5, 10, 20, 50]);
    const items = Array.from({ length: 12 }, (_, index) => index);
    expect(paginateItems(items, 1)).toMatchObject({
      currentPage: 1,
      totalPages: 3,
      total: 12,
      items: [0, 1, 2, 3, 4],
    });
    expect(paginateItems(items, 3)).toMatchObject({
      currentPage: 3,
      totalPages: 3,
      items: [10, 11],
    });
  });

  it('honors a custom page size from the option set', () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    expect(paginateItems(items, 2, 10)).toMatchObject({
      currentPage: 2,
      totalPages: 2,
      total: 12,
      items: [10, 11],
    });
    expect(paginateItems(items, 1, 20)).toMatchObject({
      currentPage: 1,
      totalPages: 1,
      items,
    });
  });

  it('clamps out-of-range pages and invalid page sizes', () => {
    const items = Array.from({ length: 11 }, (_, index) => index);
    expect(paginateItems(items.slice(0, 1), 2, 10)).toMatchObject({
      currentPage: 1,
      totalPages: 1,
      items: [0],
    });
    expect(paginateItems([], 3)).toMatchObject({
      currentPage: 1,
      totalPages: 1,
      total: 0,
      items: [],
    });
    expect(paginateItems(items, 99, 5)).toMatchObject({
      currentPage: 3,
      totalPages: 3,
    });
    expect(paginateItems(items, 1, 0)).toMatchObject({
      currentPage: 1,
      totalPages: 11,
    });
  });
});
