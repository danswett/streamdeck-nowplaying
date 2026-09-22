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

const beforeVolume = await currentVolume();
console.log(`-- system volume before rotate: ${beforeVolume}`);

send({
	event: "dialRotate",
	action: "com.dswett.nowplaying.dial",
	context: CONTEXT,
	device: DEVICE,
	payload: { settings: {}, coordinates: { column: 0, row: 0 }, ticks: -4, pressed: false }
});
await wait(1200);
const afterVolume = await currentVolume();
console.log(`-- system volume after -4 ticks: ${afterVolume}`);

const volumePanel = decode([...sent].reverse().find((m) => m.event === "setFeedback" && m.payload?.panel)?.payload?.panel);
const showsVolume = volumePanel.includes("SYSTEM");

// Put the volume back where it started.
send({
	event: "dialRotate",
	action: "com.dswett.nowplaying.dial",
	context: CONTEXT,
	device: DEVICE,
	payload: { settings: {}, coordinates: { column: 0, row: 0 }, ticks: 4, pressed: false }
});
await wait(800);
const restoredVolume = await currentVolume();
console.log(`-- system volume restored: ${restoredVolume}`);

async function currentVolume() {
	const frame = [...sent].reverse().find((m) => m.event === "setFeedback");
	// Volume is not echoed in feedback; read it from the sidecar snapshot.
	const { execFileSync } = await import("node:child_process");
	const exe = path.join(pluginDir, "bin", "bridge", "SmtcBridge.exe");
	try {
		const out = execFileSync(exe, ["--once"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		return Number(JSON.parse(out).volume.toFixed(3));
	} catch {
		return frame ? NaN : NaN;
	}
}

// -- assertions ----------------------------------------------------------

const checks = [
	["layout applied", layouts[0]?.payload?.layout === "layouts/nowplaying.json"],
	["trigger descriptions sent", !!triggers[0]?.payload?.rotate],
	["panel rendered", panelSvg.startsWith("<svg")],
	["panel is 104x100", panelSvg.includes('width="104"') && panelSvg.includes('height="100"')],
	["artwork delivered", !!lastArt],
	["track title on panel", panelSvg.includes("Making A Killing") || panelSvg.includes("Nothing playing")],
	["progress or volume row drawn", panelSvg.includes("<rect") && panelSvg.includes("rx=\"2\"")],
	["rotate changed system volume", Number.isFinite(beforeVolume) && Number.isFinite(afterVolume) && afterVolume < beforeVolume],
	["volume overlay shown while adjusting", showsVolume],
	["volume restored", Math.abs(restoredVolume - beforeVolume) < 0.02],
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
