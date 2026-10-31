'use strict';

const { runMigrationSmoke } = require('../src/migration/migrationSmoke.cjs');

runMigrationSmoke({
  discordToken: process.env.MIGRATION_DISCORD_TOKEN,
  veiledToken: process.env.MIGRATION_VEILED_TOKEN,
  discordGuildId: process.env.MIGRATION_DISCORD_GUILD_ID,
  discordChannelId: process.env.MIGRATION_DISCORD_CHANNEL_ID,
  veiledRoomId: process.env.MIGRATION_VEILED_ROOM_ID,
  veiledLaneId: process.env.MIGRATION_VEILED_LANE_ID,
  sendAndDelete: process.argv.includes('--send-and-delete'),
}).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error('Migration smoke failed: ' + (error && error.message || 'unknown error'));
  if (error && error.cleanupError) console.error(error.cleanupError);
  process.exitCode = 1;
});
