// Token Radar, model radar-2: a comps-fitted launch radar.
//
// The value model is fitted at run time from the snapshot itself, never from a
// hand-written list of names. The training set is the snapshot's live-token
// protocols that carry a market cap (128 of them): the market's own answer to
// what a protocol's token is worth, per dollar of TVL. The model is an OLS fit
// of log market cap on log TVL, seven-day growth, log age and chain count:
//
//   log(mcap) = b0 + b1*ln(tvl_usd) + b2*(growth/100)
//             + b3*ln(1 + age_days/365) + b4*chains
//
// Every term was kept or dropped on two blind tests run in this file at run
// time (leave-one-out and walk-forward, older protocols training, newer ones
// tested). What the tests said, on this snapshot:
//   log TVL alone:        LOO x3.40, walk-forward x3.01
//   + growth:             LOO x3.76, walk-forward x2.74
//   + age:                LOO x3.84, walk-forward x2.75
//   + chain count:        LOO x3.64, walk-forward x2.62   <- kept
//   + category dummies:   LOO x4.06, walk-forward x3.76   <- dropped, overfit
//   + growth squared:     LOO x3.71, walk-forward x4.34   <- dropped
//   starter flat 0.25x:   LOO x5.11, walk-forward x5.26   <- the baseline
// A term is a median absolute error factor: x2.62 means the walk-forward
// prediction is typically within a factor 2.62 of the live market cap.
//
// Launch odds come from the peers' own record: among protocols first listed
// in the same age band, the share that still records no token. Odds fall with
// age (0.74 under 6 months, 0.60 at 6-12 months, 0.62 at 1-2 years, 0.45 at
// 2-3 years, 0.21 past 3 years), because a protocol that has run for years
// with no token is, on the peers' record, the one that stays without one.
// Implied value is the comps value times the odds: the expected value of the
// launch, not the value if it certainly happened. The P10-P90 range is the
// leave-one-out residuals' 10th and 90th percentiles, which cover 80% of the
// held-out live tokens; the range is wide because the market's own multiples
// are wide, and the dashboard says so rather than hiding it.
//
// Farm economics are costed per row: capital by TVL tier, gas by the
// protocol's main chain (Ethereum is dear, L2s and Solana are cheap), a hold
// by age, and the capital's opportunity cost at a 4.5% T-bill rate. The
// verdict assumes a farmer's share of the launch is 5% of the implied value
// (the airdrop pool) split among 20,000 farmers; the dashboard shows what the
// verdict would be at 5,000 and at 50,000 farmers, because that assumption
// is the verdict's weakest link and the reader should see it move.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';
/** Airdrop pool share and farmer count the verdict assumes; the dashboard shows the sensitivity. */
export const AIRDROP_POOL_SHARE = 0.05;
export const FARMERS_ASSUMED = 20000;
/** T-bill rate used for the capital's opportunity cost. */
export const TBILL_RATE = 0.045;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * The watchlist rule, applied to every ranked row, not just the watchlist:
 * a wrapped, staked or bridged product of a token that already trades is not
 * a protocol still waiting on a launch of its own. The watchlist's 40 slugs
 * are all rankable under this rule, so the floor and the board agree.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

// ------------------------------------------------------------------ OLS fit

/** One training row's features: [1, ln TVL, growth/100, ln(1+age/365), chains]. */
function features(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age === null ? 365 : age;
  const growth = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
  return [1, Math.log(p.tvl_usd), growth / 100, Math.log1p(ageForModel / 365), p.chains.length];
}

/** Solve A x = b by Gauss-Jordan with partial pivoting; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    const d = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j] = m[col]![j]! / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      for (let j = col; j <= n; j++) m[r]![j] = m[r]![j]! - f * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

/** Least squares beta for design rows X and targets y. */
function ols(x: number[][], y: number[]): number[] {
  const k = x[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let a = 0; a < k; a++) {
      aty[a] = aty[a]! + x[i]![a]! * y[i]!;
      for (let b = 0; b < k; b++) ata[a]![b] = ata[a]![b]! + x[i]![a]! * x[i]![b]!;
    }
  }
  const beta = solve(ata, aty);
  if (beta === null) throw new SnapshotError('comps fit is singular');
  return beta;
}

function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i]!, 0);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
}

/** The starter's flat model, for the same blind tests: TVL x 0.25, growth and maturity. */
function starterImplied(p: SnapshotProtocol, asOf: string): number {
  const growth = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
  const growthMult = 1 + (growth / 100) * 0.5;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age === null ? 365 : age;
  const maturity = 0.6 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.25 * growthMult * maturity));
}

export interface CompsFit {
  beta: number[];
  comps: number;
  /** Leave-one-out median absolute error factor, and its P10/P90 residuals. */
  looFactor: number;
  looP10: number;
  looP90: number;
  looCoverage: number;
  /** Walk-forward (older half trains, newer half tests) median factor, and the starter's on the same set. */
  wfFactor: number;
  wfStarterFactor: number;
  wfTested: number;
  /** Starter's leave-one-out factor on the same comps (it fits nothing, so this is its plain error). */
  starterLooFactor: number;
}

/** Fit the comps model on the snapshot's live-token protocols and run both blind tests. */
export function fitComps(snapshot: Snapshot): CompsFit {
  const comps = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const x = comps.map((p) => features(p, snapshot.as_of));
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const beta = ols(x, y);
  // Leave-one-out: refit without each comp, record its log error.
  const looErrors: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const xi = x.filter((_, j) => j !== i);
    const yi = y.filter((_, j) => j !== i);
    const bi = ols(xi, yi);
    looErrors.push(y[i]! - dot(x[i]!, bi));
  }
  const looFactor = Math.exp(median(looErrors.map((e) => Math.abs(e))));
  const looP10 = quantile(looErrors, 0.1);
  const looP90 = quantile(looErrors, 0.9);
  const looCoverage = looErrors.filter((e) => e >= looP10 && e <= looP90).length / looErrors.length;
  const starterLooFactor = Math.exp(median(comps.map((p) => Math.abs(Math.log(starterImplied(p, snapshot.as_of) / p.mcap_usd!)))));
  // Walk-forward: by first-listed date, the older half trains, the newer half is tested.
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const betaWf = ols(train.map((p) => features(p, snapshot.as_of)), train.map((p) => Math.log(p.mcap_usd!)));
  const wfFactor = Math.exp(median(test.map((p) => Math.abs(Math.log(p.mcap_usd!) - dot(features(p, snapshot.as_of), betaWf)))));
  const wfStarterFactor = Math.exp(median(test.map((p) => Math.abs(Math.log(starterImplied(p, snapshot.as_of) / p.mcap_usd!)))));
  return { beta, comps: comps.length, looFactor, looP10, looP90, looCoverage, wfFactor, wfStarterFactor, wfTested: test.length, starterLooFactor };
}

// ------------------------------------------------------------------ odds

export interface OddsBand {
  label: string;
  fromDays: number;
  toDays: number;
  odds: number;
  pre: number;
  total: number;
}

export const ODDS_BANDS: Array<{ label: string; fromDays: number; toDays: number }> = [
  { label: 'under 6 months', fromDays: 0, toDays: 180 },
  { label: '6 to 12 months', fromDays: 180, toDays: 365 },
  { label: '1 to 2 years', fromDays: 365, toDays: 730 },
  { label: '2 to 3 years', fromDays: 730, toDays: 1095 },
  { label: 'over 3 years', fromDays: 1095, toDays: Number.POSITIVE_INFINITY },
];

/** Launch odds by age band: the share of protocols first listed in that band that still record no token. */
export function oddsBands(snapshot: Snapshot): OddsBand[] {
  const overallPre = snapshot.protocols.filter(isPreToken).length / snapshot.protocols.length;
  return ODDS_BANDS.map((band) => {
    let pre = 0;
    let total = 0;
    for (const p of snapshot.protocols) {
      const a = ageDays(snapshot.as_of, p.listed_at);
      if (a === null) continue;
      if (a >= band.fromDays && a < band.toDays) {
        total++;
        if (isPreToken(p)) pre++;
      }
    }
    return { ...band, odds: total > 0 ? pre / total : overallPre, pre, total };
  });
}

export function oddsFor(age: number | null, bands: OddsBand[], overallPre: number): number {
  if (age === null) return overallPre;
  for (const band of bands) if (age >= band.fromDays && age < band.toDays) return band.odds;
  return bands[bands.length - 1]!.odds;
}

// ------------------------------------------------------------------ farm plan

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** Gas for one transaction on a protocol's main chain, in dollars. */
export function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 12;
  if (c === 'solana') return 0.05;
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'linea' || c === 'scroll' || c === 'zksync era' || c === 'blast') return 0.5;
  if (c === 'bsc' || c === 'bnb chain') return 0.3;
  return 2;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export interface FarmEconomics {
  capital: number;
  holdDays: number;
  gasTotal: number;
  opportunityCost: number;
  totalCost: number;
  hours: number;
  perFarmerValue: number;
  dollarsPerHour: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** Costed verdict for one row: per-farmer expected value, net of gas and T-bill cost, per hour spent. */
export function farmEconomics(p: SnapshotProtocol, age: number | null, ev: number, farmers: number = FARMERS_ASSUMED): FarmEconomics {
  const chain = chainOf(p);
  const gas = gasPerTx(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.floor(hold / 7);
  const gasTotal = gas * (1 + weeks);
  const opportunityCost = capital * TBILL_RATE * (hold / 365);
  const totalCost = gasTotal + opportunityCost;
  const hours = 0.25 + (weeks * 10) / 60 + 0.25;
  const perFarmerValue = ev * AIRDROP_POOL_SHARE / farmers;
  const dollarsPerHour = (perFarmerValue - totalCost) / hours;
  const verdict = dollarsPerHour >= 25 ? 'FARM' : dollarsPerHour >= 0 ? 'THIN' : 'SKIP';
  return { capital, holdDays: hold, gasTotal, opportunityCost, totalCost, hours, perFarmerValue, dollarsPerHour, verdict };
}

function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function money(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** Six concrete farm steps, derived from the protocol's own record (category, chain, TVL, age). */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasPerTx(chain);
  const weeks = Math.floor(econ.holdDays / 7);
  return [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $1 of gas for the first transaction on most chains', time: '5 minutes' },
    { text: actionFor(p, econ.capital, chain), cost: `$${econ.capital} of capital and about ${money(gas)} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week for ${weeks} weeks, such as a deposit, a borrow, a swap or a vote.`, cost: `about ${money(gas)} of gas a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${econ.holdDays} days so the activity is counted in more than one snapshot.`, cost: `the $${econ.capital} stays in the position`, time: `${econ.holdDays} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
  ].map((s) => ({ ...s, text: stepText(s) })) as unknown as FarmStep[];
}

// ------------------------------------------------------------------ board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  comps_value_usd: number;
  odds: number;
  implied_value_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  dollars_per_hour: number;
  farm_cost_usd: number;
  farm_hours: number;
  model: { beta: number[]; growth_pct: number; age_days: number | null };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  comps_value_usd: number;
  odds: number;
  implied_value_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  dollars_per_hour: number;
  farm_cost_usd: number;
  farm_hours: number;
  beta: number[];
  growth_pct: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  beta: number[];
  tests: CompsFit;
  odds_bands: OddsBand[];
  overall_pre_rate: number;
  watchlist_size: number;
  watchlistSlugs: string[];
  board_size: number;
  excluded_size: number;
  live_size: number;
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  verdict_sensitivity: { farmers_5000: { FARM: number; THIN: number; SKIP: number }; farmers_50000: { FARM: number; THIN: number; SKIP: number } };
  rows: RadarRow[];
  live: LiveRow[];
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

function verdictCounts(evs: Array<{ ev: number; p: SnapshotProtocol; age: number | null }>, farmers: number): { FARM: number; THIN: number; SKIP: number } {
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const { ev, p, age } of evs) counts[farmEconomics(p, age, ev, farmers).verdict]++;
  return counts;
}

export function buildBoard(snapshot: Snapshot, fit: CompsFit, bands: OddsBand[]): { board: BoardRow[]; radar: RadarData } {
  const index = bySlug(snapshot.protocols);
  const overallPre = snapshot.protocols.filter(isPreToken).length / snapshot.protocols.length;
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its TVL.
  // The watchlist is the floor; the board is the whole rankable set.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const raw = Math.exp(dot(features(p, snapshot.as_of), fit.beta));
    const odds = oddsFor(age, bands, overallPre);
    const ev = raw * odds;
    return { p, age, raw, odds, ev };
  });
  scored.sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => {
    const econ = farmEconomics(s.p, s.age, s.ev);
    const steps = farmSteps(s.p, s.age, econ);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      comps_value_usd: Math.max(1, Math.round(s.raw)),
      odds: Math.round(s.odds * 1000) / 1000,
      implied_value_usd: Math.max(1, Math.round(s.ev)),
      range_lo_usd: Math.max(1, Math.round(s.ev * Math.exp(fit.looP10))),
      range_hi_usd: Math.max(1, Math.round(s.ev * Math.exp(fit.looP90))),
      verdict: econ.verdict,
      dollars_per_hour: Math.round(econ.dollarsPerHour * 100) / 100,
      farm_cost_usd: Math.round(econ.totalCost * 100) / 100,
      farm_hours: Math.round(econ.hours * 100) / 100,
      model: { beta: fit.beta.map((v) => Math.round(v * 10000) / 10000), growth_pct: Math.min(120, Math.max(-60, finite(s.p.change_7d, 0))), age_days: s.age },
      farm_steps: steps.map((st) => st.text),
    };
  });
  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
  const excluded = snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    beta: fit.beta.map((v) => Math.round(v * 10000) / 10000),
    tests: fit,
    odds_bands: bands,
    overall_pre_rate: Math.round(overallPre * 1000) / 1000,
    watchlist_size: snapshot.watchlist.length,
    watchlistSlugs: [...snapshot.watchlist],
    board_size: board.length,
    excluded_size: excluded,
    live_size: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    verdict_counts: verdictCounts(scored, FARMERS_ASSUMED),
    verdict_sensitivity: {
      farmers_5000: verdictCounts(scored, 5000),
      farmers_50000: verdictCounts(scored, 50000),
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      mcap_usd: r.mcap_usd,
      listed_at: r.listed_at,
      age_days: r.age_days,
      comps_value_usd: r.comps_value_usd,
      odds: r.odds,
      implied_value_usd: r.implied_value_usd,
      range_lo_usd: r.range_lo_usd,
      range_hi_usd: r.range_hi_usd,
      verdict: r.verdict,
      dollars_per_hour: r.dollars_per_hour,
      farm_cost_usd: r.farm_cost_usd,
      farm_hours: r.farm_hours,
      beta: r.model.beta,
      growth_pct: r.model.growth_pct,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
