import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { home, sha256 } from './util.ts';
import type { Request } from './types.ts';

// Pricing table: LiteLLM model_prices_and_context_window.json (cached), bundled snapshot as offline fallback,
// local overrides in ~/.unharness/pricing-overrides.json ({ "<model>": { input_cost_per_token, ... } }).
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const SNAPSHOT = new URL('./pricing-snapshot.json', import.meta.url);
const MAX_AGE_MS = 7 * 8.64e7;

export interface Price {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

export interface PriceTable {
  version: string;
  prices: Record<string, Price>;
}

const cacheFile = () => path.join(home(), 'pricing.json');

// Refresh the cached LiteLLM table if older than a week. Failure is non-fatal (snapshot fallback).
export async function refreshPricing(force = false): Promise<void> {
  const f = cacheFile();
  if (!force && existsSync(f) && Date.now() - statSync(f).mtimeMs < MAX_AGE_MS) return;
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const text = await res.text();
    JSON.parse(text);
    mkdirSync(home(), { recursive: true });
    writeFileSync(f, text);
  } catch {
    // offline: keep whatever we have
  }
}

let loaded: PriceTable | null = null;

export function loadPricing(): PriceTable {
  if (loaded) return loaded;
  const f = cacheFile();
  const src = existsSync(f) ? f : SNAPSHOT;
  const text = readFileSync(src, 'utf8');
  const date = existsSync(f) ? statSync(f).mtime.toISOString().slice(0, 10) : 'snapshot';
  const prices: Record<string, Price> = JSON.parse(text);
  delete (prices as Record<string, unknown>).sample_spec;
  const overridesFile = path.join(home(), 'pricing-overrides.json');
  let version = `litellm-${date}-${sha256(text).slice(0, 8)}`;
  if (existsSync(overridesFile)) {
    const o = readFileSync(overridesFile, 'utf8');
    for (const [m, p] of Object.entries(JSON.parse(o) as Record<string, Price>)) prices[m] = { ...prices[m], ...p };
    version += `+ovr-${sha256(o).slice(0, 6)}`;
  }
  loaded = { version, prices };
  return loaded;
}

// Resolve model id variants: "claude-sonnet-4-5-20250929", "anthropic/claude-...", "openai/gpt-5", "us.anthropic.claude-..."
export function findPrice(table: PriceTable, model: string): Price | null {
  const p = table.prices;
  const bare = model.replace(/^(anthropic|openai|us\.anthropic|eu\.anthropic)[/.]/, '').replace(/\[.*\]$/, '');
  const candidates = [model, bare, `anthropic/${bare}`, `openai/${bare}`, bare.replace(/-\d{8}$/, ''), bare.replace(/-v\d+:\d+$/, '')];
  for (const c of candidates) if (p[c]?.input_cost_per_token != null) return p[c];
  return null;
}

export function costOf(req: Request, table: PriceTable): number | null {
  const p = findPrice(table, req.model);
  if (!p || p.input_cost_per_token == null) return null;
  const inp = p.input_cost_per_token;
  const out = p.output_cost_per_token ?? 0;
  const cr = p.cache_read_input_token_cost ?? inp;
  const cw5 = p.cache_creation_input_token_cost ?? inp;
  // Anthropic 1h cache write = 2x base input when the table has no explicit price
  const cw1h = p.cache_creation_input_token_cost_above_1hr ?? inp * 2;
  return req.input * inp + req.output * out + req.cache_read * cr + req.cache_write_5m * cw5 + req.cache_write_1h * cw1h;
}
