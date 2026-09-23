/**
 * Renders the images Marketplace requires for a submission.
 *
 * Elgato asks for an app icon at 288x288, a thumbnail at 1920x960, and at
 * least three gallery items at 1920x960, all PNG.
 *
 * Every touch strip here is composed by the same `renderPanel` and
 * `renderIdle` the plugin calls at runtime, placed at the exact rects the
 * layout JSON gives the runtime, so the listing cannot show a layout the
 * product does not produce. A screenshot would go stale the first time a
 * colour or a baseline moved.
 *
 * The one thing drawn rather than rendered is the album art, because at
 * runtime that comes from the player. The covers below are obviously
 * synthetic, and the caption says where real art comes from.
 *
 * Run with: npm run marketplace
 * https://docs.elgato.com/guidelines/products
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { ACCENT, DISC, FRAME, INK, TILE, mark } from "./mark.mjs";
import {
	ART_SIZE,
	CANVAS_H,
	CANVAS_W,
	type Face,
	renderArtPlaceholder,
	renderIdle,
	renderPanel
} from "../src/render.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Committed rather than written to dist/: these are submission deliverables
// that get reviewed and reused, not build output.
const OUT = path.join(ROOT, "marketplace");

const W = 1920;
const H = 960;
const BG = "#141416";
const TEXT = "#F2F2F2";
const MUTED = "#9A9AA2";
const FONT = "Segoe UI, Segoe UI Variable, sans-serif";

/**
 * Fixed clock.
 *
 * `renderPanel` scrolls any line that overflows, so a wall clock would make
 * every regeneration differ and there would be no way to tell a real artwork
 * change from the second hand moving. At zero every line sits at its start.
 */
const NOW = 0;

/** The rects the layout gives the runtime. Changing these here would lie. */
const ART_RECT = { x: 4, y: 6 };
const PANEL_RECT = { x: 96, y: 0 };

/** Strips the wrapper so a panel can be nested in a larger document. */
function inner(svg: string): string {
	return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

let coverSeq = 0;

/**
 * Stand-in album art.
 *
 * Real art arrives from the player as a JPEG; these exist only so the gallery
 * can show the layout with something in the slot.
 */
function cover(from: string, to: string): string {
	const id = `cv${coverSeq++}`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${ART_SIZE}" height="${ART_SIZE}" ` +
		`viewBox="0 0 ${ART_SIZE} ${ART_SIZE}">` +
		`<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
		`</linearGradient></defs>` +
		`<rect width="${ART_SIZE}" height="${ART_SIZE}" rx="6" fill="url(#${id})"/>` +
		`<circle cx="${ART_SIZE / 2}" cy="${ART_SIZE / 2}" r="21" fill="none" stroke="#ffffff" ` +
		`stroke-opacity="0.34" stroke-width="7"/>` +
		`</svg>`
	);
}

let stripSeq = 0;

/**
 * One touch strip, composed exactly as the runtime composes it.
 *
 * The device strip is 200x100. `art` goes at the layout's art rect and the
 * text panel at its panel rect; passing no art gives the idle layout, which is
 * a single full-width canvas rather than the split one.
 *
 * The contents are clipped to the rounded outline. The panel pixmap has square
 * corners and runs to the strip's right edge, so without the clip it pokes out
 * past the rounding as two bright notches.
 */
function strip(
	x: number,
	y: number,
	scale: number,
	panel: string,
	art?: string,
	caption?: string
): string {
	const id = `st${stripSeq++}`;
	const body = art
		? `<g transform="translate(${ART_RECT.x} ${ART_RECT.y})">${inner(art)}</g>` +
			`<g transform="translate(${PANEL_RECT.x} ${PANEL_RECT.y})">${inner(panel)}</g>`
		: inner(panel);

	const label = caption
		? `<text x="${x + (CANVAS_W * scale) / 2}" y="${y + CANVAS_H * scale + 44}" ` +
			`text-anchor="middle" font-family="${FONT}" font-size="26" fill="${MUTED}">${caption}</text>`
		: "";

	return (
		`<g transform="translate(${x} ${y}) scale(${scale})">` +
		`<defs><clipPath id="${id}">` +
		`<rect width="${CANVAS_W}" height="${CANVAS_H}" rx="6"/></clipPath></defs>` +
		`<g clip-path="url(#${id})">` +
		`<rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#000000"/>${body}</g>` +
		// The panel's own backdrop is #121215 against a #141416 page, so an
		// idle strip - which is backdrop edge to edge - would otherwise have no
		// visible boundary and read as an empty space rather than a device.
		`<rect x="0.5" y="0.5" width="${CANVAS_W - 1}" height="${CANVAS_H - 1}" rx="5.5" ` +
		`fill="none" stroke="${FRAME}" stroke-width="1"/>` +
		`</g>${label}`
	);
}

function frame(body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<rect width="${W}" height="${H}" fill="${BG}"/>${body}</svg>`
	);
}

function title(text: string, sub?: string): string {
	const subtitle = sub
		? `<text x="${W / 2}" y="300" text-anchor="middle" font-family="${FONT}" ` +
			`font-size="40" fill="${MUTED}">${sub}</text>`
		: "";

	return (
		`<text x="${W / 2}" y="${sub ? 220 : 180}" text-anchor="middle" font-family="${FONT}" ` +
		`font-size="${sub ? 84 : 64}" font-weight="600" fill="${TEXT}">${text}</text>${subtitle}`
	);
}

function footer(text: string): string {
	return (
		`<text x="${W / 2}" y="${H - 70}" text-anchor="middle" font-family="${FONT}" ` +
		`font-size="30" fill="${MUTED}">${text}</text>`
	);
}

/** Lays a row of equal-width items out centred. */
function row(count: number, width: number, gap: number): number[] {
	const total = count * width + (count - 1) * gap;
	const start = (W - total) / 2;
	return Array.from({ length: count }, (_, i) => start + i * (width + gap));
}

function write(name: string, svg: string, width: number): void {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	mkdirSync(OUT, { recursive: true });
	writeFileSync(path.join(OUT, name), png);
	console.log(`  marketplace/${name} (${width}px, ${(png.length / 1024).toFixed(0)} KB)`);
}

const playing: Face = {
	title: "Weightless",
	artist: "Marconi Union",
	album: "Distance",
	app: "Spotify",
	status: "playing",
	position: 143_000,
	duration: 487_000
};

console.log("Generating Marketplace media...");

/*
	App icon, from the same mark() the plugin icon uses - imported, not copied,
	so the store and the preferences pane cannot show different products.
*/
write(
	"app-icon-288.png",
	`<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">` +
		`<rect width="288" height="288" rx="48" fill="${TILE}"/>${mark(ACCENT, FRAME, INK, DISC)}</svg>`,
	288
);

/*
	Thumbnail. One strip, large, playing - the thing the product is.
*/
{
	const scale = 3.1;
	write(
		"thumbnail.png",
		frame(
			title("Now Playing", "Album art, track and progress on a Stream Deck + dial") +
				strip((W - CANVAS_W * scale) / 2, 400, scale, renderPanel(playing, NOW), cover("#2e7d5b", "#14493a")) +
				footer("Works with any player that reports to Windows media controls")
		),
		W
	);
}

/*
	Gallery 1. The panel annotated, because the strip is small on the device and
	a buyer should know what each row is before installing rather than after.
*/
{
	const scale = 3.6;
	// Not centred on the canvas: the leader labels extend much further right
	// than the "Album art" one does left, so a centred strip puts the visual
	// weight of the whole group right of centre.
	const x = 545;
	const y = 330;
	const right = x + CANVAS_W * scale;

	/** A caption pinned to a row of the panel, with a rule out to it. */
	const note = (rowY: number, text: string): string =>
		`<line x1="${right + 24}" y1="${rowY}" x2="${right + 62}" y2="${rowY}" ` +
		`stroke="${FRAME}" stroke-width="2"/>` +
		`<text x="${right + 78}" y="${rowY + 10}" font-family="${FONT}" font-size="28" ` +
		`fill="${MUTED}">${text}</text>`;

	write(
		"gallery-1-panel.png",
		frame(
			title("What is playing, at a glance") +
				strip(x, y, scale, renderPanel(playing, NOW), cover("#2e7d5b", "#14493a")) +
				note(y + 17 * scale, "Track") +
				note(y + 35 * scale, "Artist") +
				note(y + 52 * scale, "Album") +
				note(y + 64 * scale, "Progress") +
				note(y + 80 * scale, "Elapsed and total") +
				`<text x="${x - 78}" y="${y + 50 * scale}" text-anchor="end" font-family="${FONT}" ` +
				`font-size="28" fill="${MUTED}">Album art</text>` +
				`<line x1="${x - 62}" y1="${y + 46 * scale}" x2="${x - 24}" y2="${y + 46 * scale}" ` +
				`stroke="${FRAME}" stroke-width="2"/>` +
				footer("Long titles scroll rather than truncate, so the whole name is readable")
		),
		W
	);
}

/*
	Gallery 2. The gestures. One dial does six things and none of them are
	discoverable from the artwork.
*/
{
	const scale = 2.5;
	write(
		"gallery-2-controls.png",
		frame(
			title("Four gestures, all yours to assign") +
				strip((W - CANVAS_W * scale) / 2, 300, scale, renderPanel(playing, NOW), cover("#8e44ad", "#432160")) +
				[
					["Press", "Play or pause"],
					["Tap", "Next track"],
					["Hold", "Previous track"],
					["Turn", "Volume, track or scrub"]
				]
					.map(([gesture, does], i) => {
						const xs = row(4, 380, 40);
						const x = xs[i]!;
						return (
							`<text x="${x + 190}" y="${680}" text-anchor="middle" font-family="${FONT}" ` +
							`font-size="40" font-weight="600" fill="${TEXT}">${gesture}</text>` +
							`<text x="${x + 190}" y="${726}" text-anchor="middle" font-family="${FONT}" ` +
							`font-size="28" fill="${MUTED}">${does}</text>`
						);
					})
					.join("") +
				footer("Those are the defaults; press, tap, hold and turn each do what you pick in settings")
		),
		W
	);
}

/*
	Gallery 3. Volume, including the two cases where a percentage would be a
	lie. Shipping those states in the listing is the point: they are the reason
	the readout is trustworthy.
*/
{
	const scale = 1.9;
	const xs = row(4, CANVAS_W * scale, 60);
	const y = 420;
	const vol = (v: Face["volume"]): string => renderPanel({ ...playing, volume: v }, NOW);

	write(
		"gallery-3-volume.png",
		frame(
			title("Volume, honestly") +
				strip(xs[0]!, y, scale, vol({ level: 0.62, muted: false, label: "Spotify" }), cover("#c0392b", "#6b1d15"), "Turning the dial") +
				strip(xs[1]!, y, scale, vol({ level: 0.62, muted: true, label: "Spotify" }), cover("#c0392b", "#6b1d15"), "Muted") +
				strip(xs[2]!, y, scale, vol({ muted: false, label: "Spotify" }), cover("#c0392b", "#6b1d15"), "Player released audio") +
				strip(xs[3]!, y, scale, vol({ muted: false, label: "Spotify", exclusive: true }), cover("#c0392b", "#6b1d15"), "Exclusive mode") +
				footer("It drives that player's mixer entry, and says so when there is nothing to drive")
		),
		W
	);
}

/*
	Gallery 4. Any player, plus the idle state - which is a different layout,
	not the playing one with the fields blanked.
*/
{
	const scale = 1.9;
	const xs = row(4, CANVAS_W * scale, 56);
	const y = 390;
	const face = (over: Partial<Face>): Face => ({ ...playing, ...over });

	write(
		"gallery-4-players.png",
		frame(
			title("Whatever is playing") +
				strip(
					xs[0]!,
					y,
					scale,
					renderPanel(face({ title: "Teardrop", artist: "Massive Attack", album: "Mezzanine", app: "TIDAL" }), NOW),
					cover("#1f6f8b", "#0d3242"),
					"TIDAL"
				) +
				strip(
					xs[1]!,
					y,
					scale,
					renderPanel(
						face({
							title: "Night Ferry",
							artist: "Ólafur Arnalds",
							album: "Island Songs",
							app: "Plexamp",
							position: undefined,
							duration: undefined
						}),
						NOW
					),
					cover("#b8860b", "#5c410a"),
					"Plexamp, no timeline"
				) +
				strip(
					xs[2]!,
					y,
					scale,
					renderPanel(face({ title: "Live set", artist: "Boiler Room", album: "", app: "Edge", status: "paused" }), NOW),
					renderArtPlaceholder("Boiler Room"),
					"Browser, no art"
				) +
				strip(xs[3]!, y, scale, renderIdle("Nothing playing", "Start a track to see it here"), undefined, "Idle") +
				footer("Spotify, TIDAL, Plexamp, Apple Music, browsers \u2014 anything Windows knows about")
		),
		W
	);
}

console.log("Done.");
