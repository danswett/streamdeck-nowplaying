/**
 * End-to-end harness that impersonates Stream Deck.
 *
 * The plugin only does anything once an action is placed on a dial, which
 * would otherwise make every change untestable without physically rearranging
 * a profile. This speaks the same websocket protocol Stream Deck does, so the
 * real plugin.js - with the real sidecar behind it - can be driven and its
 * rendered output inspected.
 *
 *   node tools/harness.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "com.dswett.nowplaying.sdPlugin");
const entry = path.join(pluginDir, "bin", "plugin.js");

const CONTEXT = "ctx-dial-0";
const DEVICE = "dev-plus-0";

const sent = [];
let socket;

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((resolve) => wss.once("listening", resolve));
const port = wss.address().port;

const info = {
	application: {
		font: "Segoe UI",
		language: "en",
		platform: "windows",
		platformVersion: "10.0.26100",
		version: "7.5.1.22901"
	},
	plugin: { uuid: "com.dswett.nowplaying", version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	// Type 7 is Stream Deck +, the only family with dials and a touch strip.
	devices: [{ id: DEVICE, name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }]
};

const child = spawn(
	process.execPath,
	[entry, "-port", String(port), "-pluginUUID", "harness-uuid", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
	{ cwd: pluginDir, stdio: ["ignore", "pipe", "pipe"] }
);

child.stdout.on("data", (d) => process.stdout.write(`[plugin] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[plugin:err] ${d}`));

const connected = new Promise((resolve) => {
	wss.on("connection", (ws) => {
		socket = ws;
		ws.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.event === "registerPlugin") {
				resolve();
				return;
			}
			sent.push(msg);
		});
	});
});

const send = (payload) => socket.send(JSON.stringify(payload));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await connected;
console.log("-- plugin registered\n");

send({
	event: "deviceDidConnect",
	device: DEVICE,
	deviceInfo: { name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }
});

send({
	event: "willAppear",
	action: "com.dswett.nowplaying.dial",
	context: CONTEXT,
	device: DEVICE,
	payload: {
		settings: {},
		coordinates: { column: 0, row: 0 },
		controller: "Encoder",
		isInMultiAction: false
	}
});

await wait(3000);

const feedbacks = sent.filter((m) => m.event === "setFeedback");
const layouts = sent.filter((m) => m.event === "setFeedbackLayout");
const triggers = sent.filter((m) => m.event === "setTriggerDescription");

const decode = (dataUri) => {
	if (typeof dataUri !== "string") return "";
	const comma = dataUri.indexOf(",");
	if (comma < 0) return "";
	if (!dataUri.startsWith("data:image/svg+xml;base64")) return `<binary ${dataUri.slice(5, 20)} ${dataUri.length}B>`;
	return Buffer.from(dataUri.slice(comma + 1), "base64").toString("utf8");
};

const lastPanel = [...feedbacks].reverse().find((f) => f.payload?.panel);
const lastArt = [...feedbacks].reverse().find((f) => f.payload?.art);
const panelSvg = decode(lastPanel?.payload?.panel);

console.log(`-- layout set: ${JSON.stringify(layouts[0]?.payload ?? "none")}`);
console.log(`-- trigger descriptions: ${JSON.stringify(triggers[0]?.payload ?? {})}`);
console.log(`-- setFeedback frames: ${feedbacks.length}`);
console.log(`-- art: ${decode(lastArt?.payload?.art).slice(0, 60)}`);
console.log(`\n-- panel SVG ------------------------------------------\n${panelSvg}\n`);

// -- interaction ---------------------------------------------------------

const exeForProbe = path.join(pluginDir, "bin", "bridge", "SmtcBridge.exe");

/** Reads audio state straight from the sidecar, independent of the plugin. */
async function readAudio() {
	const { execFileSync } = await import("node:child_process");
	try {
		const out = execFileSync(exeForProbe, ["--once"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		const parsed = JSON.parse(out);
		const s = parsed.sessions[0];
		return {
			system: Number(parsed.volume.toFixed(3)),
			app: s?.appVolume == null ? null : Number(s.appVolume.toFixed(3)),
			status: s?.status ?? "none",
			title: s?.title ?? ""
		};
	} catch (err) {
		console.error("probe failed:", String(err));
		return { system: NaN, app: null, status: "error", title: "" };
	}
}

const press = () => {
	send({ event: "dialDown", action: "com.dswett.nowplaying.dial", context: CONTEXT, device: DEVICE, payload: { settings: {}, controller: "Encoder" } });
	send({ event: "dialUp", action: "com.dswett.nowplaying.dial", context: CONTEXT, device: DEVICE, payload: { settings: {}, controller: "Encoder" } });
};

const rotate = (ticks) =>
	send({
		event: "dialRotate",
		action: "com.dswett.nowplaying.dial",
		context: CONTEXT,
		device: DEVICE,
		payload: { settings: {}, coordinates: { column: 0, row: 0 }, ticks, pressed: false }
	});

const atStart = await readAudio();
console.log(`-- initial: status=${atStart.status} system=${atStart.system} app=${atStart.app}`);

// A player only has a mixer entry while it holds an audio stream, so the
// volume path can only be exercised with something actually playing.
const startedPaused = atStart.status !== "playing";
if (startedPaused) {
	console.log("-- pressing dial to start playback");
	press();
	await wait(2000);
}

const playing = await readAudio();
console.log(`-- playing: status=${playing.status} system=${playing.system} app=${playing.app}`);

rotate(-4);
await wait(1200);
const lowered = await readAudio();
console.log(`-- after -4 ticks: system=${lowered.system} app=${lowered.app}`);

const volumePanel = decode([...sent].reverse().find((m) => m.event === "setFeedback" && m.payload?.panel)?.payload?.panel);

rotate(4);
await wait(1200);
const restored = await readAudio();
console.log(`-- after +4 ticks: system=${restored.system} app=${restored.app}`);

if (startedPaused) {
	console.log("-- pressing dial to restore paused state");
	press();
	await wait(1200);
}
const final = await readAudio();
console.log(`-- final: status=${final.status} system=${final.system} app=${final.app}\n`);

// -- assertions ----------------------------------------------------------

const checks = [
	["layout applied", layouts[0]?.payload?.layout === "layouts/nowplaying.json"],
	["trigger descriptions sent", !!triggers[0]?.payload?.rotate],
	["panel rendered", panelSvg.startsWith("<svg")],
	["panel is 104x100", panelSvg.includes('width="104"') && panelSvg.includes('height="100"')],
	["artwork delivered", !!lastArt],
	[
		// Compared against what the sidecar actually reports, not a fixed
		// string: the track changes as the test plays and pauses.
		`track title on panel (${atStart.title || "nothing playing"})`,
		atStart.title ? panelSvg.includes(atStart.title) : panelSvg.includes("Nothing playing")
	],
	["progress or volume row drawn", panelSvg.includes("<rect") && panelSvg.includes('rx="2"')],
	["press started playback", !startedPaused || playing.status === "playing"],
	["player has a mixer entry while playing", playing.app !== null],
	["rotate lowered the PLAYER's mixer volume", lowered.app !== null && playing.app !== null && lowered.app < playing.app],
	[
		"system volume left alone",
		Number.isFinite(playing.system) && Number.isFinite(lowered.system) && Math.abs(lowered.system - playing.system) < 0.001
	],
	["readout labelled with the player, not SYSTEM", volumePanel.includes("TIDAL") && !volumePanel.includes("SYSTEM")],
	["player volume restored", restored.app !== null && Math.abs(restored.app - playing.app) < 0.005],
	["playback state restored", !startedPaused || final.status !== "playing"],
	["no crash", child.exitCode === null]
];

console.log("=== results ===");
let failed = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) failed++;
}

send({ event: "willDisappear", action: "com.dswett.nowplaying.dial", context: CONTEXT, device: DEVICE, payload: { settings: {}, controller: "Encoder" } });
await wait(500);

child.kill();
wss.close();
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
