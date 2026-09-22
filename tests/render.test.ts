import { describe, expect, it } from "vitest";

import { overflows, renderPanel, scrollOffset, textWidth, toPixmap, PANEL_W } from "../src/render";

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
		expect(svg).not.toMatch(/>Me & You</);
	});

	it("renders a message instead of track rows when idle", () => {
		const svg = renderPanel({ ...base, title: "", artist: "", album: "", message: "Nothing playing" }, 0);
		expect(svg).toContain("Nothing playing");
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
		const svg = renderPanel({ ...base, volume: 0.42, volumeScope: "system", position: 1000, duration: 2000 }, 0);
		expect(svg).toContain("SYSTEM");
		expect(svg).toContain("42%");
	});

	it("labels per-app volume with the app name", () => {
		const svg = renderPanel({ ...base, volume: 0.5, volumeScope: "app" }, 0);
		expect(svg).toContain("TIDAL");
	});

	it("shows MUTED rather than a percentage when muted", () => {
		const svg = renderPanel({ ...base, volume: 0.42, volumeScope: "system", muted: true }, 0);
		expect(svg).toContain("MUTED");
		expect(svg).not.toContain("42%");
	});

	it("formats times as m:ss", () => {
		const svg = renderPanel({ ...base, position: 95_000, duration: 160_000 }, 0);
		expect(svg).toContain("1:35");
		expect(svg).toContain("2:40");
	});

	it("shows placeholders when the duration is unknown", () => {
		const svg = renderPanel(base, 0);
		expect(svg).toContain("--:--");
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
