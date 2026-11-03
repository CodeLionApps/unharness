#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Installed package (under node_modules, where Node refuses to strip types) runs compiled dist/;
// a source checkout runs src/*.ts directly.

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`Unharness needs Node >= 24 (node:sqlite, type stripping); you have ${process.version}`);
  process.exit(1);
}
const entry = import.meta.url.includes('/node_modules/') ? '../dist/cli.js' : '../src/cli.ts';
const { main } = await import(new URL(entry, import.meta.url).href);
main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
