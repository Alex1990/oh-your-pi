import { afterEach, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { handleStatic } from "../src/server";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("serves built assets with the MIME types the browser requires", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-static-"));
	tempDirs.push(dir);
	await bun.write(path.join(dir, "index.html"), '<!doctype html><script type="module" src="index.js"></script>');
	await bun.write(path.join(dir, "index.js"), 'document.title = "loaded";');
	await bun.write(path.join(dir, "index.css"), "body { color: blue; }");

	// A module script served as `application/octet-stream` is refused by the
	// browser, which leaves the dashboard root empty.
	const js = await handleStatic("/index.js", dir);
	expect(js.status).toBe(200);
	expect(js.headers.get("content-type")).toBe("text/javascript");
	expect(await js.text()).toBe('document.title = "loaded";');

	const page = await handleStatic("/", dir);
	expect(page.headers.get("content-type")).toBe("text/html");

	const css = await handleStatic("/index.css", dir);
	expect(css.headers.get("content-type")).toBe("text/css");

	// Unknown routes fall back to the SPA shell, which must still parse as HTML.
	const route = await handleStatic("/traces/session", dir);
	expect(route.status).toBe(200);
	expect(route.headers.get("content-type")).toBe("text/html");
	expect(await route.text()).toContain('<script type="module"');
});
