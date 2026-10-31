'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
dotenv.config({ path: process.env.MIGRATION_TEST_ENV || path.join(root, '.env') });

async function main() {
  if (!process.env.MONGO_TOKEN) {
    throw new Error('MONGO_TOKEN is not configured in the ignored local .env file.');
  }

  const mongoose = require('mongoose');
  mongoose.set('strictQuery', false);

  try {
    await mongoose.connect(process.env.MONGO_TOKEN, { serverSelectionTimeoutMS: 15000 });
    const result = await mongoose.connection.db.admin().ping();
    if (result.ok !== 1) throw new Error('MongoDB ping did not return ok.');
    console.log('MongoDB authentication and read-only ping passed.');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }

  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/token|secret|password|webhook|api[_-]?key|lavalink/i.test(key)) delete childEnv[key];
  }

  const testFiles = ['no-mongo.test.cjs', 'discord-veiled-contract.test.cjs'].map((name) => path.join(__dirname, name));
  const run = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
  });

  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status || 1;
  else console.log('Isolated moderation command tests passed; Discord, REST, webhook, and voice integrations were not loaded.');
}

main().catch((error) => {
  console.error(`Safe sample test failed: ${error.name || 'Error'}${error.code ? ` (${error.code})` : ''}`);
  process.exitCode = 1;
});
