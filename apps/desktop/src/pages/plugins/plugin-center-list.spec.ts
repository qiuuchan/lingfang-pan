import { describe, expect, it } from "vitest";
import type {
	LocalPluginInstallation,
	PluginCatalogItem,
} from "@lingfang/contract";
import {
	catalogSourceKinds,
	filterCatalogItems,
	filterInstallations,
	paginateItems,
	PLUGIN_CENTER_PAGE_SIZE,
} from "./plugin-center-list";

const installation = (origin: LocalPluginInstallation["origin"]) =>
	({ origin }) as LocalPluginInstallation;
const catalogItem = (
	sourceKind: PluginCatalogItem["latestRelease"]["sourceKind"],
) =>
	({
		latestRelease: { sourceKind },
	}) as PluginCatalogItem;

describe("plugin center list helpers", () => {
	it("filters installed plugins by installation origin", () => {
		const items = [
			installation("builtin"),
			installation("team"),
			installation("marketplace"),
		];
		expect(filterInstallations(items, "team")).toEqual([items[1]]);
		expect(filterInstallations(items, "all")).toBe(items);
	});

	it("builds unique catalog sources and filters releases", () => {
		const items = [
			catalogItem("API"),
			catalogItem("LINGFANG_CREATOR"),
			catalogItem("API"),
		];
		expect(catalogSourceKinds(items)).toEqual(["API", "LINGFANG_CREATOR"]);
		expect(filterCatalogItems(items, "API")).toEqual([items[0], items[2]]);
	});

	it("clamps pagination after filtering shrinks the result", () => {
		const items = Array.from({ length: 11 }, (_, index) => index);
		expect(paginateItems(items, 2, 10)).toMatchObject({
			currentPage: 2,
			totalPages: 2,
			items: [10],
		});
		expect(paginateItems(items.slice(0, 1), 2, 10)).toMatchObject({
			currentPage: 1,
			totalPages: 1,
			items: [0],
		});
		expect(paginateItems([], 3, 10)).toMatchObject({
			currentPage: 1,
			totalPages: 1,
			items: [],
		});
	});

	it("defaults plugin center lists to 5 items per page", () => {
		expect(PLUGIN_CENTER_PAGE_SIZE).toBe(5);
		const items = Array.from({ length: 12 }, (_, index) => index);
		expect(paginateItems(items, 1)).toMatchObject({
			currentPage: 1,
			totalPages: 3,
			total: 12,
			items: [0, 1, 2, 3, 4],
		});
	});
});
