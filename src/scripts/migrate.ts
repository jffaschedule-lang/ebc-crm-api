import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { supabaseAdmin } from '../config';
import { logger } from '../logger';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BATCH_SIZE = 500;

/** Minimal RFC4180 CSV parser — handles quoted fields containing commas. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? '').trim();
    });
    return row;
  });
}

function readCsv(filename: string): Record<string, string>[] {
  const filePath = path.join(DATA_DIR, filename);
  if (!existsSync(filePath)) {
    logger.warn(`migrate: ${filename} not found in ${DATA_DIR} — skipping`);
    return [];
  }
  return parseCsv(readFileSync(filePath, 'utf-8'));
}

function normalizeTime(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [h, m] = trimmed.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  }
  if (/^\d{3,4}$/.test(trimmed)) {
    const padded = trimmed.padStart(4, '0');
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return trimmed || '07:00';
}

async function insertInBatches(table: string, rows: Record<string, unknown>[]) {
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabaseAdmin.from(table).insert(batch);
    if (error) {
      errors += batch.length;
      logger.error(`migrate: batch insert failed for ${table}`, { error: error.message, batchStart: i });
    } else {
      inserted += batch.length;
    }
  }

  logger.info(`migrate: ${table} — ${inserted} inserted, ${errors} failed (of ${rows.length} total)`);
}

async function migrateCompanies() {
  const rows = readCsv('companies.csv');
  const mapped = rows.map((r) => ({
    code: r['Machine'] ?? r['code'],
    station: r['Location'] ?? r['station'],
    district: r['District'] ? Number(r['District']) : null,
    suffix_rule: r['Suffix Rule'] ?? r['suffix_rule'] ?? null,
    records_only: (r['Records Only'] ?? '').toLowerCase() === 'true',
  }));
  await insertInBatches('companies', mapped);
}

async function migrateEmployees() {
  const rows = readCsv('employees.csv');
  const mapped = rows.map((r) => {
    const [lastName, firstName] = (r['Name'] ?? '').split(',').map((s) => s.trim());
    const status = r['Status']?.trim() === 'Un Active' ? 'Inactive' : 'Active';
    return {
      emp_number: parseInt((r['Employee No'] ?? '0').replace(/^0+/, '') || '0', 10),
      last_name: lastName ?? '',
      first_name: firstName ?? '',
      rank: r['Rank'],
      platoon: r['Platoon'],
      company_code: r['Machine'],
      station_override: null as string | null,
      status,
    };
  });
  await insertInBatches('employees', mapped);
}

async function migrateRotationSchedule() {
  const rows = readCsv('rotation_schedule.csv');
  const mapped = rows.map((r) => ({
    shift_date: r['Date'] ?? r['shift_date'],
    platoon: r['Platoon'] ?? r['platoon'],
    pp_start: r['PP Start'] ?? r['pp_start'],
    pp_end: r['PP End'] ?? r['pp_end'],
  }));
  await insertInBatches('rotation_schedule', mapped);
}

async function migrateDutyLedger() {
  const rows = readCsv('database.csv');
  const empNumberToId = await buildEmployeeLookup();

  const mapped = rows
    .map((r) => {
      const empNumber = parseInt((r['Emp No'] ?? '0').replace(/^0+/, '') || '0', 10);
      const employeeId = empNumberToId.get(empNumber);
      if (!employeeId) return null;

      const actingNote = [r['Acting Role'], r['Acting Start'], r['Acting End']]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        shift_date: r['Date'],
        platoon: r['Platoon'],
        employee_id: employeeId,
        company_code: r['Machine'],
        station: r['Location'],
        duty_status: 'O',
        acting_note: actingNote || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  await insertInBatches('duty_ledger', mapped);
}

async function migrateLeaveRecords() {
  const rows = readCsv('leave_records.csv');
  const empNumberToId = await buildEmployeeLookup();

  const mapped = rows
    .map((r, i) => {
      const empNumber = parseInt((r['Emp No'] ?? '0').replace(/^0+/, '') || '0', 10);
      const employeeId = empNumberToId.get(empNumber);
      if (!employeeId) return null;

      return {
        entry_id: `MIG-${Date.now()}-${i}`,
        employee_id: employeeId,
        leave_type: r['Status'],
        shift_date: r['Date'],
        span_start: normalizeTime(r['Start']),
        span_end: normalizeTime(r['End']),
        status: r['Status_2'] ?? r['Status'] ?? 'PendingApproval',
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  await insertInBatches('leave_records', mapped);
}

async function buildEmployeeLookup(): Promise<Map<number, string>> {
  const { data, error } = await supabaseAdmin.from('employees').select('id, emp_number');
  if (error) throw error;
  return new Map((data ?? []).map((e) => [e.emp_number, e.id]));
}

async function main() {
  logger.info('Starting one-time CSV migration', { dataDir: DATA_DIR });

  // Dependency order: companies -> employees -> rotation_schedule -> duty_ledger -> leave_records
  await migrateCompanies();
  await migrateEmployees();
  await migrateRotationSchedule();
  await migrateDutyLedger();
  await migrateLeaveRecords();

  logger.info('Migration complete');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration failed', { err });
      process.exit(1);
    });
}
