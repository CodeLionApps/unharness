import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(import.meta.dirname, '..');
const config: NextConfig = {
  // self-contained server the npm package ships; see scripts/build-dashboard.ts
  output: 'standalone',
  turbopack: { root },
  outputFileTracingRoot: root,
  serverExternalPackages: [],
};
export default config;
