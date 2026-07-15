import 'dotenv/config';

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
];

// These all have defaults in src/config.ts — unset just means "using the default".
const OPTIONAL_VARS = [
  'PORT',
  'NODE_ENV',
  'FRONTEND_URL',
  'RESEND_API_KEY',
  'FROM_EMAIL',
  'CRON_SECRET',
  'LOG_LEVEL',
];

let missingRequired = 0;

console.log('Required environment variables:');
for (const key of REQUIRED_VARS) {
  const present = Boolean(process.env[key]);
  if (!present) missingRequired += 1;
  console.log(`  ${present ? 'OK     ' : 'MISSING'}  ${key}`);
}

console.log('\nOptional environment variables:');
for (const key of OPTIONAL_VARS) {
  const present = Boolean(process.env[key]);
  console.log(`  ${present ? 'OK     ' : 'MISSING'}  ${key}`);
}

if (missingRequired > 0) {
  console.error(`\n${missingRequired} required variable(s) missing.`);
  process.exit(1);
}

console.log('\nAll required environment variables are set.');
