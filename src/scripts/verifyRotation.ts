import { supabaseAdmin } from '../config';
import { logger } from '../logger';

const ANCHOR = '2026-01-01'; // Platoon B
const START_DATE = '2026-01-01';
const END_DATE = '2026-12-30';

const PLATOON_BY_CYCLE_POS: Record<number, string> = { 0: 'B', 1: 'C', 2: 'A' };

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const dateA = new Date(`${a}T00:00:00Z`).getTime();
  const dateB = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((dateB - dateA) / msPerDay);
}

function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expected platoon for a date given the anchor: 2026-01-01 = B, cycling B->C->A. */
function expectedPlatoon(dateStr: string): string {
  const diff = daysBetween(ANCHOR, dateStr);
  const cyclePos = ((diff % 3) + 3) % 3;
  return PLATOON_BY_CYCLE_POS[cyclePos];
}

async function main() {
  const { data, error } = await supabaseAdmin
    .from('rotation_schedule')
    .select('shift_date, platoon')
    .gte('shift_date', START_DATE)
    .lte('shift_date', END_DATE);

  if (error) {
    logger.error('verifyRotation: failed to fetch rotation_schedule', { error });
    process.exit(1);
    return;
  }

  const actualByDate = new Map((data ?? []).map((row) => [row.shift_date, row.platoon]));

  let failures = 0;
  let cursor = START_DATE;

  while (cursor <= END_DATE) {
    const expected = expectedPlatoon(cursor);
    const actual = actualByDate.get(cursor);

    if (actual === expected) {
      console.log(`PASS  ${cursor}  expected=${expected} actual=${actual}`);
    } else {
      failures += 1;
      console.log(`FAIL  ${cursor}  expected=${expected} actual=${actual ?? 'MISSING'}`);
    }

    cursor = addDaysIso(cursor, 1);
  }

  if (failures > 0) {
    console.error(`\n${failures} date(s) failed rotation verification.`);
    process.exit(1);
  }

  console.log('\nAll dates passed rotation verification.');
}

if (require.main === module) {
  main();
}
