import { describe, expect, it } from "vitest";

import {
	CANVAS_W,
	overflows,
	renderIdle,
	renderPanel,
	scrollOffset,
	textWidth,
	toPixmap,
	PANEL_W
} from "../src/render";

const base = {
	title: "Title",
	artist: "Artist",
	album: "Album",
	app: "TIDAL",
	status: "playing" as const
};

describe("textWidth", () => {
	it("scales with font size", () => {
		expect(textWidth("hello", 20)).toBeCloseTo(textWidth("hello", 10) * 2, 5);
	});

	it("treats narrow and wide glyphs differently", () => {
		expect(textWidth("iiii", 15)).toBeLessThan(textWidth("mmmm", 15));
	});

	it("is zero for an empty string", () => {
		expect(textWidth("", 15)).toBe(0);
	});
});

describe("scrollOffset", () => {
	it("does not scroll text that fits", () => {
		for (let t = 0; t < 20_000; t += 137) {
			expect(scrollOffset("Hi", 15, PANEL_W, t)).toBe(0);
		}
	});

	it("never scrolls past the end of the string", () => {
		// A marquee that overshoots leaves the line blank at the extreme of its
		// travel, which looks like a rendering fault rather than a scroll.
		const text = "A Very Long Track Name That Will Not Fit On The Panel At All";
		const overflow = textWidth(text, 15) - PANEL_W;
		expect(overflow).toBeGreaterThan(0);

		let sawStart = false;
		let sawEnd = false;
		for (let t = 0; t < 120_000; t += 53) {
			const offset = scrollOffset(text, 15, PANEL_W, t);
			expect(offset).toBeGreaterThanOrEqual(-0.001);
			expect(offset).toBeLessThanOrEqual(overflow + 0.001);
			if (offset < 0.001) sawStart = true;
			if (offset > overflow - 0.001) sawEnd = true;
		}
		// Both extremes must be reachable or part of the title is never shown.
		expect(sawStart).toBe(true);
		expect(sawEnd).toBe(true);
	});

	it("returns to the start so the cycle repeats", () => {
		const text = "Another Extremely Long Track Title For Scrolling Purposes";
		expect(scrollOffset(text, 15, PANEL_W, 0)).toBe(0);
	});
});

describe("overflows", () => {
	it("agrees with textWidth", () => {
		expect(overflows("x", 15, PANEL_W)).toBe(false);
		expect(overflows("x".repeat(200), 15, PANEL_W)).toBe(true);
	});
});

describe("renderPanel", () => {
	it("produces a correctly sized SVG", () => {
		const svg = renderPanel(base, 0);
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain('width="104"');
		expect(svg).toContain('height="100"');
		expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
	});

	it("shows title, artist and album", () => {
		const svg = renderPanel({ ...base, title: "Karma Police", artist: "Radiohead", album: "OK Computer" }, 0);
		expect(svg).toContain("Karma Police");
		expect(svg).toContain("Radiohead");
		expect(svg).toContain("OK Computer");
	});

	it("escapes XML so ampersands in metadata cannot break the drawing", () => {
		// Real track and artist names contain these constantly. Emitting them
		// raw yields malformed SVG, which Stream Deck silently refuses to draw,
		// leaving a blank panel with no error anywhere.
		const svg = renderPanel({ ...base, title: "Me & You", artist: "<script>", album: "A > B" }, 0);
		expect(svg).toContain("Me &amp; You");
		expect(svg).toContain("&lt;script&gt;");
		expect(svg).toContain("A &gt; B");
		expect(svg).not.toContain("<script>");
	});

	it("escapes double quotes, which an attribute would need", () => {
		// Nothing here puts metadata in an attribute today, so this is about
		// the escaper rather than the caller: a helper called "escape" invites
		// attribute use, and CodeQL raised exactly that against the Teams
		// plugin once the same helper had grown attribute callers.
		const svg = renderPanel({ ...base, title: 'He said "hi"' }, 0);

		expect(svg).toContain("He said &quot;hi&quot;");
		expect(svg).not.toContain('He said "hi"');
	});

	it("fills the progress bar in proportion to position", () => {
		const half = renderPanel({ ...base, position: 50_000, duration: 100_000 }, 0);
		// Track plus fill: the fill is the second rounded rect on the bar row.
		expect(half).toContain('y="62"');
		const widths = [...half.matchAll(/y="62" width="([\d.]+)"/g)].map((m) => Number(m[1]));
		expect(widths.length).toBe(2);
		expect(widths[0]).toBe(PANEL_W);
		expect(widths[1]).toBeCloseTo(PANEL_W / 2, 1);
	});

	it("clamps a position beyond the duration", () => {
		const svg = renderPanel({ ...base, position: 999_000, duration: 100_000 }, 0);
		const widths = [...svg.matchAll(/y="62" width="([\d.]+)"/g)].map((m) => Number(m[1]));
		expect(widths[1]).toBeLessThanOrEqual(PANEL_W);
	});

	it("replaces the transport row with a volume readout when adjusting", () => {
		const svg = renderPanel(
			{ ...base, volume: { level: 0.42, muted: false, label: "TIDAL" }, position: 1000, duration: 2000 },
			0
		);
		expect(svg).toContain("42%");
		// The transport clock must give way, not sit alongside the readout.
		expect(svg).not.toContain("0:01");
	});

	it("labels the readout with the player, since the dial drives its mixer entry", () => {
		const svg = renderPanel({ ...base, volume: { level: 0.5, muted: false, label: "Plexamp" } }, 0);
		expect(svg).toContain("PLEXAMP");
		expect(svg).not.toContain("SYSTEM");
	});

	it("shows MUTED rather than a percentage when muted", () => {
		const svg = renderPanel({ ...base, volume: { level: 0.42, muted: true, label: "TIDAL" } }, 0);
		expect(svg).toContain("MUTED");
		expect(svg).not.toContain("42%");
	});

	it("says EXCLUSIVE MODE instead of a percentage when the player owns the endpoint", () => {
		// The dial's writes still succeed and the level still reads back, so a
		// percentage would imply something is happening when nothing reaches
		// the speakers.
		const svg = renderPanel(
			{ ...base, volume: { level: 0.42, muted: false, label: "Plex", exclusive: true } },
			0
		);
		expect(svg).toContain("EXCLUSIVE MODE");
		expect(svg).toContain("no volume control");
		expect(svg).not.toContain("42%");
		// No bar either: an empty track would read as "volume is at zero".
		expect(svg).not.toContain('y="62"');
	});

	it("shows a normal percentage when the player is not exclusive", () => {
		const svg = renderPanel(
			{ ...base, volume: { level: 0.42, muted: false, label: "Plex", exclusive: false } },
			0
		);
		expect(svg).toContain("42%");
		expect(svg).not.toContain("EXCLUSIVE");
	});

	it("keeps the exclusive notice within the panel width", () => {
		const svg = renderPanel({ ...base, volume: { level: 1, muted: false, label: "Plex", exclusive: true } }, 0);
		expect(textWidth("EXCLUSIVE MODE", 11)).toBeLessThanOrEqual(PANEL_W);
		expect(textWidth("no volume control", 9)).toBeLessThanOrEqual(PANEL_W);
		expect(svg).toContain(`x="${PANEL_W / 2}"`);
	});

	it("says NO MIXER when the player has no volume mixer entry", () => {
		// A player that released its audio stream has nothing to adjust. The
		// dial must say so rather than show a misleading 0% or quietly move
		// the system slider instead.
		const svg = renderPanel({ ...base, volume: { level: undefined, muted: false, label: "TIDAL" } }, 0);
		expect(svg).toContain("NO MIXER");
		expect(svg).not.toContain("0%");
		// Bar drawn as an empty track, with no fill segment.
		const widths = [...svg.matchAll(/y="62" width="([\d.]+)"/g)].map((m) => Number(m[1]));
		expect(widths).toEqual([PANEL_W]);
	});

	it("truncates a long player name so it cannot collide with the readout", () => {
		const svg = renderPanel(
			{ ...base, volume: { level: 0.42, muted: false, label: "A Very Long Player Name Indeed" } },
			0
		);
		expect(svg).toContain("42%");
		expect(svg).toContain("\u2026");
		expect(svg).not.toContain("A VERY LONG PLAYER NAME INDEED");
	});

	it("formats times as m:ss", () => {
		const svg = renderPanel({ ...base, position: 95_000, duration: 160_000 }, 0);
		expect(svg).toContain("1:35");
		expect(svg).toContain("2:40");
	});

	it("shows the player instead of an empty progress row when there is no timeline", () => {
		// Plex's desktop app publishes transport controls and metadata but
		// never a position or duration. A dead bar over two "--:--"
		// placeholders looks like a fault rather than a missing feature.
		const svg = renderPanel({ ...base, app: "Plex" }, 0);
		expect(svg).not.toContain("--:--");
		expect(svg).toContain("PLEX");
		// No progress bar row is drawn at all.
		expect(svg).not.toContain('y="62"');
	});

	it("still draws the progress row when a duration is known", () => {
		const svg = renderPanel({ ...base, position: 30_000, duration: 60_000 }, 0);
		expect(svg).toContain('y="62"');
		expect(svg).toContain("0:30");
		expect(svg).toContain("1:00");
	});
});

describe("renderIdle", () => {
	it("uses the whole 200x100 canvas, not the narrow panel", () => {
		// The point of the separate idle layout: the message gets the full
		// strip instead of the 104px left over beside the album art slot.
		const svg = renderIdle("Nothing playing");
		expect(svg).toContain(`width="${CANVAS_W}"`);
		expect(svg).toContain('height="100"');
		expect(svg).not.toContain(`width="${PANEL_W}"`);
	});

	it("shows the message", () => {
		expect(renderIdle("Nothing playing")).toContain("Nothing playing");
	});

	it("sets the message far larger than the old panel text", () => {
		const size = Number(/font-size="([\d.]+)" font-weight="600"/.exec(renderIdle("Nothing playing"))?.[1]);
		expect(size).toBeGreaterThanOrEqual(19);
	});

	it("draws nothing but the message", () => {
		// Deliberately text only: a decorative glyph beside one short line
		// made the idle panel busier than the state it represents.
		const svg = renderIdle("Nothing playing");
		expect(svg).not.toContain("<ellipse");
		expect(svg).not.toContain("<path");
		expect(svg).not.toContain("<g ");
		expect(svg).not.toContain("\u266a");
		// Background plus the one line of text.
		expect((svg.match(/<text/g) ?? []).length).toBe(1);
		expect((svg.match(/<rect/g) ?? []).length).toBe(1);
	});

	it("does not draw an album art placeholder", () => {
		const svg = renderIdle("Nothing playing");
		expect(svg).not.toContain('rx="6"');
		expect(svg).not.toContain("#1c1c21");
	});

	it("shrinks, then truncates, so a long message always fits the canvas", () => {
		const long = "Waiting for Some Extremely Long Player Name";
		const svg = renderIdle(long);
		const size = Number(/font-size="([\d.]+)" font-weight="600"/.exec(svg)?.[1]);
		expect(size).toBeLessThan(21);

		// Measure what is actually drawn, not what was asked for.
		const drawn = /font-weight="600"[^>]*>([^<]*)</.exec(svg)?.[1] ?? "";
		expect(drawn.length).toBeGreaterThan(8);
		expect(textWidth(drawn, size)).toBeLessThanOrEqual(CANVAS_W - 24);
	});

	it("keeps the largest size for a short message", () => {
		const size = Number(/font-size="([\d.]+)" font-weight="600"/.exec(renderIdle("Paused"))?.[1]);
		expect(size).toBe(21);
	});

	it("centres the message vertically on the empty canvas", () => {
		expect(renderIdle("Nothing playing")).toContain(`x="${CANVAS_W / 2}" y="58" text-anchor="middle"`);
	});

	it("adds a second line when given detail, and lifts the first to stay balanced", () => {
		const svg = renderIdle("Waiting for Plexamp", "Start playback to take control");
		expect(svg).toContain("Start playback to take control");
		expect(svg).toContain('y="50"');
		expect(svg).toContain('y="70"');
	});

	it("escapes XML in the message", () => {
		expect(renderIdle("Waiting for Me & You")).toContain("Me &amp; You");
	});
});

describe("toPixmap", () => {
	it("base64 encodes, because a raw hash would truncate the data URI", () => {
		const uri = toPixmap('<svg fill="#ff0000"/>');
		expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
		const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
		expect(decoded).toBe('<svg fill="#ff0000"/>');
	});
});
