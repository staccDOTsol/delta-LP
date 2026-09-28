import { spawnSync } from 'node:child_process';
const url = process.env.WAITLIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set WAITLIST_TEST_DATABASE_URL or DATABASE_URL to run the real Postgres integration suite.');
const result = spawnSync(process.execPath, ['--import','tsx','--test','tests/waitlist.integration.test.ts'], {
  stdio:'inherit', env:{...process.env,WAITLIST_TEST_DATABASE_URL:url},
});
process.exitCode=result.status ?? 1;
