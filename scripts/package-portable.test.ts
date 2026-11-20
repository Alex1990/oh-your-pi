import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION_STAMP_MAGIC, VERSION_STAMP_SIZE } from "../packages/natives/native/version-sentinel.js";
import {
	assertImageRuntime,
	imageRuntimePackages,
	pruneOptionalPlatformPackages,
	verifyPackagedAddon,
} from "./package-portable";

const VERSION = "18.12.2";

function image(payload: string): Buffer {
	const slot = Buffer.alloc(VERSION_STAMP_SIZE);
	slot.write(payload, "latin1");
	return Buffer.concat([Buffer.from("\x7fELF-head"), slot, Buffer.from("tail-bytes")]);
}

function stamped(version: string): Buffer {
	return image(`${VERSION_STAMP_MAGIC}${version}`);
}

async function withAddon(bytes: Buffer | null, run: (addonPath: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oyp-package-portable-"));
	const addonPath = path.join(dir, "pi_natives.darwin-arm64.node");
	try {
		if (bytes) await fs.writeFile(addonPath, bytes);
		await run(addonPath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("verifyPackagedAddon", () => {
	it("accepts an addon stamped for the packaged release", async () => {
		await withAddon(stamped(VERSION), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).resolves.toBeUndefined();
		});
	});

	it("accepts a pre-stamp addon whose legacy sentinel names the packaged release", async () => {
		await withAddon(image("__piNativesV18_12_2"), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).resolves.toBeUndefined();
		});
	});

	it("rejects the empty stamp slot a raw bazel addon carries", async () => {
		await withAddon(image(VERSION_STAMP_MAGIC), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow(
				`does not carry the @oh-my-pi/pi-natives@${VERSION} version stamp`,
			);
		});
	});

	it("rejects an addon stamped for another release", async () => {
		await withAddon(stamped("18.11.0"), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow("does not carry");
		});
	});

	it("reports a missing addon instead of packaging without it", async () => {
		await withAddon(null, async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow(`Native addon ${addonPath} is missing`);
		});
	});
});

type StagedPackage = { version: string; optionalDependencies?: Record<string, string> };

async function withStagedModules(
	packages: Record<string, StagedPackage>,
	run: (nodeModules: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oyp-portable-deps-"));
	try {
		for (const [name, manifest] of Object.entries(packages)) {
			const file = path.join(dir, name, "package.json");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, JSON.stringify({ name, ...manifest }));
		}
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function stagedPackageNames(nodeModules: string): Promise<string[]> {
	const names: string[] = [];
	for (const entry of await fs.readdir(nodeModules)) {
		if (entry.startsWith("@")) {
			for (const child of await fs.readdir(path.join(nodeModules, entry))) names.push(`${entry}/${child}`);
		} else {
			names.push(entry);
		}
	}
	return names.sort();
}

const SHARP_BINARIES: Record<string, StagedPackage> = {
	sharp: {
		version: "0.34.5",
		optionalDependencies: {
			"@img/sharp-darwin-arm64": "0.34.5",
			"@img/sharp-libvips-darwin-arm64": "1.2.4",
		},
	},
	"@img/colour": { version: "1.1.0" },
	"@img/sharp-win32-x64": { version: "0.34.5" },
	"@img/sharp-win32-arm64": { version: "0.34.5" },
	"@img/sharp-win32-ia32": { version: "0.34.5" },
	"@img/sharp-darwin-arm64": { version: "0.34.5" },
	"@img/sharp-libvips-darwin-arm64": { version: "1.2.4" },
	"@img/sharp-darwin-x64": { version: "0.34.5" },
	"@img/sharp-libvips-darwin-x64": { version: "1.2.4" },
	"@img/sharp-linuxmusl-x64": { version: "0.34.5" },
	"@img/sharp-wasm32": { version: "0.34.5" },
};

describe("imageRuntimePackages", () => {
	it("names the sharp binary and, off Windows, its libvips sibling", () => {
		expect(imageRuntimePackages({ platform: "win32", arch: "x64" })).toEqual(["sharp", "@img/sharp-win32-x64"]);
		expect(imageRuntimePackages({ platform: "darwin", arch: "arm64" })).toEqual([
			"sharp",
			"@img/sharp-darwin-arm64",
			"@img/sharp-libvips-darwin-arm64",
		]);
		expect(imageRuntimePackages({ platform: "linux", arch: "x64", sharpTag: "linuxmusl-x64" })).toEqual([
			"sharp",
			"@img/sharp-linuxmusl-x64",
			"@img/sharp-libvips-linuxmusl-x64",
		]);
	});
});

describe("pruneOptionalPlatformPackages", () => {
	it("keeps only the Windows x64 sharp binaries", async () => {
		await withStagedModules(SHARP_BINARIES, async nodeModules => {
			await pruneOptionalPlatformPackages(nodeModules, { platform: "win32", arch: "x64" });
			expect(await stagedPackageNames(nodeModules)).toEqual(["@img/colour", "@img/sharp-win32-x64", "sharp"]);
		});
	});

	it("keeps only the Darwin arm64 sharp binaries and libvips", async () => {
		await withStagedModules(SHARP_BINARIES, async nodeModules => {
			await pruneOptionalPlatformPackages(nodeModules, { platform: "darwin", arch: "arm64" });
			expect(await stagedPackageNames(nodeModules)).toEqual([
				"@img/colour",
				"@img/sharp-darwin-arm64",
				"@img/sharp-libvips-darwin-arm64",
				"sharp",
			]);
		});
	});
});

describe("assertImageRuntime", () => {
	it("rejects a target whose sharp binary was not staged", async () => {
		await withStagedModules(
			{
				sharp: SHARP_BINARIES.sharp,
				"@img/sharp-libvips-darwin-arm64": { version: "1.2.4" },
			},
			async nodeModules => {
				await expect(assertImageRuntime(nodeModules, { platform: "darwin", arch: "arm64" })).rejects.toThrow(
					"missing image runtime package(s): @img/sharp-darwin-arm64",
				);
			},
		);
	});

	it("rejects a binary that does not match sharp's pinned version", async () => {
		await withStagedModules(
			{
				sharp: SHARP_BINARIES.sharp,
				"@img/sharp-darwin-arm64": { version: "0.35.5" },
				"@img/sharp-libvips-darwin-arm64": { version: "1.2.4" },
			},
			async nodeModules => {
				await expect(assertImageRuntime(nodeModules, { platform: "darwin", arch: "arm64" })).rejects.toThrow(
					"carries @img/sharp-darwin-arm64@0.35.5",
				);
			},
		);
	});

	it("accepts a target with an aligned sharp binary and libvips", async () => {
		await withStagedModules(
			{
				sharp: SHARP_BINARIES.sharp,
				"@img/sharp-darwin-arm64": { version: "0.34.5" },
				"@img/sharp-libvips-darwin-arm64": { version: "1.2.4" },
			},
			async nodeModules => {
				await expect(
					assertImageRuntime(nodeModules, { platform: "darwin", arch: "arm64" }),
				).resolves.toBeUndefined();
			},
		);
	});
});
