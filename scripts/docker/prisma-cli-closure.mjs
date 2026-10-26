// Copy the Prisma CLI's runtime dependency closure out of a lockfile-installed
// node_modules into a separate directory. Used by the Dockerfile `prismacli`
// stage: the runtime image needs the CLI for `npx prisma migrate deploy`
// (sps-migrate-*), but Next standalone tracing drops it.
//
// Every file comes from the `deps` stage's `npm ci`, so the CLI is exactly the
// version pinned in package-lock.json (no unlocked `npm install`). The closure
// is walked over the lockfile's `packages` map using Node's resolution rules
// (nearest node_modules first, then each ancestor), and every package keeps the
// same path it has in the full tree, so overlaying the result onto the
// standalone node_modules can only replace a file with the same locked version.
//
// Usage: node prisma-cli-closure.mjs <appDir> <outNodeModulesDir> <pkg>...
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [appDir, outDir, ...roots] = process.argv.slice(2);
if (!appDir || !outDir || roots.length === 0) {
  console.error("usage: prisma-cli-closure.mjs <appDir> <outNodeModulesDir> <pkg>...");
  process.exit(2);
}

const lock = JSON.parse(readFileSync(join(appDir, "package-lock.json"), "utf8"));
const packages = lock.packages;

// Lockfile key of `name` as resolved from the package at key `from`.
function resolve(from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key] && existsSync(join(appDir, key))) return key;
    if (!base) return null;
    const idx = base.lastIndexOf("/node_modules/");
    base = idx < 0 ? "" : base.slice(0, idx);
  }
}

const seen = new Set();
const queue = [];
function visit(from, name, optional) {
  const key = resolve(from, name);
  if (!key) {
    if (optional) return;
    console.error(`prisma-cli-closure: cannot resolve ${name} from ${from || "<root>"}`);
    process.exit(1);
  }
  if (!seen.has(key)) {
    seen.add(key);
    queue.push(key);
  }
}

for (const name of roots) visit("", name, false);
while (queue.length) {
  const key = queue.shift();
  const pkg = packages[key];
  for (const name of Object.keys(pkg.dependencies ?? {})) visit(key, name, false);
  // Platform-specific optional deps that npm skipped are absent on disk.
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) visit(key, name, true);
  // npm installs required peers; optional peers (e.g. prisma's typescript)
  // are left out, matching what an `--omit=dev` install would ship.
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (!peerMeta[name]?.optional) visit(key, name, false);
  }
}

mkdirSync(outDir, { recursive: true });
for (const key of [...seen].sort()) {
  const src = join(appDir, key);
  const nested = join(src, "node_modules");
  cpSync(src, join(outDir, key.replace(/^node_modules\//, "")), {
    recursive: true,
    verbatimSymlinks: true,
    // Nested deps are copied only when they are part of the closure.
    filter: (p) => p !== nested,
  });
}
console.log(`prisma-cli-closure: copied ${seen.size} packages for ${roots.join(", ")}`);
