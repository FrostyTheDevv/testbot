const shouldSyncDiscordGlobalCommands = (env = process.env) => env.SYNC_DISCORD_GLOBAL_COMMANDS === 'true';

module.exports = { shouldSyncDiscordGlobalCommands };
