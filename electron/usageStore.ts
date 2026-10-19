import fs from 'fs';
import { atomicWriteFileSync } from './fsSafe';
import { calculateCost, TokenUsage } from './pricing';

/** One recorded request (a full user turn, summed over all its API rounds). */
export interface UsageRecord extends TokenUsage {
  timestamp: string;
  model: string;
  /** USD; null when the model's price is unknown. */
  cost: number | null;
  /** Number of API rounds in the turn (tool loops make several). */
  rounds?: number;
  /** 2 = summed over every round with the corrected formula. */
  pricingVersion?: number;
}

export const USAGE_MAX_RECORDS = 5000;
export const USAGE_MAX_AGE_MS = 366 * 24 * 60 * 60 * 1000;

function isRecord(v: unknown): v is UsageRecord {
  const r = v as UsageRecord;
  return !!r && typeof r === 'object' && typeof r.timestamp === 'string' && typeof r.model === 'string';
}

/** Keep the newest records: at most 5,000 and none older than a year. */
export function capRecords(records: UsageRecord[], now = Date.now()): UsageRecord[] {
  const fresh = records.filter((r) => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) ? now - t <= USAGE_MAX_AGE_MS : false;
  });
  return fresh.length > USAGE_MAX_RECORDS ? fresh.slice(fresh.length - USAGE_MAX_RECORDS) : fresh;
}

/**
 * Old records (before pricingVersion 2) were stored with wrong prices and a
 * subtracting formula. Re-price them from their token counts so the totals
 * use today's table (their token counts only cover the last round, which
 * can't be recovered).
 */
export function repriceLegacy(r: UsageRecord): UsageRecord {
  if (r.pricingVersion === 2) return r;
  return { ...r, cost: calculateCost(r.model, r) };
}

export class UsageStore {
  constructor(readonly file: string) {}

  load(): UsageRecord[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecord).map(repriceLegacy);
    } catch {
      return [];
    }
  }

  append(entry: UsageRecord): UsageRecord[] {
    const records = capRecords([...this.load(), entry]);
    this.save(records);
    return records;
  }

  clear() {
    this.save([]);
  }

  private save(records: UsageRecord[]) {
    atomicWriteFileSync(this.file, JSON.stringify(records), {});
  }
}
