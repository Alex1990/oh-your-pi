import { afterEach, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "../src/node-build";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function buildEntry(
	source: string,
	naming: string | { entry?: string; chunk?: string; asset?: string },
	platform?: "browser" | "node",
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-node-build-naming-"));
	tempDirs.push(root);
	await fs.mkdir(path.join(root, "src"));
	await fs.writeFile(path.join(root, "src/index.ts"), source);
	await fs.writeFile(path.join(root, "src/style.css"), "body { color: red; }");
	const result = await build({
		entrypoints: [path.join(root, "src/index.ts")],
		outdir: path.join(root, "dist"),
		root,
		naming,
		platform,
	});
	expect(result.logs).toEqual([]);
	return {
		names: result.outputs.map(file => path.basename(file.path)).sort(),
		code: result.outputs.find(file => file.path.endsWith(".js"))!,
	};
}

test("Bun naming templates produce the requested file names", async () => {
	// Bun naming is a complete file name; esbuild appends its own extension, so
	// the template must not keep both ("index.js.js" leaves the dashboard blank).
	const templated = await buildEntry('import "./style.css";\nexport const value = 1;\n', "[dir]/[name].[ext]");
	expect(templated.names).toEqual(["index.css", "index.js"]);

	// A literal name must stay literal.
	expect((await buildEntry("export const value = 1;\n", "cli.js")).names).toEqual(["cli.js"]);

	// The object form goes through the same translation; callers read "app.js" back.
	expect(
		(await buildEntry("export const value = 1;\n", { entry: "app.js", chunk: "[name]-[hash].js" })).names,
	).toEqual(["app.js"]);
});

test("browser bundles do not inject the Node require banner", async () => {
	// The banner imports "node:module", which a module script cannot resolve; the
	// dashboard dies before rendering.
	const browser = await buildEntry("export const value = 1;\n", "[dir]/[name].[ext]", "browser");
	expect(await browser.code.text()).not.toContain("node:module");
});
