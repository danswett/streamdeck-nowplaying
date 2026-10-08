import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { IDLE_LAYOUT, LAYOUT, TEXT_LAYOUT, layoutFor, showsArt, textWidthFor } from "../src/layout";
import { PANEL_W, WIDE_TEXT_W } from "../src/render";

const PLUGIN_DIR = path.resolve(__dirname, "..", "com.bad-duck.nowplaying.sdPlugin");

describe("showsArt", () => {
	it("shows art for dials saved before the setting existed", () => {
		// Everyone updating from 1.0 has no "art" key; their dial must not
		// change under them.
		expect(showsArt(undefined)).toBe(true);
	});

	it("hides art only when asked to", () => {
		expect(showsArt("show")).toBe(true);
		expect(showsArt("hide")).toBe(false);
		expect(showsArt("nonsense")).toBe(true);
	});
});

describe("layoutFor", () => {
	it("uses the idle layout whenever nothing is playing, regardless of art", () => {
		expect(layoutFor(true, "show")).toBe(IDLE_LAYOUT);
		expect(layoutFor(true, "hide")).toBe(IDLE_LAYOUT);
	});

	it("differs between show and hide, so toggling switches layouts live", () => {
		expect(layoutFor(false, "show")).toBe(LAYOUT);
		expect(layoutFor(false, undefined)).toBe(LAYOUT);
		expect(layoutFor(false, "hide")).toBe(TEXT_LAYOUT);
	});

	it("points only at layout files that exist", () => {
		for (const file of [LAYOUT, TEXT_LAYOUT, IDLE_LAYOUT]) {
			expect(existsSync(path.join(PLUGIN_DIR, file))).toBe(true);
		}
	});
});

describe("textWidthFor", () => {
	it("measures overflow against the panel actually shown", () => {
		expect(textWidthFor("show")).toBe(PANEL_W);
		expect(textWidthFor(undefined)).toBe(PANEL_W);
		expect(textWidthFor("hide")).toBe(WIDE_TEXT_W);
	});
});
