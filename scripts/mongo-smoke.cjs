'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.MIGRATION_TEST_ENV || path.resolve(process.cwd(), '.env') });

const uri = process.env.MONGO_TOKEN;
if (!uri) {
  console.error('Mongo smoke check failed: MONGO_TOKEN is not configured.');
  process.exit(2);
}

const mongoose = require('mongoose');
mongoose.set('strictQuery', false);

(async () => {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    const result = await mongoose.connection.db.admin().ping();
    if (result.ok !== 1) throw new Error('MongoDB ping did not return ok.');
    console.log('Mongo smoke check passed: authenticated connection and admin ping succeeded.');
  } catch (error) {
    console.error(`Mongo smoke check failed: ${error.name || 'Error'}${error.code ? ` (${error.code})` : ''}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
