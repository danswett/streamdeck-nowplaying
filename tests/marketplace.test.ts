/**
 * Elgato's Marketplace guidelines are checked by a human at submission time,
 * and this artwork is generated, so a regression is invisible until a
 * submission is rejected. These assert the rules a generated file can quietly
 * break.
 *
 * The one that matters most: the category icon and every action icon are drawn
 * inside the Stream Deck app's action list, which must be a monochrome white
 * stroke on a transparent background. Colour and solid backgrounds are both
 * called out as incorrect. The key on the deck is exempt, and is where this
 * plugin's colour lives.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins#icons
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { beforeAll, describe, expect, it } from "vitest";

const PLUGIN_DIR = path.resolve(__dirname, "..", "com.bad-duck.nowplaying.sdPlugin");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8")) as {
	UUID: string;
	Category: string;
	Author: string;
	Icon: string;
	CategoryIcon: string;
	Actions: { UUID: string; Name: string; Icon: string; States: { Image: string }[] }[];
};

/**
 * Resolves a manifest image reference, which omits the extension.
 *
 * Two files with the same base name is not a tie the manifest can break, so an
 * ambiguous reference is a failure rather than a guess.
 */
function resolveImage(ref: string): string {
	const base = path.join(PLUGIN_DIR, ...ref.split("/"));
	const found = [".svg", ".png"].filter((ext) => existsSync(base + ext));

	expect(found, `${ref}: expected exactly one file`).toHaveLength(1);
	return base + found[0];
}

/** Rasterised at the size the action list draws, doubled for high DPI. */
const LIST_RASTER = 40;
/** Below this alpha the pixel is antialiasing fringe, not artwork. */
const INK = 16;

type Raster = { pixels: Uint8Array; width: number; height: number };

/**
 * Cached, because each icon is measured for colour, coverage and corners, and
 * rasterising is native work that pays a one-off initialization on first use.
 * On a cold runner that start-up alone can exceed vitest's 5s default timeout
 * and fail whichever assertion happens to go first. Warmed in `beforeAll`.
 */
const rasterCache = new Map<string, Raster>();

function rasterise(file: string): Raster {
	const cached = rasterCache.get(file);
	if (cached) return cached;

	const markup =
		path.extname(file) === ".svg"
			? readFileSync(file, "utf8")
			: // resvg only reads SVG, so a PNG is wrapped in one to be measured.
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
				`width="${LIST_RASTER}" height="${LIST_RASTER}" ` +
				`viewBox="0 0 ${LIST_RASTER} ${LIST_RASTER}">` +
				`<image width="${LIST_RASTER}" height="${LIST_RASTER}" xlink:href="data:image/png;base64,` +
				`${readFileSync(file).toString("base64")}"/></svg>`;

	const img = new Resvg(markup, { fitTo: { mode: "width", value: LIST_RASTER } }).render();
	const raster = { pixels: img.pixels, width: img.width, height: img.height };

	rasterCache.set(file, raster);
	return raster;
}

/**
 * Every colour the icon actually puts on screen, as `#rrggbb`.
 *
 * Reading the markup is not enough on its own: it cannot see a PNG at all, and
 * an SVG can reach a colour through a gradient rather than a literal. resvg
 * hands back premultiplied alpha, so white at 12% opacity arrives as
 * rgb(31,31,31); dividing the alpha back out is the difference between reading
 * a glyph's antialiasing as a grey ramp and reading it as the one colour it
 * was drawn in.
 */
function renderedColours(file: string): string[] {
	const img = rasterise(file);
	const seen = new Set<string>();

	for (let i = 0; i < img.width * img.height; i++) {
		const a = img.pixels[i * 4 + 3];
		if (a < INK) continue;

		const hex = [0, 1, 2]
			.map((c) => Math.min(255, Math.round((img.pixels[i * 4 + c] * 255) / a)))
			.map((c) => c.toString(16).padStart(2, "0"))
			.join("");
		seen.add(`#${hex}`);
	}
	return [...seen];
}

/** Share of the canvas carrying ink. A solid background reads as ~1. */
function coverage(file: string): number {
	const img = rasterise(file);
	let inked = 0;
	for (let i = 0; i < img.width * img.height; i++) {
		if (img.pixels[i * 4 + 3] >= INK) inked++;
	}
	return inked / (img.width * img.height);
}

const listIcons: [string, string][] = [
	["category", manifest.CategoryIcon],
	...manifest.Actions.map((a): [string, string] => [a.Name, a.Icon])
];

beforeAll(() => {
	for (const [, ref] of listIcons) rasterise(resolveImage(ref));
	for (const action of manifest.Actions) rasterise(resolveImage(action.States[0].Image));
}, 120_000);

describe("action list icons", () => {
	it.each(listIcons)("%s is white, and only white", (_name, ref) => {
		expect(renderedColours(resolveImage(ref))).toEqual(["#ffffff"]);
	});

	it.each(listIcons)("%s is drawn on a transparent background", (_name, ref) => {
		const file = resolveImage(ref);
		const img = rasterise(file);

		for (const [x, y] of [
			[0, 0],
			[img.width - 1, 0],
			[0, img.height - 1],
			[img.width - 1, img.height - 1]
		]) {
			expect(img.pixels[(y * img.width + x) * 4 + 3], `corner ${x},${y} is inked`).toBe(0);
		}

		// A mark that fills the canvas is a tile however clear its corners. The
		// category icon's disc is the trap here: filled, it covers 78% on its own.
		expect(coverage(file)).toBeLessThan(0.8);
	});

	it.each(listIcons)("%s actually draws something", (_name, ref) => {
		expect(coverage(resolveImage(ref))).toBeGreaterThan(0.01);
	});

	it.each(listIcons)("%s uses SVG, the recommended format", (_name, ref) => {
		expect(resolveImage(ref).endsWith(".svg")).toBe(true);
	});
});

describe("keys", () => {
	// The colour lives here, and the guidelines place no restriction on it. The
	// point of the assertion is that the key artwork is a separate file from the
	// list icon: when they were the same file, making the list compliant would
	// have meant giving up the colour on the deck.
	it.each(manifest.Actions.map((a) => [a.Name, a.Icon, a.States[0].Image] as const))(
		"%s draws its key separately from its list icon",
		(_name, icon, image) => {
			expect(resolveImage(image)).not.toBe(resolveImage(icon));
			expect(renderedColours(resolveImage(image)).length).toBeGreaterThan(1);
		}
	);
});

describe("plugin icon", () => {
	it("is a PNG with a high-DPI variant", () => {
		const file = resolveImage(manifest.Icon);

		expect(file.endsWith(".png")).toBe(true);
		expect(existsSync(file.replace(/\.png$/, "@2x.png"))).toBe(true);
	});

	it("is 256px, doubled for high DPI", () => {
		// Read straight out of the IHDR rather than decoded: the width is bytes
		// 16..19 of any PNG, big-endian.
		const widthOf = (file: string): number => readFileSync(file).readUInt32BE(16);
		const file = resolveImage(manifest.Icon);

		expect(widthOf(file)).toBe(256);
		expect(widthOf(file.replace(/\.png$/, "@2x.png"))).toBe(512);
	});
});

describe("identity", () => {
	it("uses the organization in the UUID and the Author field", () => {
		expect(manifest.UUID.startsWith("com.bad-duck.")).toBe(true);
		expect(manifest.Author).toBe("Bad Duck Software");

		for (const action of manifest.Actions) {
			expect(action.UUID.startsWith(`${manifest.UUID}.`), action.Name).toBe(true);
		}
	});

	it("does not include the author name in the category", () => {
		// "include author names in category" is explicitly listed as incorrect.
		expect(manifest.Category.toLowerCase()).not.toContain("bad duck");
	});
});
