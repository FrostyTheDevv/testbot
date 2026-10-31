const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSyncDiscordGlobalCommands } = require('../src/migration/discordCommandRegistration.cjs');

test('Discord global command sync is disabled unless explicitly enabled', () => {
  assert.equal(shouldSyncDiscordGlobalCommands({}), false);
  assert.equal(shouldSyncDiscordGlobalCommands({ SYNC_DISCORD_GLOBAL_COMMANDS: 'false' }), false);
  assert.equal(shouldSyncDiscordGlobalCommands({ SYNC_DISCORD_GLOBAL_COMMANDS: '1' }), false);
  assert.equal(shouldSyncDiscordGlobalCommands({ SYNC_DISCORD_GLOBAL_COMMANDS: 'true' }), true);
});
