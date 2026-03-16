/**
 * Drift funding rate data fetcher with disk cache.
 * Fetches day-by-day from the Drift Data API and saves to .cache/ directory.
 * Re-uses cached files on subsequent runs — no re-fetching.
 */
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://data.api.drift.trade";
const CACHE_DIR = path.join(process.cwd(), ".cache", "funding-rates");

export interface HourlyBar {
  ts: number;           // unix seconds, snapped to hour bucket
  asset: string;
  hourlyRate: number;   // fraction of oracle price per hour (signed)
  apy: number;          // |hourlyRate| * 24 * 365.25, annualized fraction
  direction: "short" | "long";
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function cacheFile(asset: string, year: number, month: number, day: number): string {
  const dir = path.join(CACHE_DIR, asset);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}.json`);
}

async function fetchDay(
  asset: string,
  year: number, month: number, day: number,
  delayMs = 400
): Promise<HourlyBar[]> {
  const file = cacheFile(asset, year, month, day);

  // Return cached if exists
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return raw;
  }

  await sleep(delayMs);

  const symbol = `${asset}-PERP`;
  const url = `${BASE_URL}/market/${symbol}/fundingRates/${year}/${month}/${day}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) {
        // 404 = market not listed yet — safe to cache as empty
        fs.writeFileSync(file, JSON.stringify([]));
      }
      // 403 / rate limit — do NOT cache, allow retry next run
      return [];
    }
    const body: any = await resp.json();
    const records: any[] = body.records ?? [];

    const bars: HourlyBar[] = records
      .filter(r => r.ts && r.fundingRate && r.oraclePriceTwap)
      .map(r => {
        const fr = parseFloat(r.fundingRate);
        const oracle = parseFloat(r.oraclePriceTwap) || 1;
        const hourlyRate = fr / oracle;
        const apy = Math.abs(hourlyRate) * 24 * 365.25;
        const hourBucket = Math.round(parseInt(r.ts) / 3600) * 3600;
        return {
          ts: hourBucket,
          asset,
          hourlyRate,
          apy,
          direction: hourlyRate >= 0 ? "short" : "long",
        } as HourlyBar;
      });

    fs.writeFileSync(file, JSON.stringify(bars));
    return bars;
  } catch {
    // Network error — don't cache, allow retry next run
    return [];
  }
}

export async function fetchAssetRange(
  asset: string,
  startDate: Date,
  endDate: Date,
  delayMs = 400
): Promise<Map<number, HourlyBar>> {
  const map = new Map<number, HourlyBar>();
  const current = new Date(startDate);
  let fetched = 0;
  let cached = 0;

  while (current <= endDate) {
    const y = current.getFullYear();
    const m = current.getMonth() + 1;
    const d = current.getDate();
    const file = cacheFile(asset, y, m, d);
    const fromCache = fs.existsSync(file);

    const bars = await fetchDay(asset, y, m, d, delayMs);
    for (const b of bars) map.set(b.ts, b);

    if (fromCache) cached++; else fetched++;
    current.setDate(current.getDate() + 1);
  }

  process.stderr.write(
    `${asset}: ${map.size} hourly bars (${fetched} days fetched, ${cached} cached)\n`
  );
  return map;
}
