/**
 * Smoke test for the SMTC bridge.
 *
 * Drives the sidecar the same way the plugin does - spawn, read newline JSON,
 * write commands - so protocol regressions surface here rather than on the
 * device. Restores playback state before exiting.
 *
 *   node tools/bridge-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const exe =
	process.env.SMTC_BRIDGE_EXE ??
	path.join(root, "bridge", "bin", "Release", "net10.0-windows10.0.19041.0", "win-x64", "SmtcBridge.exe");

console.log(`-- bridge: ${exe}\n`);

const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
const frames = [];

child.stderr.on("data", (d) => console.error("[stderr]", String(d).trim()));

createInterface({ input: child.stdout }).on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		console.error("NON-JSON LINE:", line.slice(0, 120));
		process.exitCode = 1;
		return;
	}
	frames.push(msg);
	if (msg.type === "state") {
		// Stamped on arrival so extrapolation can be checked against wall time.
		msg.observedAt = Date.now();
		const s = msg.sessions[0];
		console.log(
			`state current=${msg.current ?? "-"} vol=${msg.volume.toFixed(2)}` +
				(s
					? ` | ${s.app} ${s.status} "${s.title}" pos=${s.positionMs}/${s.durationMs}` +
						` art=${s.art ? `${s.art.length}B` : `cached(${s.artId})`} appVol=${s.appVolume ?? "-"}`
					: " | no sessions")
		);
	} else {
		console.log(JSON.stringify(msg));
	}
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ackFor = (id) => frames.find((f) => f.type === "ack" && f.id === id);

await wait(1200);
const first = frames.find((f) => f.type === "state");
if (!first) {
	console.error("FAIL: no initial state frame");
	child.kill();
	process.exit(1);
}
const startedPaused = first.sessions[0]?.status !== "playing";
console.log(`\n-- initial status: ${first.sessions[0]?.status ?? "none"} (art sent: ${!!first.sessions[0]?.art})\n`);

console.log("-- refresh (should resend art) --");
send({ id: 9, cmd: "refresh" });
await wait(600);

console.log("\n-- toggle play --");
send({ id: 1, cmd: "toggle" });
await wait(2500);

const playing = frames.filter((f) => f.type === "state").at(-1);
console.log(`\n-- status now: ${playing?.sessions[0]?.status}, appVolume: ${playing?.sessions[0]?.appVolume ?? "null"}\n`);

console.log("-- restoring original state --");
if (startedPaused) send({ id: 2, cmd: "toggle" });
await wait(1200);

const final = frames.filter((f) => f.type === "state").at(-1);

// -- assertions ---------------------------------------------------------

const checks = [
	["initial state frame", !!first],
	["art delivered once", !!first.sessions[0]?.art],
	["art suppressed on repeat", frames.filter((f) => f.type === "state").slice(1, 3).some((f) => f.sessions[0] && !f.sessions[0].art)],
	["refresh acked", ackFor(9)?.ok === true],
	["toggle acked", ackFor(1)?.ok === true],
	["playback started", frames.some((f) => f.type === "state" && f.sessions[0]?.status === "playing")],
	// SMTC republishes the timeline only on discrete events, so positionMs sits
	// still for seconds at a time while audio plays. The contract the plugin
	// relies on is positionMs + (now - positionAt), which must advance.
	["extrapolated position advances", (() => {
		const playing = frames.filter((f) => f.type === "state" && f.sessions[0]?.status === "playing");
		if (playing.length < 2) return false;
		const at = (f) => f.sessions[0].positionMs + (f.observedAt - f.sessions[0].positionAt);
		const first = at(playing[0]);
		const last = at(playing.at(-1));
		console.log(`   extrapolated ${first}ms -> ${last}ms over ${playing.at(-1).observedAt - playing[0].observedAt}ms wall`);
		return last > first;
	})()],
	["position sample is sane", (() => {
		const s = frames.filter((f) => f.type === "state").at(-1)?.sessions[0];
		if (!s?.durationMs) return false;
		return s.positionMs >= 0 && s.positionMs <= s.durationMs && Math.abs(Date.now() - s.positionAt) < 60_000;
	})()],
	["per-app volume resolved while playing", frames.some((f) => f.type === "state" && f.sessions[0]?.appVolume != null)],
	["restored status", !startedPaused || final?.sessions[0]?.status === "paused"]
];

console.log("\n=== results ===");
let failed = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) failed++;
}

child.stdin.end();
await wait(400);
child.kill();

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
