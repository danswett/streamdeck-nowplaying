import type { PlaybackStatus } from "./smtc/bridge";

/**
 * Painting for the encoder panel.
 *
 * The touch strip gives each dial a 200x100 region. Album art is placed as its
 * own layout pixmap and everything else is drawn here as SVG, which Stream Deck
 * rasterises. Splitting them this way means the artwork bytes go to the device
 * untouched - no decoding or compositing in the plugin, and so no native image
 * dependency on a Node runtime we do not control.
 */

export const PANEL_W = 104;
export const PANEL_H = 100;
export const ART_SIZE = 88;

const INK = "#f4f4f5";
const DIM = "#9a9aa3";
const FAINT = "#6b6b74";
const ACCENT = "#1db954";
const TRACK = "#2c2c31";
const BACKDROP = "#121215";

export function toPixmap(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Approximate rendered width of a string.
 *
 * Only used to decide whether a line overflows and by how far, so a per-class
 * character estimate is enough; measuring properly would mean shipping font
 * metrics for a value that feeds a scroll offset.
 */
const NARROW = new Set("ilj|!.,:;'`[]()/\\ftI");
const WIDE = new Set("mwMW@%");

export function textWidth(text: string, size: number): number {
	let units = 0;
	for (const ch of text) {
		if (NARROW.has(ch)) units += 0.31;
		else if (WIDE.has(ch)) units += 0.86;
		else if (ch === " ") units += 0.28;
		else if (ch >= "A" && ch <= "Z") units += 0.65;
		else if (ch >= "0" && ch <= "9") units += 0.56;
		else units += 0.53;
	}
	return units * size;
}

const SCROLL_PAUSE_MS = 1400;
const SCROLL_SPEED_PX_S = 26;

/**
 * Horizontal offset for a line that does not fit.
 *
 * Track and artist names routinely run past 104px, and truncating them hides
 * exactly the part that distinguishes one remaster from another. The line
 * eases to the end, holds, and returns, so the whole string is readable
 * without the text ever being in motion for long.
 */
export function scrollOffset(text: string, size: number, width: number, now: number): number {
	const overflow = textWidth(text, size) - width;
	if (overflow <= 0.5) return 0;

	const travelMs = (overflow / SCROLL_SPEED_PX_S) * 1000;
	const cycle = SCROLL_PAUSE_MS * 2 + travelMs * 2;
	const t = now % cycle;

	if (t < SCROLL_PAUSE_MS) return 0;
	if (t < SCROLL_PAUSE_MS + travelMs) return ((t - SCROLL_PAUSE_MS) / travelMs) * overflow;
	if (t < SCROLL_PAUSE_MS * 2 + travelMs) return overflow;
	return overflow - ((t - SCROLL_PAUSE_MS * 2 - travelMs) / travelMs) * overflow;
}

export function overflows(text: string, size: number, width: number): boolean {
	return textWidth(text, size) - width > 0.5;
}

type Line = {
	readonly text: string;
	readonly size: number;
	readonly weight: number;
	readonly fill: string;
	readonly opacity?: number;
	/** Top of the clip window. */
	readonly top: number;
	readonly height: number;
	readonly baseline: number;
	readonly id: string;
};

function renderLine(line: Line, now: number): string {
	if (!line.text) return "";
	const offset = scrollOffset(line.text, line.size, PANEL_W, now);
	const text =
		`<text x="${(-offset).toFixed(1)}" y="${line.baseline}" font-family="Segoe UI, Arial, sans-serif"` +
		` font-size="${line.size}" font-weight="${line.weight}" fill="${line.fill}"` +
		`${line.opacity !== undefined ? ` opacity="${line.opacity}"` : ""}` +
		` xml:space="preserve">${escapeText(line.text)}</text>`;

	// Only clip lines that actually scroll; a clip path per line otherwise
	// costs rasterising work for nothing.
	if (offset === 0 && !overflows(line.text, line.size, PANEL_W)) return text;

	return (
		`<defs><clipPath id="${line.id}">` +
		`<rect x="0" y="${line.top}" width="${PANEL_W}" height="${line.height}"/>` +
		`</clipPath></defs>` +
		`<g clip-path="url(#${line.id})">${text}</g>`
	);
}

export type Face = {
	readonly title: string;
	readonly artist: string;
	readonly album: string;
	readonly app: string;
	readonly status: PlaybackStatus;
	readonly position?: number;
	readonly duration?: number;
	/** When set, the transport rows are replaced by a volume readout. */
	readonly volume?: number;
	readonly volumeScope?: "system" | "app";
	readonly muted?: boolean;
	/** Shown instead of track details, e.g. when nothing is playing. */
	readonly message?: string;
};

function statusGlyph(status: PlaybackStatus, x: number, y: number, fill: string): string {
	if (status === "playing") {
		return `<path d="M ${x} ${y - 4.5} L ${x + 7} ${y} L ${x} ${y + 4.5} Z" fill="${fill}"/>`;
	}
	if (status === "paused") {
		return (
			`<rect x="${x}" y="${y - 4.5}" width="2.4" height="9" rx="0.6" fill="${fill}"/>` +
			`<rect x="${x + 4}" y="${y - 4.5}" width="2.4" height="9" rx="0.6" fill="${fill}"/>`
		);
	}
	return `<rect x="${x}" y="${y - 4}" width="8" height="8" rx="1" fill="${fill}"/>`;
}

function formatClock(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--";
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function bar(y: number, fraction: number, fill: string): string {
	const width = Math.max(0, Math.min(1, fraction)) * PANEL_W;
	return (
		`<rect x="0" y="${y}" width="${PANEL_W}" height="4" rx="2" fill="${TRACK}"/>` +
		(width > 0 ? `<rect x="0" y="${y}" width="${width.toFixed(1)}" height="4" rx="2" fill="${fill}"/>` : "")
	);
}

/** Paints the text half of the encoder panel. */
export function renderPanel(face: Face, now = Date.now()): string {
	const body: string[] = [];

	if (face.message) {
		body.push(
			`<text x="${PANEL_W / 2}" y="46" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"` +
				` font-size="13" font-weight="600" fill="${DIM}">${escapeText(face.message)}</text>`
		);
		if (face.app) {
			body.push(
				`<text x="${PANEL_W / 2}" y="64" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"` +
					` font-size="10" font-weight="400" fill="${FAINT}">${escapeText(face.app)}</text>`
			);
		}
	} else {
		const dimmed = face.status !== "playing";
		body.push(
			renderLine(
				{ text: face.title, size: 15, weight: 700, fill: dimmed ? DIM : INK, top: 1, height: 21, baseline: 17, id: "t" },
				now
			),
			renderLine(
				{ text: face.artist, size: 12.5, weight: 500, fill: DIM, top: 22, height: 18, baseline: 35, id: "a" },
				now
			),
			renderLine(
				{ text: face.album, size: 11, weight: 400, fill: FAINT, top: 40, height: 16, baseline: 52, id: "b" },
				now
			)
		);

		if (face.volume !== undefined) {
			// Turning the dial for volume takes over the lower rows: the
			// progress bar is not what the user is looking at mid-adjustment.
			const percent = Math.round(face.volume * 100);
			const label = face.muted ? "MUTED" : `${percent}%`;
			const scope = face.volumeScope === "app" ? face.app.toUpperCase() : "SYSTEM";
			body.push(
				bar(62, face.muted ? 0 : face.volume, face.muted ? FAINT : ACCENT),
				`<text x="0" y="80" font-family="Segoe UI, Arial, sans-serif" font-size="10.5"` +
					` font-weight="600" fill="${FAINT}" letter-spacing="0.6">${escapeText(scope)}</text>`,
				`<text x="${PANEL_W}" y="80" text-anchor="end" font-family="Segoe UI, Arial, sans-serif"` +
					` font-size="12" font-weight="700" fill="${INK}">${label}</text>`
			);
		} else {
			const fraction = face.duration ? (face.position ?? 0) / face.duration : 0;
			body.push(
				bar(62, fraction, face.status === "playing" ? ACCENT : FAINT),
				statusGlyph(face.status, 0, 76, face.status === "playing" ? ACCENT : FAINT),
				`<text x="12" y="80" font-family="Segoe UI, Arial, sans-serif" font-size="10.5"` +
					` font-weight="500" fill="${DIM}">${formatClock(face.position)}</text>`,
				`<text x="${PANEL_W}" y="80" text-anchor="end" font-family="Segoe UI, Arial, sans-serif"` +
					` font-size="10.5" font-weight="500" fill="${FAINT}">${formatClock(face.duration)}</text>`
			);
		}
	}

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H}"` +
		` viewBox="0 0 ${PANEL_W} ${PANEL_H}">` +
		`<rect width="${PANEL_W}" height="${PANEL_H}" fill="${BACKDROP}"/>` +
		body.join("") +
		`</svg>`
	);
}

/**
 * Stand-in artwork.
 *
 * Browsers and some players publish a session with no thumbnail at all, and an
 * empty square reads as a broken plugin, so the slot always gets something.
 */
export function renderArtPlaceholder(label: string): string {
	const initial = escapeText((label.trim()[0] ?? "\u266a").toUpperCase());
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${ART_SIZE}" height="${ART_SIZE}"` +
		` viewBox="0 0 ${ART_SIZE} ${ART_SIZE}">` +
		`<rect width="${ART_SIZE}" height="${ART_SIZE}" rx="6" fill="#1c1c21"/>` +
		`<rect x="0.75" y="0.75" width="${ART_SIZE - 1.5}" height="${ART_SIZE - 1.5}" rx="5.5"` +
		` fill="none" stroke="#2e2e35" stroke-width="1.5"/>` +
		`<text x="${ART_SIZE / 2}" y="${ART_SIZE / 2 + 13}" text-anchor="middle"` +
		` font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="300" fill="${FAINT}">${initial}</text>` +
		`</svg>`
	);
}
