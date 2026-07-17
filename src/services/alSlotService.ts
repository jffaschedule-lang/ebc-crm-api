import { supabaseAdmin } from '../config';
import { assertNoDbError } from '../utils/db';

const MAX_SLOTS = 12;

interface Span {
  start: number; // minutes since midnight
  end: number; // minutes since midnight, may exceed 1440 for overnight spans
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Normalizes a span so an overnight span (end <= start) is expressed as end > start. */
function normalizeSpan(startStr: string, endStr: string): Span {
  const start = toMinutes(startStr);
  let end = toMinutes(endStr);
  if (end <= start) end += 24 * 60;
  return { start, end };
}

function peakConcurrency(spans: Span[]): number {
  if (spans.length === 0) return 0;
  const points = new Set<number>();
  spans.forEach((s) => points.add(s.start));

  let peak = 0;
  for (const point of points) {
    const count = spans.filter((s) => s.start <= point && s.end > point).length;
    if (count > peak) peak = count;
  }
  return peak;
}

interface CheckSlotFitParams {
  platoon: string;
  shiftDate: string;
  newStart: string;
  newEnd: string;
  excludeId?: string;
}

interface CheckSlotFitResult {
  fits: boolean;
  peakAfterAdd: number;
  maxSlots: number;
}

export const alSlotService = {
  async checkSlotFit({
    platoon,
    shiftDate,
    newStart,
    newEnd,
    excludeId,
  }: CheckSlotFitParams): Promise<CheckSlotFitResult> {
    let query = supabaseAdmin
      .from('leave_records')
      .select('id, span_start, span_end, employees!leave_records_employee_id_fkey!inner(platoon)')
      .eq('shift_date', shiftDate)
      .eq('leave_type', 'AL')
      .in('status', ['Granted', 'Active'])
      .eq('employees.platoon', platoon);

    if (excludeId) {
      query = query.neq('id', excludeId);
    }

    const { data, error } = await query;
    assertNoDbError(error, 'checkSlotFit');

    const existingSpans: Span[] = (data ?? []).map((row: any) =>
      normalizeSpan(row.span_start, row.span_end)
    );
    existingSpans.push(normalizeSpan(newStart, newEnd));

    const peak = peakConcurrency(existingSpans);

    return {
      fits: peak <= MAX_SLOTS,
      peakAfterAdd: peak,
      maxSlots: MAX_SLOTS,
    };
  },

  async rebuildSlotLedger(platoon: string, shiftDate: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('leave_records')
      .select('span_start, span_end, employees!leave_records_employee_id_fkey!inner(platoon)')
      .eq('shift_date', shiftDate)
      .eq('leave_type', 'AL')
      .in('status', ['Granted', 'Active'])
      .eq('employees.platoon', platoon);

    assertNoDbError(error, 'rebuildSlotLedger');

    const spans: Span[] = (data ?? []).map((row: any) => normalizeSpan(row.span_start, row.span_end));
    const peak = peakConcurrency(spans);

    const { error: upsertError } = await supabaseAdmin.from('al_slot_ledger').upsert(
      {
        platoon,
        shift_date: shiftDate,
        peak_concurrent: peak,
        max_slots: MAX_SLOTS,
        last_rebuilt_at: new Date().toISOString(),
      },
      { onConflict: 'platoon,shift_date' }
    );

    assertNoDbError(upsertError, 'rebuildSlotLedger upsert');
  },
};
