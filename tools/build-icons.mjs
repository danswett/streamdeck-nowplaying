/**
 * Rasterizes the plugin artwork into the PNG sizes Stream Deck requires.
 *
 * Action icons may stay as SVG, but the plugin Icon and CategoryIcon must be
 * PNG, and the CategoryIcon needs a @2x companion. Generated rather than
 * checked in so the artwork has one source of truth.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

const OUT = "com.dswett.nowplaying.sdPlugin/imgs/plugin";

/** A record under a play head: album art plus transport, drawn once and scaled. */
function logo(size) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 288 288">
<rect width="288" height="288" rx="48" fill="#121215"/>
<circle cx="144" cy="144" r="86" fill="#1c1c21" stroke="#2e2e35" stroke-width="8"/>
<circle cx="144" cy="144" r="52" fill="none" stroke="#1db954" stroke-width="10"/>
<circle cx="144" cy="144" r="16" fill="#f4f4f5"/>
<path d="M 186 104 L 186 68 L 232 78 L 232 114 Z" fill="#1db954"/>
</svg>`;
}

async function render(name, size) {
	const resvg = new Resvg(logo(size), { fitTo: { mode: "width", value: size } });
	const png = resvg.render().asPng();
	const file = path.join(OUT, name);
	await writeFile(file, png);
	console.log(`${file} (${size}x${size}, ${png.length} bytes)`);
}

await mkdir(OUT, { recursive: true });
await render("marketplace.png", 288);
await render("marketplace@2x.png", 576);
await render("category-icon.png", 28);
await render("category-icon@2x.png", 56);
