import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { EXECUTABLE_ENTRIES, writeReleaseTarball } from "./ci-release-archive";

interface TarEntry {
	readonly name: string;
	readonly mode: number;
	readonly type: string;
	readonly content: Buffer;
}

/**
 * Minimal ustar reader: enough to prove the modes and paths a Mac sees after
 * extraction, including entries that needed a pax header for a long path.
 */
function parseTar(raw: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let paxPath: string | undefined;
	while (offset + 512 <= raw.length) {
		const block = raw.subarray(offset, offset + 512);
		if (block.every(byte => byte === 0)) break;
		offset += 512;
		const field = (start: number, end: number) => block.toString("latin1", start, end).replace(/\0.*$/, "").trim();
		const mode = Number.parseInt(field(100, 108) || "0", 8);
		const size = Number.parseInt(field(124, 136) || "0", 8);
		const type = block.toString("latin1", 156, 157);
		// bsdtar refuses the whole archive when a header checksum is wrong, so the
		// reader verifies it too instead of trusting our own writer.
		const blanked = Buffer.from(block);
		blanked.fill(0x20, 148, 156);
		const sum = blanked.reduce((total, byte) => total + byte, 0);
		expect(Number.parseInt(field(148, 156) || "0", 8)).toBe(sum);
		const content = Buffer.from(raw.subarray(offset, offset + size));
		offset += Math.ceil(size / 512) * 512;
		if (type === "x") {
			const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString("utf8"));
			paxPath = match?.[1];
			continue;
		}
		const name = paxPath ?? block.toString("utf8", 0, 100).replace(/\0.*$/, "");
		paxPath = undefined;
		entries.push({ name, mode, type, content });
	}
	return entries;
}

async function withStage(run: (stage: string, out: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oyp-release-archive-"));
	const stage = path.join(dir, "oyp-darwin-arm64");
	const out = path.join(dir, "oyp-darwin-arm64.tar.gz");
	try {
		await fs.mkdir(path.join(stage, "runtime"), { recursive: true });
		await fs.writeFile(path.join(stage, "oyp"), "#!/bin/sh\nexec runtime/node app/cli.js\n");
		await fs.writeFile(path.join(stage, "runtime", "node"), "runtime-bytes");
		await fs.writeFile(path.join(stage, "install.sh"), "#!/bin/sh\n");
		await fs.mkdir(path.join(stage, "app"), { recursive: true });
		await fs.writeFile(path.join(stage, "app", "cli.js"), "console.log(1)\n");
		await run(stage, out);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("writeReleaseTarball", () => {
	it("marks the launcher, bundled runtime and installer executable", async () => {
		await withStage(async (stage, out) => {
			await writeReleaseTarball(stage, out);
			const entries = parseTar(zlib.gunzipSync(await fs.readFile(out)));
			const modes = new Map(entries.map(entry => [entry.name, entry.mode]));
			for (const executable of EXECUTABLE_ENTRIES) {
				expect(modes.get(`oyp-darwin-arm64/${executable}`)).toBe(0o755);
			}
			expect(modes.get("oyp-darwin-arm64/app/cli.js")).toBe(0o644);
			expect(modes.get("oyp-darwin-arm64/app/")).toBe(0o755);
			const cli = entries.find(entry => entry.name === "oyp-darwin-arm64/app/cli.js");
			expect(cli?.content.toString("utf8")).toBe("console.log(1)\n");
		});
	});

	it("keeps paths too long for a ustar header", async () => {
		await withStage(async (stage, out) => {
			const deep = path.join(
				stage,
				"app",
				"node_modules",
				...Array.from({ length: 6 }, (_, i) => `very-long-package-name-${i}`),
			);
			await fs.mkdir(deep, { recursive: true });
			const longRelative =
				"app/node_modules/" +
				Array.from({ length: 6 }, (_, i) => `very-long-package-name-${i}`).join("/") +
				"/index.js";
			expect(longRelative.length).toBeGreaterThan(100);
			await fs.writeFile(path.join(deep, "index.js"), "export default 1\n");
			await writeReleaseTarball(stage, out);
			const entries = parseTar(zlib.gunzipSync(await fs.readFile(out)));
			const entry = entries.find(candidate => candidate.name === `oyp-darwin-arm64/${longRelative}`);
			expect(entry?.content.toString("utf8")).toBe("export default 1\n");
		});
	});
});
