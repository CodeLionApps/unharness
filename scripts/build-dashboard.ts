// Builds the dashboard into a self-contained server, dashboard/.next/standalone (Next's `output: 'standalone'`):
// server.js plus only the node_modules files it needs. The CLI runs it and the npm package ships it, so an
// installed package needs neither Next nor React. Used by `npm run build` and by the CLI's rebuild in a checkout.
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const dashboard = path.join(root, 'dashboard');
const out = path.join(dashboard, '.next', 'standalone');

// Written last (below); until then the CLI treats the build as stale, so an interrupted build is redone.
const done = path.join(out, 'dashboard', '.next', 'UNHARNESS_BUILD_DONE');
rmSync(done, { force: true });

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const b = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', nextBin, 'build'], { cwd: dashboard, stdio: 'inherit' });
if (b.status !== 0) process.exit(b.status ?? 1);

// server.js serves .next/static itself once it is copied next to it (there is no public/ dir)
cpSync(path.join(dashboard, '.next', 'static'), path.join(out, 'dashboard', '.next', 'static'), { recursive: true });

// server.js is CommonJS; without this the package's "type": "module" applies to it once dashboard/.next/package.json
// (which Next writes, but the package doesn't ship) is out of the way.
writeFileSync(path.join(out, 'package.json'), '{"type": "commonjs"}\n');

// sharp is only loaded lazily by next/image optimization, which the dashboard doesn't use, and its binaries are the
// build machine's platform. Turbopack ignores outputFileTracingExcludes for the server trace, so drop it here.
for (const d of ['sharp', '@img', '@emnapi']) rmSync(path.join(out, 'node_modules', d), { recursive: true, force: true });

// The build embeds the repo's absolute path (outputFileTracingRoot, turbopack.root, repoRoot in the serialized
// config). server.js chdirs into standalone/dashboard, so ".." names the same directory without leaking the build
// machine's paths into the package.
for (const e of readdirSync(out, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue;
  const f = path.join(e.parentPath, e.name);
  const s = readFileSync(f, 'latin1'); // byte-preserving, so binary files survive a no-op round trip
  if (s.includes(root)) writeFileSync(f, s.replaceAll(root, '..'), 'latin1');
}

writeFileSync(done, '');
