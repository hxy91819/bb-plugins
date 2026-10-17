import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const supply = JSON.parse(
  await readFile(new URL("../bb-runtime.json", import.meta.url), "utf8"),
);
if (!process.argv[2])
  throw new Error("Usage: node scripts/fetch-runtime.mjs NEW_DIRECTORY");
const directory = resolve(process.argv[2]);
await mkdir(directory);
const archive = join(directory, supply.filename);
const response = await fetch(`${supply.baseUrl}/${supply.filename}`);
if (!response.ok || !response.body)
  throw new Error(`Runtime download failed: ${response.status}`);
await pipeline(
  Readable.fromWeb(response.body),
  createWriteStream(archive, { flags: "wx" }),
);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== supply.sha256)
  throw new Error("Runtime checksum mismatch");
const runtime = join(directory, "runtime");
await mkdir(runtime);
execFileSync("tar", ["-xzf", archive, "-C", runtime, "--strip-components=1"]);
const release = JSON.parse(
  await readFile(join(runtime, "release.json"), "utf8"),
);
if (release.source !== supply.source || release.tag !== supply.tag)
  throw new Error("Runtime provenance mismatch");
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    `BB_PLUGINS_RUNTIME_DIR=${runtime}\n`,
  );
console.log(runtime);
