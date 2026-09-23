/**
 * Draws every piece of the plugin's artwork from one source.
 *
 * There are two audiences here and they have different rules.
 *
 * The key on the deck may be any colour. It is only ever seen before the first
 * frame arrives - once something is playing the runtime paints the real album
 * art over it - so it keeps the dark tile and the green that the plugin's own
 * artwork uses.
 *
 * The action list inside the Stream Deck app may not. Elgato require the
 * category icon and every action icon to be a monochrome white stroke on a
 * transparent background, and call out both colour and solid backgrounds as
 * incorrect. So the glyph is emitted twice: white and untiled for the list,
 * tinted and tiled for the key.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins#icons
 *
 * Run with: node tools/build-icons.mjs
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { ACCENT, DISC, FRAME, INK, TILE, WHITE, dial, mark } from "./mark.mjs";

const PLUGIN = "com.bad-duck.nowplaying.sdPlugin";
const ACTIONS = path.join(PLUGIN, "imgs", "actions");
const PLUGIN_IMGS = path.join(PLUGIN, "imgs", "plugin");

function svg(size, viewBox, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
		`viewBox="0 0 ${viewBox} ${viewBox}">${body}</svg>`
	);
}

async function writeSvg(file, contents) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${contents}\n`, "utf8");
	console.log(`  ${file}`);
}

async function writePng(file, markup, size) {
	const png = new Resvg(markup, { fitTo: { mode: "width", value: size } }).render().asPng();
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, png);
	console.log(`  ${file} (${size}px)`);
}

console.log("Generating icons...");

// White on transparent for the action list; tinted, on its tile, for the key.
await writeSvg(path.join(ACTIONS, "dial", "icon.svg"), svg(72, 72, dial(WHITE, WHITE, WHITE)));
await writeSvg(
	path.join(ACTIONS, "dial", "key.svg"),
	svg(72, 72, `<rect width="72" height="72" rx="12" fill="${TILE}"/>${dial(ACCENT, FRAME, INK)}`)
);

// The flat file the folder replaced. The manifest names images without an
// extension, so anything left beside the one meant to win is ambiguous.
await rm(path.join(ACTIONS, "dial.svg"), { force: true });

// The category icon follows the same rule as the actions, so the mark loses
// its tile and its colour here - including the disc fill, which would
// otherwise be an opaque circle covering most of the canvas. SVG rather than
// PNG: it is the format Elgato recommend, and it makes the separate high-DPI
// file a raster would need unnecessary.
await writeSvg(
	path.join(PLUGIN_IMGS, "category-icon.svg"),
	svg(28, 288, mark(WHITE, WHITE, WHITE, "none"))
);
for (const stale of ["category-icon.png", "category-icon@2x.png"]) {
	await rm(path.join(PLUGIN_IMGS, stale), { force: true });
}

// The plugin icon is the exception, and the guidelines allow it: this one
// appears in Stream Deck's preferences pane and on Marketplace, where it is the
// product's mark rather than a list glyph. It must be PNG, at 256px and 512px.
const logo = svg(
	288,
	288,
	`<rect width="288" height="288" rx="48" fill="${TILE}"/>${mark(ACCENT, FRAME, INK, DISC)}`
);

await writePng(path.join(PLUGIN_IMGS, "marketplace.png"), logo, 256);
await writePng(path.join(PLUGIN_IMGS, "marketplace@2x.png"), logo, 512);

console.log("Done.");
