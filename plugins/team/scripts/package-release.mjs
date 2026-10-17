import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  cp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { node, cli, env, provenance } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidate = process.argv.includes("--candidate");
const outputArg = process.argv.find(
  (value, index) => index > 1 && value !== "--candidate",
);
if (!outputArg)
  throw Error(
    "Usage: node scripts/package-release.mjs NEW_OUTPUT_DIRECTORY [--candidate]",
  );
const output = resolve(outputArg);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw Error(
    "Commit the source before packaging so provenance identifies every delivered file.",
  );
const source = git("rev-parse", "HEAD");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const supply = JSON.parse(
  await readFile(join(root, "release/bb-supply.json"), "utf8"),
);
const sdkUrl = `${supply.baseUrl}/${supply.sdk.filename}`;
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
if (
  !candidate &&
  (supply.status !== "verified" ||
    provenance.tag !== supply.tag ||
    pkg.devDependencies["@get-bb/plugin-sdk"] !== sdkUrl ||
    lock.packages["node_modules/@get-bb/plugin-sdk"].integrity !==
      supply.sdk.integrity)
)
  throw Error(
    "Formal packaging requires verified BB supply and the matching SDK URL/integrity in package and lock.",
  );
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version))
  throw Error("Unsupported package version");
const name = `bb-team-v${pkg.version}${candidate ? `-candidate-${source.slice(0, 10)}` : ""}`;
const temp = await mkdtemp(join(tmpdir(), "bb-team-package-"));
const stage = join(temp, name);
async function run(command, args) {
  const child = spawn(command, args, { cwd: stage, env, stdio: "inherit" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw Error(`${command} exited ${code}`);
}
try {
  await mkdir(stage);
  const sourceTar = join(temp, "source.tar");
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${sourceTar}`,
      `HEAD:${git("rev-parse", "--show-prefix").replace(/\/$/, "")}`,
      "package.json",
      "package-lock.json",
      "server.ts",
      "app.tsx",
      "src",
      "components",
      "lib",
      "assets",
      "skills",
      "licenses",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "docs",
      "scripts",
      "release",
    ],
    { cwd: git("rev-parse", "--show-toplevel") },
  );
  execFileSync("tar", ["-xf", sourceTar, "-C", stage]);
  await run("npm", [
    "ci",
    "--ignore-scripts",
    "--omit=dev",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
  ]);
  await run(node, [cli, "plugin", "build", stage]);
  const dependencies = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--parseable"],
    { cwd: stage, env, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((path) => path !== stage);
  const notices = [];
  for (const path of [...new Set(dependencies)].sort()) {
    const dependency = JSON.parse(
      await readFile(join(path, "package.json"), "utf8"),
    );
    const files = (await readdir(path)).filter((file) =>
      /^(license|licence|copying|notice)(\.|$|-)/i.test(file),
    );
    if (!files.length)
      throw Error(`No license text found for ${dependency.name}`);
    const target = join(
      stage,
      "licenses/dependencies",
      dependency.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
    );
    await mkdir(target, { recursive: true });
    for (const file of files) await cp(join(path, file), join(target, file));
    notices.push({
      name: dependency.name,
      version: dependency.version,
      license: dependency.license ?? null,
      files: files.map((file) => relative(stage, join(target, file))),
    });
  }
  await writeFile(
    join(stage, "licenses/dependencies.json"),
    JSON.stringify(notices, null, 2) + "\n",
  );
  await rm(join(stage, "node_modules"), { recursive: true });
  for (const file of await readdir(join(stage, "dist"))) {
    const path = join(stage, "dist", file);
    if (file.endsWith(".map")) await rm(path);
    else if (/\.(js|css)$/.test(file))
      await writeFile(
        path,
        (await readFile(path, "utf8"))
          .replace(/^\/\/[#@] sourceMappingURL=.*$/gm, "")
          .replace(/\/\*# sourceMappingURL=.*?\*\//g, ""),
      );
  }
  const receipt = {
    package: pkg.name,
    version: pkg.version,
    candidate,
    source,
    bb: {
      tag: provenance.tag,
      source: provenance.source,
      node: provenance.node,
    },
    sdk: {
      version: "0.6.37",
      source: supply.source,
      url: candidate ? null : sdkUrl,
      integrity: candidate ? null : supply.sdk.integrity,
    },
    installation:
      "Extract, npm ci --ignore-scripts --omit=dev --omit=optional, then matching BB plugin install path:<directory>; BB rebuilds source.",
  };
  await writeFile(
    join(stage, "release-provenance.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  await mkdir(output);
  const filename = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", join(output, filename), "-C", temp, name]);
  const sha256 = createHash("sha256")
    .update(await readFile(join(output, filename)))
    .digest("hex");
  await writeFile(
    join(output, `${filename}.sha256`),
    `${sha256}  ${filename}\n`,
  );
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify({ ...receipt, filename, sha256 }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ filename, sha256, source, candidate }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
