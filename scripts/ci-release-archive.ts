#!/usr/bin/env node
/**
 * Write a release tarball whose entries carry real Unix permissions.
 *
 * `tar.exe` shipped with Windows is bsdtar: it rejects `--mode`, and NTFS has no
 * executable bit, so `tar -czf` records 0666/0644 for everything. The extracted
 * `oyp` launcher and `runtime/node` are then non-executable. This walks the
 * staged tree and writes the ustar stream itself.
 *
 * Usage:
 *   node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
 *     scripts/ci-release-archive.ts --target-dir <staged-dir> --out <file.tar.gz> [--level 6]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { isMainModule } from "@oh-my-pi/pi-utils/node-runtime";

const BLOCK_SIZE = 512;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const EXECUTABLE_MODE = 0o755;
const SYMLINK_MODE = 0o777;

/** Bundle paths that must stay executable after extraction, relative to the staged root. */
export const EXECUTABLE_ENTRIES: readonly string[] = ["oyp", "runtime/node", "install.sh"];

type EntryKind = "file" | "directory" | "symlink";

interface ArchiveEntry {
	/** Posix path inside the archive; directories keep their trailing slash. */
	readonly name: string;
	readonly kind: EntryKind;
	readonly source: string;
	readonly size: number;
	readonly mode: number;
	readonly mtime: number;
	readonly linkTarget: string;
}

export interface ArchiveOptions {
	readonly executableEntries?: readonly string[];
	readonly gzipLevel?: number;
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function octal(value: number, width: number): string {
	const digits = value.toString(8);
	if (digits.length > width - 1) throw new Error(`tar field overflow: ${value} needs more than ${width - 1} digits`);
	return `${digits.padStart(width - 1, "0")}\0`;
}

function paxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`;
	let digits = 1;
	for (;;) {
		const total = digits + Buffer.byteLength(body, "utf8");
		if (String(total).length === digits) return Buffer.from(`${total}${body}`, "utf8");
		digits = String(total).length;
	}
}

function checksum(block: Buffer): number {
	let sum = 0;
	for (let index = 0; index < BLOCK_SIZE; index++) sum += block[index];
	return sum;
}

function header(entry: ArchiveEntry, typeflag: string, size: number, nameOverride?: string): Buffer {
	const block = Buffer.alloc(BLOCK_SIZE);
	const name = nameOverride ?? entry.name;
	block.write(name, 0, 100, "utf8");
	block.write(octal(entry.mode, 8), 100, 8, "latin1");
	block.write(octal(0, 8), 108, 8, "latin1");
	block.write(octal(0, 8), 116, 8, "latin1");
	block.write(octal(size, 12), 124, 12, "latin1");
	block.write(octal(entry.mtime, 12), 136, 12, "latin1");
	block.write("        ", 148, 8, "latin1");
	block.write(typeflag, 156, 1, "latin1");
	if (entry.kind === "symlink") block.write(entry.linkTarget, 157, 100, "utf8");
	block.write("ustar\0", 257, 6, "latin1");
	block.write("00", 263, 2, "latin1");
	block.write("root", 265, 32, "latin1");
	block.write("wheel", 297, 32, "latin1");
	block.write(octal(0, 8), 329, 8, "latin1");
	block.write(octal(0, 8), 337, 8, "latin1");
	const total = checksum(block);
	if (total > 0o777777) throw new Error(`tar checksum overflow: ${total}`);
	block.write(`${total.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	return block;
}

function padding(size: number): Buffer {
	const remainder = size % BLOCK_SIZE;
	return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

const TYPE_FLAGS: Record<EntryKind, string> = { file: "0", directory: "5", symlink: "2" };

function paxHeaderName(entry: ArchiveEntry): string {
	const base = `PaxHeader/${path.posix.basename(entry.name.replace(/\/$/, ""))}`;
	return base.length > 100 ? base.slice(0, 100) : base;
}

async function collectEntries(
	root: string,
	archiveRoot: string,
	executables: ReadonlySet<string>,
): Promise<ArchiveEntry[]> {
	const entries: ArchiveEntry[] = [];

	const visit = async (absolute: string, relative: string): Promise<void> => {
		const stat = await fs.promises.lstat(absolute);
		const mtime = Math.floor(stat.mtimeMs / 1000);
		if (stat.isSymbolicLink()) {
			entries.push({
				name: relative,
				kind: "symlink",
				source: absolute,
				size: 0,
				mode: SYMLINK_MODE,
				mtime,
				linkTarget: await fs.promises.readlink(absolute),
			});
			return;
		}
		if (stat.isDirectory()) {
			entries.push({
				name: `${relative}/`,
				kind: "directory",
				source: absolute,
				size: 0,
				mode: DIRECTORY_MODE,
				mtime,
				linkTarget: "",
			});
			const children = await fs.promises.readdir(absolute, { withFileTypes: true });
			children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
			for (const child of children) await visit(path.join(absolute, child.name), `${relative}/${child.name}`);
			return;
		}
		entries.push({
			name: relative,
			kind: "file",
			source: absolute,
			size: stat.size,
			mode: executables.has(path.relative(root, absolute).split(path.sep).join("/")) ? EXECUTABLE_MODE : FILE_MODE,
			mtime,
			linkTarget: "",
		});
	};

	await visit(root, archiveRoot);
	return entries;
}

async function* archiveStream(entries: readonly ArchiveEntry[]): AsyncGenerator<Buffer> {
	for (const entry of entries) {
		const nameBytes = Buffer.byteLength(entry.name, "utf8");
		if (nameBytes > 100 || nameBytes !== entry.name.length) {
			const data = paxRecord("path", entry.name);
			yield header(entry, "x", data.length, paxHeaderName(entry));
			yield data;
			yield padding(data.length);
		}
		yield header(entry, TYPE_FLAGS[entry.kind], entry.size);
		if (entry.kind !== "file" || entry.size === 0) continue;
		let written = 0;
		for await (const chunk of fs.createReadStream(entry.source)) {
			written += chunk.length;
			yield chunk;
		}
		if (written !== entry.size) throw new Error(`file changed while archiving: ${entry.source}`);
		yield padding(written);
	}
	yield Buffer.alloc(BLOCK_SIZE * 2);
}

/** Pack `targetDir` into `outFile` keeping directory contents under the directory's own name. */
export async function writeReleaseTarball(
	targetDir: string,
	outFile: string,
	options: ArchiveOptions = {},
): Promise<void> {
	const root = path.resolve(targetDir);
	const stat = await fs.promises.stat(root);
	if (!stat.isDirectory()) throw new Error(`--target-dir is not a directory: ${root}`);
	const archiveRoot = path.basename(root);
	const executables = new Set(options.executableEntries ?? EXECUTABLE_ENTRIES);
	const entries = await collectEntries(root, archiveRoot, executables);
	await pipeline(
		Readable.from(archiveStream(entries), { objectMode: false }),
		zlib.createGzip({ level: options.gzipLevel ?? 6 }),
		fs.createWriteStream(path.resolve(outFile)),
	);
}

async function main(): Promise<void> {
	const targetDir = arg("target-dir");
	const outFile = arg("out");
	if (!targetDir) throw new Error("--target-dir is required");
	if (!outFile) throw new Error("--out is required");
	const level = arg("level");
	await writeReleaseTarball(targetDir, outFile, level === undefined ? {} : { gzipLevel: Number(level) });
	const { size } = await fs.promises.stat(outFile);
	console.log(
		`packed ${path.basename(targetDir)} -> ${path.relative(process.cwd(), outFile)} (${(size / 1024 / 1024).toFixed(1)} MiB)`,
	);
}

if (isMainModule(import.meta.url)) {
	await main();
}
