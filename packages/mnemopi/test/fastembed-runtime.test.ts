import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { createRequire } from "node:module";
import * as path from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import {
	fastembedRuntimeInstallPlan,
	prepareWindowsFastembedRuntime,
	resolveFastembedPackage,
} from "../src/core/fastembed-runtime";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

// The fastembed peer is pinned as an exact version (not `catalog:`) because
// `core/fastembed-runtime.ts` reads it to `bun install` the on-demand embedding
// runtime — including from bundles where the inlined manifest would otherwise
// carry an uninstallable `catalog:` spec (#2389). The runtime cache must keep
// fastembed's own ORT dependency intact because its native addon links against
// that exact bundled library name (#3054).
describe("fastembed runtime version pins", () => {
	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("runtime install preserves fastembed's transitive onnxruntime pin", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.dependencies).toEqual({
			fastembed: packageManifest.peerDependencies.fastembed,
		});
		expect(plan.install.overrides?.["onnxruntime-node"]).toBeUndefined();
		expect(plan.install.trustedDependencies).toEqual(["onnxruntime-node"]);
		expect(plan.versionKey).toContain("transitive-ort");
		expect(plan.versionKey).not.toContain("forced-ort");
	});

	test("runtime install overrides tokenizers to a release with linux-arm64 bindings", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.overrides).toEqual({ "@anush008/tokenizers": "0.6.0" });
		expect(plan.versionKey).toContain("tokenizers-0.6.0");
	});

	test("resolves the fastembed root from its exported entry, not the hidden manifest subpath", async () => {
		const requireTest = createRequire(import.meta.url);
		const entry = requireTest.resolve("fastembed");
		// Fastembed's `exports` map exposes only the package root, so
		// `fastembed/package.json` throws ERR_PACKAGE_PATH_NOT_EXPORTED under Node.
		const { packageDir, manifest } = await resolveFastembedPackage(entry);

		expect(entry.startsWith(`${packageDir}${path.sep}`)).toBe(true);
		expect(manifest.version).toBe(packageManifest.peerDependencies.fastembed);
	});

	test("Windows preload selects fastembed's ORT DLL before inherited paths", async () => {
		const requireTest = createRequire(import.meta.url);
		const fastembedEntry = requireTest.resolve("fastembed");
		const { packageDir: fastembedPackageDir } = await resolveFastembedPackage(fastembedEntry);
		const inheritedPath = ["/stale-ort", "/system"].join(path.delimiter);
		const env: NodeJS.ProcessEnv = { PATH: inheritedPath };
		const { ortEntry, ortPackageDir, dllDir } = await prepareWindowsFastembedRuntime({
			fastembedEntry,
			fastembedPackageDir,
			arch: "x64",
			env,
		});
		const ortManifest: { version?: unknown } = requireTest(path.join(ortPackageDir, "package.json"));

		expect(ortManifest.version).toBe(packageManifest.peerDependencies["onnxruntime-node"]);
		expect(ortEntry.startsWith(`${ortPackageDir}${path.sep}`)).toBe(true);
		expect(await bun.file(path.join(dllDir, "onnxruntime.dll")).exists()).toBe(true);
		expect(env.PATH).toBe(`${dllDir}${path.delimiter}${inheritedPath}`);
	});
});
