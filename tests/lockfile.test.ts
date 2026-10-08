/**
 * The lockfile must resolve from the public npm registry.
 *
 * `resolved` records whichever registry the machine that ran `npm install`
 * happened to be pointed at. A corporate proxy in a developer's user-level
 * .npmrc therefore writes its own host into the lockfile, and `npm ci` - here
 * and on the CI runner - then fetches from that host. It silently worked
 * because the feed in question was public, but it makes a public repository's
 * builds depend on a mirror nobody outside can be expected to reach, and it
 * reappears one entry at a time as dependencies are bumped.
 *
 * Nothing warns about it, so this does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REGISTRY = "https://registry.npmjs.org/";

type LockEntry = { resolved?: string };
type Lockfile = { packages?: Record<string, LockEntry> };

const lockfile = JSON.parse(
	readFileSync(path.resolve(__dirname, "..", "package-lock.json"), "utf8")
) as Lockfile;

/** Every entry that names a download, which excludes the root and any link. */
function resolvedEntries(): [string, string][] {
	return Object.entries(lockfile.packages ?? {})
		.filter(([, entry]) => typeof entry.resolved === "string")
		.map(([name, entry]) => [name, entry.resolved as string]);
}

describe("package-lock.json", () => {
	it("has entries to check", () => {
		expect(resolvedEntries().length).toBeGreaterThan(0);
	});

	it("resolves every package from the public npm registry", () => {
		const foreign = resolvedEntries()
			.filter(([, url]) => !url.startsWith(REGISTRY))
			.map(([name, url]) => `${name}: ${url}`);

		// Named in full, because the fix is to re-resolve exactly these.
		expect(foreign).toEqual([]);
	});
});
