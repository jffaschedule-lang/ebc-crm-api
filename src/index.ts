import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './logger';
import { requestLogger } from './middleware/requestLogger';
import { apiRateLimiter } from './middleware/rateLimiter';
import { errorHandler, HttpError } from './middleware/errorHandler';
import { verifyCronSecret, runShiftPacketEmailJob } from './jobs/shiftPacketEmail';
import { runGenerateDutyLedgerJob } from './jobs/generateDutyLedger';

import employeesRouter from './routes/employees';
import rotationRouter from './routes/rotation';
import dutyLedgerRouter from './routes/dutyLedger';
import leaveRequestsRouter from './routes/leaveRequests';
import leaveRecordsRouter from './routes/leaveRecords';
import timesheetRouter from './routes/timesheet';
import payrollRouter from './routes/payroll';
import workforceRouter from './routes/workforce';
import overtimeRouter from './routes/overtime';
import shiftCloseRouter from './routes/shiftClose';
import detRouter from './routes/det';
import auditRouter from './routes/audit';
import settingsRouter from './routes/settings';
import companiesRouter from './routes/companies';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';

const app = express();

// Railway terminates TLS and forwards requests through exactly one proxy hop,
// so X-Forwarded-For must be trusted for req.ip (and express-rate-limit) to
// see the real client address. Trust exactly 1 hop — never `true`, which would
// let clients spoof X-Forwarded-For to bypass rate limiting.
app.set('trust proxy', 1);

app.use(helmet());

const allowedOrigins: (string | RegExp)[] = [
  config.FRONTEND_URL,
  /https:\/\/ebc-crm-.*\.vercel\.app$/,
  /https:\/\/.*-jffaschedule-langs-projects\.vercel\.app$/,
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = allowedOrigins.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));
      if (allowed) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(requestLogger);

// /api/admin/setup-first-admin (and its bootstrap sibling) carry their own,
// more lenient limiter (see routes/admin.ts) — skip the general one for
// those two paths specifically rather than double-limiting them.
const SETUP_PATHS = new Set(['/admin/setup-first-admin', '/admin/bootstrap-first-employee']);
app.use('/api', (req, res, next) => {
  if (SETUP_PATHS.has(req.path)) return next();
  return apiRateLimiter(req, res, next);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Railway cron (or any scheduler) hits this with X-Cron-Secret set.
app.post('/api/jobs/shift-packet-email', async (req, res, next) => {
  try {
    if (!verifyCronSecret(req.header('X-Cron-Secret'))) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or missing cron secret');
    }
    await runShiftPacketEmailJob();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Same cron-secret pattern, scheduled for shift_start_time — no-ops unless
// Settings > Duty Board Config has "Auto-generate duty ledger" turned on.
app.post('/api/jobs/generate-duty-ledger', async (req, res, next) => {
  try {
    if (!verifyCronSecret(req.header('X-Cron-Secret'))) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or missing cron secret');
    }
    const result = await runGenerateDutyLedgerJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

app.use('/api/employees', employeesRouter);
app.use('/api/rotation', rotationRouter);
app.use('/api/duty-ledger', dutyLedgerRouter);
app.use('/api/leave', leaveRequestsRouter);
// leaveRecordsRouter is mounted at both prefixes: /api/leave/slots/:platoon/:date
// and /api/leave/ (list) are reached via the first mount; /api/leave-records/:id/status
// and /api/leave-records (list) via the second — see tests/integration/leaveFlow.test.ts.
app.use('/api/leave', leaveRecordsRouter);
app.use('/api/leave-records', leaveRecordsRouter);
app.use('/api/timesheet', timesheetRouter);
app.use('/api/payroll', payrollRouter);
app.use('/api/workforce', workforceRouter);
app.use('/api/overtime', overtimeRouter);
app.use('/api/shift-close', shiftCloseRouter);
app.use('/api/det', detRouter);
app.use('/api/audit', auditRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info(`ebc-crm-api listening on port ${config.PORT}`, { env: config.NODE_ENV });
});

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
