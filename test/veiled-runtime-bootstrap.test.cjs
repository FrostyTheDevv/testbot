'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createVeiledCommandClient,
  defaultRuntimeFactory,
  loadSdkModules,
  parseRuntimeEvents,
  startVeiledRuntime,
} = require('../src/migration/veiledRuntimeBootstrap.cjs');

const TEST_ROOM = 'room-fixture-123456';

function loadBuiltSdkModules() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'socket.io-client') return { io: () => { throw new Error('Network is disabled in the built SDK fixtures.'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return loadSdkModules({ VEILED_SDK_PATH: process.env.VEILED_SDK_PATH });
  } finally {
    Module._load = originalLoad;
  }
}

function makeRuntime() {
  const listeners = new Map();
  const registrationCalls = [];
  const runtime = {
    user: { id: 'veiled-bot-fixture', username: 'VeiledFixture', displayAvatarURL: () => 'https://cdn.veiled.test/avatar.png' },
    application: { commands: { set: async (...args) => { registrationCalls.push(args); return new Map(); } } },
    guilds: { cache: new Map() },
    channels: { cache: new Map() },
    users: { cache: new Map() },
    connectCalls: 0,
    disconnectCalls: 0,
    async connect() { this.connectCalls += 1; },
    disconnect() { this.disconnectCalls += 1; },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    listeners,
    registrationCalls,
  };
  return runtime;
}

function fakeDiscordLibrary() {
  class EmbedBuilder {
    setColor(value) { this.color = value; return this; }
    setFooter(value) { this.footer = value; return this; }
    setTimestamp(value) { this.timestamp = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setImage(value) { this.image = value; return this; }
    setThumbnail(value) { this.thumbnail = value; return this; }
    addFields(...values) { this.fields = [...(this.fields || []), ...values.flat()]; return this; }
    setAuthor(value) { this.author = value; return this; }
    setURL(value) { this.url = value; return this; }
  }
  class PermissionsBitField {
    constructor(value) { this.value = value; }
    toArray() { return [String(this.value)]; }
  }
  return { EmbedBuilder, PermissionsBitField };
}

function loadUnchangedInteractionModule() {
  const filename = path.join(__dirname, '..', 'src', 'events', 'client', 'interactionCreate.js');
  const source = fs.readFileSync(filename, 'utf8');
  const emptyModel = { findOne: (_query, callback) => callback(null, null) };
  const localRequire = (request) => {
    if (request === 'discord.js') return { AttachmentBuilder: class AttachmentBuilder {} };
    if (request === '@haileybot/captcha-generator') return class Captcha {};
    if (request.startsWith('../../database/models/')) return emptyModel;
    throw new Error('Unexpected event dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedInviteEvent(eventName) {
  const filename = path.join(__dirname, '..', 'src', 'events', 'invite', eventName + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return {};
    throw new Error('Unexpected invite event dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedChannelEvent(eventName) {
  const filename = path.join(__dirname, '..', 'src', 'events', 'channel', eventName + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return {};
    throw new Error('Unexpected channel event dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedThreadEvent(eventName) {
  const filename = path.join(__dirname, '..', 'src', 'events', 'thread', eventName + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return {};
    throw new Error('Unexpected thread event dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedReactionEvent(eventName) {
  const filename = path.join(__dirname, '..', 'src', 'events', 'message', eventName + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return {};
    if (request === '../../database/models/starboardChannels') return { findOne: async () => { throw new Error('non-star fixture must not query starboard'); } };
    throw new Error('Unexpected reaction event dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedMembersStatCommand(statsModel) {
  const filename = path.join(__dirname, '..', 'src', 'commands', 'serverstats', 'members.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') {
      const permissions = class PermissionsBitField {};
      permissions.Flags = { Connect: 1n << 20n };
      return { ChannelType: { GuildVoice: 2 }, PermissionsBitField: permissions };
    }
    if (request === '../../database/models/stats') return statsModel;
    throw new Error('Unexpected member-count command dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedGuildMembersCommand() {
  const filename = path.join(__dirname, '..', 'src', 'commands', 'guild', 'members.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return {};
    throw new Error('Unexpected guild member-count command dependency: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

function loadUnchangedReadOnlyCommand(category, commandName, dependencies = {}) {
  const filename = path.join(__dirname, '..', 'src', 'commands', category, commandName + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request === 'discord.js') return dependencies.discord || {};
    if (Object.prototype.hasOwnProperty.call(dependencies, request)) return dependencies[request];
    throw new Error('Unexpected command dependency in offline fixture: ' + request);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename })(
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}
function baseDiscordClient() {
  let emitted = 0;
  return {
    user: { id: 'discord-bot-fixture', username: 'DiscordFixture' },
    commands: new Map([['ping', { data: { toJSON: () => ({ name: 'ping', description: 'Ping' }) } }]]),
    config: { colors: { normal: 0x123456, error: 0xff0000, succes: 0x00ff00 }, discord: { footer: 'Test bot', token: 'fixture-secret-value' } },
    emotes: { normal: { error: 'error' } },
    emit() { emitted += 1; },
    get emitted() { return emitted; },
    rest: { put() { throw new Error('Discord REST must not be called by Veiled runtime.'); } },
    player: { create() { throw new Error('Discord voice must not be called by Veiled runtime.'); } },
  };
}

test('normal bot entrypoint keeps Discord login independent and enables Veiled on the existing Discord client', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/bot.js'), 'utf8');
  const veiledStart = source.indexOf('startVeiledRuntime({ discordClient: client })');
  const discordLogin = source.indexOf('client.login(process.env.DISCORD_TOKEN)');
  assert.ok(veiledStart >= 0, 'Veiled uses the already-created Discord.js client for shared command definitions');
  assert.ok(discordLogin > veiledStart, 'Discord login remains an independent startup step after optional Veiled startup begins');
  assert.match(source, /veiledRuntimeBootstrap\.enabled\(process\.env\)/);
  assert.match(source, /fs\.readdirSync\('\.\/src\/handlers'\)/, 'Discord handler loading remains in its original bootstrap');
  assert.match(source, /\.catch\(\(error\) => \{ console\.error\('Veiled compatibility runtime failed to start:'/);
  assert.doesNotMatch(source, /process\.exitCode\s*=\s*1/);
});
test('disabled bootstrap does not load the SDK, handlers, or connect a second client', async () => {
  let factoryCalls = 0;
  let loaderCalls = 0;
  const result = await startVeiledRuntime({
    env: { VEILED_RUNTIME_ENABLED: 'false' },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => { factoryCalls += 1; throw new Error('must stay inert'); },
    eventLoader: () => { loaderCalls += 1; throw new Error('must stay inert'); },
  });
  assert.deepEqual({ enabled: result.enabled, factoryCalls, loaderCalls }, { enabled: false, factoryCalls: 0, loaderCalls: 0 });
});

test('Veiled runtime can start without a hydrated bot identity when voice is not used', async () => {
  const runtime = makeRuntime();
  runtime.user = null;
  runtime.guilds.fetch = async () => ({ id: TEST_ROOM, members: { cache: new Map(), me: null } });
  const handle = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_VOICE_SESSION_PATH: path.resolve(__dirname, 'unused-voice-session.mjs'),
    },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => ({ runtime, apiClient: {}, adapter: {} }),
    eventLoader: () => async () => undefined,
    discordLibrary: fakeDiscordLibrary(),
    logger: { error() {}, warn() {} },
  });
  assert.equal(runtime.connectCalls, 1);
  assert.equal(handle.enabled, true);
  assert.equal(handle.runtime.user, null);
  await handle.stop();
});

test('Veiled facade keeps platform identities and managers separate and blocks Discord transports', () => {
  const discord = baseDiscordClient();
  const runtime = makeRuntime();
  const facade = createVeiledCommandClient(discord, runtime, { logger: { error() {} }, loadSubcommand: async () => undefined, discordLibrary: fakeDiscordLibrary() });
  assert.equal(facade.user, runtime.user);
  assert.notEqual(facade.user, discord.user);
  assert.equal(facade.guilds, runtime.guilds);
  assert.equal(facade.channels, runtime.channels);
  assert.notEqual(facade.commands, discord.commands);
  assert.equal(facade.commands.get('ping'), discord.commands.get('ping'));
  facade.commands.set('veiled-only', {});
  assert.equal(discord.commands.has('veiled-only'), false);
  assert.notEqual(facade.emotes, discord.emotes);
  facade.emotes.normal.error = 'veiled-error';
  assert.equal(discord.emotes.normal.error, 'error');
  assert.equal(facade.config.colors.normal, discord.config.colors.normal);
  assert.equal(facade.config.discord.footer, 'Test bot');
  assert.equal(facade.config.discord.token, undefined);
  assert.throws(() => facade.player, /Discord-only client capability/);
  assert.throws(() => facade.rest, /Discord-only client capability/);
  discord.crossPlatformAction = () => { throw new Error('must never invoke Discord client helpers'); };
  assert.throws(() => facade.crossPlatformAction, /Unmapped Discord.js client property/);
  facade.emit('errorCreate', new Error('fixture'));
  assert.equal(discord.emitted, 0);
});

test('Veiled room setup and log lookup keep Mongo settings isolated from Discord room IDs', async () => {
  const records = new Map();
  class Setting {
    constructor(values) { Object.assign(this, values); }
    async save() { records.set(this.Guild, this); return this; }
    static async findOne(query) { return records.get(query.Guild) || null; }
  }
  const runtime = makeRuntime();
  const logChannel = { id: 'veiled-log-lane', toString: () => '<#veiled-log-lane>' };
  runtime.channels.fetch = async (id) => id === logChannel.id ? logChannel : Promise.reject(new Error('unknown lane'));
  records.set(TEST_ROOM, new Setting({ Guild: TEST_ROOM, Channel: 'discord-log-lane' }));
  records.set('veiled:' + TEST_ROOM, new Setting({ Guild: 'veiled:' + TEST_ROOM, ChannelTemplate: 'Veiled: {name}' }));
  const templateQueries = [];
  const statsModel = { findOne: async (query) => { templateQueries.push(query); return records.get(query.Guild) || null; } };
  const discord = baseDiscordClient();
  const facade = createVeiledCommandClient(discord, runtime, {
    logger: { error() {} },
    discordLibrary: fakeDiscordLibrary(),
    databaseModels: { logChannels: Setting, stats: statsModel },
    roomId: TEST_ROOM,
  });
  const interaction = { guild: { id: TEST_ROOM }, editReply: async (payload) => payload };

  await facade.createChannelSetup(Setting, logChannel, interaction);

  assert.equal(records.get(TEST_ROOM).Channel, 'discord-log-lane');
  assert.equal(records.get('veiled:' + TEST_ROOM).Channel, 'veiled-log-lane');
  assert.equal(await facade.getLogs(TEST_ROOM), logChannel);
  assert.equal(await facade.getTemplate({ id: TEST_ROOM }), 'Veiled: {name}');
  assert.deepEqual(templateQueries, [{ Guild: 'veiled:' + TEST_ROOM }]);
  assert.equal(await facade.getTemplate({ id: 'another-room' }), '{emoji} {name}');
  await assert.rejects(facade.getLogs('another-room'), /restricted to the configured room/);
});

test('opt-in runtime dispatches unchanged event module in the configured room only', async () => {
  const runtime = makeRuntime();
  const discord = baseDiscordClient();
  const calls = [];
  const handle = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
    },
    discordClient: discord,
    sourceRoot: 'C:\\sample-fixture',
    runtimeFactory: () => ({ runtime, apiClient: { platform: 'veiled' }, adapter: { platform: 'veiled' } }),
    discordLibrary: fakeDiscordLibrary(),
    eventLoader: (_root, eventName) => async (client, interaction) => { calls.push({ eventName, client, interaction }); },
    logger: { error() {} },
  });
  assert.equal(runtime.connectCalls, 1);
  assert.deepEqual(runtime.registrationCalls, []);
  const listener = runtime.listeners.get('interactionCreate');
  await listener({ guildId: 'another-room' });
  assert.equal(calls.length, 0);
  const interaction = { guildId: TEST_ROOM };
  await listener(interaction);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interaction, interaction);
  assert.equal(calls[0].client.user.id, 'veiled-bot-fixture');
  assert.notEqual(calls[0].client.user.id, discord.user.id);
  await handle.stop();
  assert.equal(runtime.disconnectCalls, 1);
  assert.equal(runtime.listeners.size, 0);
});

test('DM messageCreate does not reach room handlers unless Veiled DM logging is explicitly configured', async () => {
  const runtime = makeRuntime();
  const calls = [];
  const warnings = [];
  const handle = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_EVENTS: 'messageCreate',
    },
    discordClient: baseDiscordClient(),
    sourceRoot: 'C:\\sample-fixture',
    runtimeFactory: () => ({ runtime, apiClient: { platform: 'veiled' }, adapter: { platform: 'veiled' } }),
    discordLibrary: fakeDiscordLibrary(),
    eventLoader: (_root, eventName) => async (client, message) => { calls.push({ eventName, client, message }); },
    logger: { error() {}, warn(message) { warnings.push(message); } },
  });

  const listener = runtime.listeners.get('messageCreate');
  await listener({ id: 'foreign-message', guildId: 'another-room', channelId: 'foreign-channel' });
  await listener({ id: 'unscoped-message', guildId: null, guild: null, channelId: 'unknown-channel' });
  assert.equal(calls.length, 0);

  const message = {
    id: 'dm-message-fixture',
    guildId: null,
    guild: null,
    channelId: 'participant-dm-fixture',
    author: { id: 'dm-author-fixture' },
    channel: {
      id: 'participant-dm-fixture',
      guildId: null,
      type: 1,
      recipients: new Map([['dm-author-fixture', {}], [runtime.user.id, {}]]),
    },
    content: 'hello from a verified DM projection',
  };
  await listener(message);
  assert.equal(calls.length, 0, 'the unchanged room handler does not receive DM data');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /VEILED_RUNTIME_DM_MESSAGES=true/);

  await handle.stop();
});

test('unchanged interaction dispatcher invokes the selected command with the Veiled client facade', async () => {
  const runtime = makeRuntime();
  let executed;
  let finishExecution;
  const execution = new Promise((resolve) => { finishExecution = resolve; });
  const discord = baseDiscordClient();
  discord.commands.set('probe', {
    run: (client, interaction, args) => {
      executed = { client, interaction, args };
      finishExecution();
      return Promise.resolve();
    },
  });
  const handle = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
    },
    discordClient: discord,
    runtimeFactory: () => ({ runtime }),
    discordLibrary: fakeDiscordLibrary(),
    eventLoader: (_root, eventName) => {
      assert.equal(eventName, 'interactionCreate');
      return loadUnchangedInteractionModule();
    },
    logger: { error() {} },
  });
  const interaction = {
    guildId: TEST_ROOM,
    guild: { id: TEST_ROOM },
    user: { id: 'veiled-user-fixture' },
    commandName: 'probe',
    options: { _subcommand: null, _hoistedOptions: [], getSubcommand: () => null },
    isCommand: () => true,
    isUserContextMenuCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
  };
  await runtime.listeners.get('interactionCreate')(interaction);
  await execution;
  assert.equal(executed.client.user.id, 'veiled-bot-fixture');
  assert.equal(executed.interaction, interaction);
  assert.deepEqual(executed.args, []);
  await handle.stop();
});

test('command registration is opt-in and stays scoped to the Veiled test room', async () => {
  const runtime = makeRuntime();
  const discord = baseDiscordClient();
  await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_REGISTER_COMMANDS: 'true',
    },
    discordClient: discord,
    runtimeFactory: () => ({ runtime }),
    discordLibrary: fakeDiscordLibrary(),
    eventLoader: () => async () => undefined,
    logger: { error() {} },
  });
  assert.equal(runtime.registrationCalls.length, 1);
  assert.deepEqual(runtime.registrationCalls[0], [[{ name: 'ping', description: 'Ping' }], TEST_ROOM]);
});

test('Veiled startup rejects reuse of the Discord credential before creating its runtime', async () => {
  let factoryCalls = 0;
  const discord = baseDiscordClient();
  await assert.rejects(startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      DISCORD_TOKEN: 'same-fixture-token',
      VEILED_BOT_TOKEN: 'Bot same-fixture-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
    },
    discordClient: discord,
    runtimeFactory: () => { factoryCalls += 1; return { runtime: makeRuntime() }; },
    eventLoader: () => async () => undefined,
    logger: { error() {} },
  }), /credentials must be different/);
  assert.equal(factoryCalls, 0);
});

test('failed Veiled connection cleans up its runtime without destroying Discord', async () => {
  const runtime = makeRuntime();
  runtime.connect = async () => { runtime.connectCalls += 1; throw new Error('offline Veiled gateway'); };
  const discord = baseDiscordClient();
  let discordDestroyed = false;
  discord.destroy = async () => { discordDestroyed = true; };
  await assert.rejects(startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
    },
    discordClient: discord,
    runtimeFactory: () => ({ runtime }),
    discordLibrary: fakeDiscordLibrary(),
    eventLoader: () => async () => undefined,
    logger: { error() {} },
  }), /offline Veiled gateway/);
  assert.equal(runtime.disconnectCalls, 1);
  assert.equal(runtime.listeners.size, 0);
  assert.equal(discordDestroyed, false);
});
test('the configured channel and role update events dispatch the matching unchanged legacy handlers', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const Discord = fakeDiscordLibrary();
  const emitted = [];
  const logChannel = { id: 'veiled-log-lane' };
  const runtime = makeRuntime();
  runtime.channels.fetch = async (id) => {
    assert.equal(id, logChannel.id);
    return logChannel;
  };
  const discord = baseDiscordClient();
  let handle;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'discord.js') return Discord;
      return originalLoad.call(this, request, parent, isMain);
    };
    handle = await startVeiledRuntime({
      env: {
        VEILED_RUNTIME_ENABLED: 'true',
        VEILED_BOT_TOKEN: 'fixture-veiled-token',
        VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
        VEILED_RUNTIME_EVENTS: 'channelUpdate,roleUpdate',
      },
      discordClient: discord,
      runtimeFactory: () => ({ runtime }),
      databaseModels: {
        logChannels: { findOne: async ({ Guild }) => Guild === 'veiled:' + TEST_ROOM ? { Channel: logChannel.id } : null },
      },
      discordLibrary: Discord,
      logger: { error() {} },
    });
    handle.client.embed = async (payload, target) => { emitted.push({ payload, target }); };
    const oldChannel = { id: 'lane-1', name: 'before', topic: 'old topic', type: 0, parent: null, guild: { id: TEST_ROOM } };
    const newChannel = { ...oldChannel, name: 'after', topic: 'new topic' };
    await runtime.listeners.get('channelUpdate')(oldChannel, newChannel);
    const oldRole = { id: 'role-1', name: 'before', color: 1, permissions: { bitfield: 1n }, guild: { id: TEST_ROOM }, toString: () => '<@&role-1>' };
    const newRole = { ...oldRole, name: 'after', color: 2, permissions: { bitfield: 3n } };
    await runtime.listeners.get('roleUpdate')(oldRole, newRole);
    assert.deepEqual(emitted.map(({ payload }) => payload.title), [
      '🔧・Channel name adjusted',
      '🔧・Channel topic adjusted',
      '🧻・Role name updated',
      '🧻・Role color updated',
      '🧻・Role permissions updated',
    ]);
    assert.ok(emitted.every(({ target }) => target === logChannel));
  } finally {
    await handle?.stop();
    Module._load = originalLoad;
  }
});
test('unsafe Discord-only and destructive handlers are rejected for Veiled before runtime creation', async () => {
  const unsafeEvents = ['guildCreate', 'guildDelete', 'guildMemberAdd', 'guildMemberRemove', 'voiceStateUpdate'];
  for (const eventName of unsafeEvents) {
    let factoryCalls = 0;
    await assert.rejects(startVeiledRuntime({
      env: {
        VEILED_RUNTIME_ENABLED: 'true',
        VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
        VEILED_RUNTIME_EVENTS: eventName,
      },
      discordClient: baseDiscordClient(),
      runtimeFactory: () => { factoryCalls += 1; return { runtime: makeRuntime() }; },
      eventLoader: () => { throw new Error('unsupported event loader must not run'); },
      logger: { error() {} },
    }), new RegExp('Unsupported Veiled runtime event requested: ' + eventName));
    assert.equal(factoryCalls, 0, eventName + ' must be rejected before a Veiled runtime starts');
  }
});
test('unsupported Veiled event names are rejected before runtime startup', async () => {
  assert.deepEqual(parseRuntimeEvents('inviteCreate,inviteDelete'), ['inviteCreate', 'inviteDelete']);
  assert.throws(() => parseRuntimeEvents('interactionCreate,inviteUpdate'), /Unsupported Veiled runtime event/);
});

test('reaction events load unchanged handlers and dispatch only for the configured room', async () => {
  const runtime = makeRuntime();
  const loggedErrors = [];
  const started = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_EVENTS: 'messageReactionAdd,messageReactionRemove',
      VEILED_BOT_TOKEN: 'veiled-fixture',
    },
    discordClient: baseDiscordClient(),
    sourceRoot: path.resolve(__dirname, '..'),
    runtimeFactory: () => ({ apiClient: {}, adapter: {}, runtime }),
    eventLoader: (_sourceRoot, eventName) => loadUnchangedReactionEvent(eventName),
    logger: { error(...args) { loggedErrors.push(args); } },
    discordLibrary: fakeDiscordLibrary(),
  });
  for (const [eventIndex, eventName] of ['messageReactionAdd', 'messageReactionRemove'].entries()) {
    let emojiReads = 0;
    const reaction = {
      partial: false,
      message: { partial: false, guildId: TEST_ROOM },
      get emoji() { emojiReads += 1; return { name: '✅' }; },
    };
    await runtime.listeners.get(eventName)(reaction, { id: 'actor-1' });
    assert.equal(emojiReads, 1, eventName + ' should invoke the unchanged Discord.js reaction/user handler');
    const before = emojiReads;
    await runtime.listeners.get(eventName)({ partial: false, emoji: { name: '✅' }, message: { partial: false, guildId: 'another-room' } }, { id: 'actor-2' });
    assert.equal(emojiReads, before, eventName + ' must not forward reactions from another room');
    await runtime.listeners.get(eventName)({ partial: false, get emoji() { emojiReads += 1; return { name: '✅' }; }, message: { partial: false, guildId: null, guild: null } }, { id: 'dm-actor' });
    assert.equal(emojiReads, before + 1, eventName + ' should forward a genuine DM message shape without inventing a guild');
    const afterDm = emojiReads;
    await runtime.listeners.get(eventName)({ partial: false, emoji: { name: '✅' }, message: { partial: false } }, { id: 'unscoped-actor' });
    assert.equal(emojiReads, afterDm, eventName + ' must reject unscoped events without a room or explicit DM shape');

    await runtime.listeners.get(eventName)({ partial: false, emoji: { name: '⭐' }, message: { partial: false, guildId: null, guild: null } }, { id: 'dm-star-actor' });
    assert.equal(loggedErrors.length, eventIndex + 1, 'the unchanged guild-only starboard module should fail inside its own handler isolation boundary');
    assert.match(String(loggedErrors.at(-1)[0]), new RegExp('Veiled ' + eventName + ' handler failed'));
  }
  await started.stop();
});

test('the configured SDK build constructs its real Discord.js runtime without connecting', { skip: !process.env.VEILED_SDK_PATH }, () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'socket.io-client') return { io: () => { throw new Error('Network is disabled in the SDK construction test.'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { sdk, compat } = loadBuiltSdkModules();
    assert.equal(typeof sdk.VeiledBotClient, 'function');
    assert.equal(typeof compat.DiscordBotAdapter, 'function');
    assert.equal(typeof compat.DiscordRuntimeClient, 'function');
    const { apiClient, adapter, runtime } = defaultRuntimeFactory({
      VEILED_SDK_PATH: process.env.VEILED_SDK_PATH,
      VEILED_BOT_TOKEN: 'offlineid.offline_secret_fixture_value',
    });
    assert.ok(apiClient instanceof sdk.VeiledBotClient);
    assert.ok(adapter instanceof compat.DiscordBotAdapter);
    assert.ok(runtime instanceof compat.DiscordRuntimeClient);
    assert.equal(runtime.isReady(), false);
    runtime.disconnect();
  } finally {
    Module._load = originalLoad;
  }
});

test('the real SDK runtime projects an interaction and dispatches the unchanged sample handler offline', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'socket.io-client') return { io: () => { throw new Error('Network is disabled in the SDK dispatch test.'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let handle;
  try {
    const { sdk, compat } = loadBuiltSdkModules();
    const apiClient = new sdk.VeiledBotClient({ token: 'offlineid.offline_secret_fixture_value' });
    const adapter = new compat.DiscordBotAdapter(apiClient);
    const runtime = new compat.DiscordRuntimeClient(adapter);
    const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Fixture room', adapter, runtime);
    runtime.guilds.cache.set(TEST_ROOM, guild);
    runtime.connect = async () => {
      runtime.user = { id: 'veiled-bot-fixture', username: 'VeiledFixture' };
      runtime.application = { id: 'veiled-app-fixture', name: 'VeiledFixture', commands: { set: async () => new Map() } };
    };
    runtime.disconnect = () => {};

    const discord = baseDiscordClient();
    let finishExecution;
    const execution = new Promise((resolve) => { finishExecution = resolve; });
    let dispatched;
    discord.commands.set('probe', {
      run: (client, interaction, args) => {
        dispatched = { client, interaction, args };
        finishExecution();
        return Promise.resolve();
      },
    });
    handle = await startVeiledRuntime({
      env: { VEILED_RUNTIME_ENABLED: 'true', VEILED_BOT_TOKEN: 'offlineid.offline_secret_fixture_value', VEILED_RUNTIME_ROOM_ID: TEST_ROOM },
      discordClient: discord,
      runtimeFactory: () => ({ apiClient, adapter, runtime }),
      eventLoader: () => loadUnchangedInteractionModule(),
      discordLibrary: fakeDiscordLibrary(),
      logger: { error() {} },
    });
    const rawInteraction = {
      id: 'interaction-fixture', interaction_id: 'interaction-fixture', application_id: 'veiled-app-fixture',
      type: 2, version: 1, token: 'interaction-fixture', guild_id: TEST_ROOM, channel_id: 'lane-fixture', callback_route: 'command',
      data: { id: 'command-fixture', name: 'probe', type: 1, options: [] },
      user: { id: 'veiled-user-fixture', username: 'FixtureUser' },
      member: { user: { id: 'veiled-user-fixture', username: 'FixtureUser' }, roles: [] },
    };
    await Promise.all([...apiClient.listeners.get('INTERACTION_CREATE')].map((listener) => listener(rawInteraction)));
    await execution;
    assert.equal(dispatched.client.user.id, 'veiled-bot-fixture');
    assert.equal(dispatched.interaction.commandName, 'probe');
    assert.equal(dispatched.interaction.guild.id, TEST_ROOM);
    assert.deepEqual(dispatched.args, []);
  } finally {
    await handle?.stop();
    Module._load = originalLoad;
  }
});

test('the real SDK runs unchanged read-only commands from three categories with room-scoped registration and isolated clients', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'socket.io-client') return { io: () => { throw new Error('Network is disabled in the SDK command acceptance test.'); } };
    return originalLoad.call(this, request, parent, isMain);
  };

  let handle;
  try {
    const { sdk, compat } = loadBuiltSdkModules();
    const apiClient = new sdk.VeiledBotClient({
      token: 'offlineid.offline_secret_fixture_value',
      apiUrl: 'https://api.veiled.test',
      gatewayUrl: 'https://ws.veiled.test',
      intents: sdk.BOT_GATEWAY_INTENTS.INTERACTIONS | sdk.BOT_GATEWAY_INTENTS.MEMBERS,
    });
    const commandResponses = [];
    const memberReads = [];
    apiClient.post = async (route, body) => {
      commandResponses.push({ route, body });
      return { id: 'reply-fixture' };
    };
    apiClient.get = async (route) => {
      memberReads.push(route);
      if (route.startsWith('rooms/' + TEST_ROOM + '/members')) return {
        members: [
          { roomId: TEST_ROOM, userId: 'human-1', User: { id: 'human-1', username: 'HumanOne', isBot: false }, roles: [] },
          { roomId: TEST_ROOM, userId: 'human-2', User: { id: 'human-2', username: 'HumanTwo', isBot: false }, roles: [] },
          { roomId: TEST_ROOM, userId: 'bot-1', User: { id: 'bot-1', username: 'OtherBot', isBot: true }, roles: [] },
        ],
        total: 3,
        hasMore: false,
        nextCursor: null,
      };
      throw new Error('Unexpected API read in command acceptance fixture: ' + route);
    };

    const adapter = new compat.DiscordBotAdapter(apiClient);
    const runtime = new compat.DiscordRuntimeClient(adapter);
    const registrationCalls = [];
    runtime.user = { id: 'veiled-bot-fixture', username: 'VeiledFixture', displayAvatarURL: () => null };
    runtime.application = {
      id: 'veiled-app-fixture',
      name: 'VeiledFixture',
      commands: { set: async (...args) => { registrationCalls.push(args); return new Map(); } },
    };
    runtime.connect = async () => {};
    runtime.disconnect = () => {};
    const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Fixture room', adapter, runtime, { memberCount: 3 });
    runtime.guilds.cache.set(TEST_ROOM, guild);

    const discord = baseDiscordClient();
    discord.emotes.normal.check = '✅';
    const runFacades = [];
    const executions = [];
    const commands = [
      { name: 'worldclock', category: 'fun' },
      { name: 'encode', category: 'tools' },
      { name: 'members', category: 'guild' },
    ];
    for (const command of commands) {
      const run = loadUnchangedReadOnlyCommand(command.category, command.name);
      discord.commands.set(command.name, {
        data: { toJSON: () => ({ name: command.name, description: 'Offline fixture command' }) },
        run: (facade, interaction, args) => {
          runFacades.push(facade);
          const execution = run(facade, interaction, args);
          executions.push(execution);
          return execution;
        },
      });
    }

    let discordErrorEmits = 0;
    const originalEmit = discord.emit;
    discord.emit = (...args) => { discordErrorEmits += 1; return originalEmit(...args); };
    handle = await startVeiledRuntime({
      env: {
        VEILED_RUNTIME_ENABLED: 'true',
        VEILED_BOT_TOKEN: 'offlineid.offline_secret_fixture_value',
        VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
        VEILED_RUNTIME_REGISTER_COMMANDS: 'true',
      },
      discordClient: discord,
      sourceRoot: path.resolve(__dirname, '..'),
      runtimeFactory: () => ({ apiClient, adapter, runtime }),
      eventLoader: (_root, eventName) => {
        assert.equal(eventName, 'interactionCreate');
        return loadUnchangedInteractionModule();
      },
      discordLibrary: fakeDiscordLibrary(),
      logger: { error(error) { throw error; } },
    });

    assert.equal(handle.client.user.id, 'veiled-bot-fixture');
    assert.notEqual(handle.client.user, discord.user);
    assert.notEqual(handle.client.commands, discord.commands);
    assert.deepEqual(registrationCalls, [[[
      { name: 'ping', description: 'Ping' },
      ...commands.map(({ name }) => ({ name, description: 'Offline fixture command' })),
    ], TEST_ROOM]]);

    const fixtureUser = { id: 'user-fixture', username: 'FixtureUser', discriminator: '1111', isBot: false };
    const inputs = [
      { name: 'worldclock', options: [] },
      { name: 'encode', options: [{ name: 'text', type: 3, value: 'Veiled' }] },
      { name: 'members', options: [] },
    ];
    for (const [index, input] of inputs.entries()) {
      const rawInteraction = {
        id: 'interaction-' + input.name,
        interaction_id: 'interaction-' + input.name,
        application_id: 'veiled-app-fixture',
        type: 2,
        version: 1,
        token: 'fixture-interaction-token-' + index,
        guild_id: TEST_ROOM,
        channel_id: 'lane-fixture',
        callback_route: 'command',
        data: { id: 'command-' + input.name, name: input.name, type: 1, options: input.options },
        user: fixtureUser,
        member: { user: fixtureUser, roles: [] },
      };
      await Promise.all([...apiClient.listeners.get('INTERACTION_CREATE')].map((listener) => listener(rawInteraction)));
      await executions.at(-1);
    }

    assert.equal(commandResponses.length, 3);
    assert.deepEqual(commandResponses.map(({ route }) => route), inputs.map(({ name }) => 'interactions/commands/interaction-' + name + '/callback'));
    assert.ok(commandResponses.every(({ body }) => body.type === 'reply'), 'legacy editreply output should become an initial Veiled command reply when no acknowledgement exists');
    assert.match(JSON.stringify(commandResponses[0].body.embeds), /World clock/);
    assert.match(JSON.stringify(commandResponses[1].body.embeds), /1010110 1100101 1101001 1101100 1100101 1100100/);
    assert.match(JSON.stringify(commandResponses[2].body.embeds), /3 members/);
    assert.match(JSON.stringify(commandResponses[2].body.embeds), /1 bots/);
    assert.equal(memberReads.length, 1);
    assert.ok(memberReads[0].startsWith('rooms/' + TEST_ROOM + '/members'));
    assert.ok(runFacades.every((facade) => facade === handle.client));
    assert.ok(runFacades.every((facade) => facade.user.id === 'veiled-bot-fixture'));
    assert.equal(discord.commands.size, 4);
    assert.equal(discordErrorEmits, 0);
    assert.deepEqual(discord.user, { id: 'discord-bot-fixture', username: 'DiscordFixture' });
  } finally {
    await handle?.stop();
    Module._load = originalLoad;
  }
});

test('unchanged role info, moderation warnings, and message show commands execute through real SDK interactions without writes', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const apiClient = new sdk.VeiledBotClient({
    token: 'offlineid.offline_secret_fixture_value',
    apiUrl: 'https://api.veiled.test',
    gatewayUrl: 'https://ws.veiled.test',
    intents: sdk.BOT_GATEWAY_INTENTS.INTERACTIONS | sdk.BOT_GATEWAY_INTENTS.ROLES,
  });
  const apiRequests = [];
  const savedReplies = [];
  apiClient.get = async (route) => {
    apiRequests.push({ method: 'GET', route });
    if (route === 'rooms/' + TEST_ROOM + '/roles') return { roles: [{ id: 'moderator-role', name: 'Moderator', permissions: '8192' }] };
    throw new Error('Unexpected read in the command acceptance fixture: ' + route);
  };
  apiClient.post = async (route, body) => {
    apiRequests.push({ method: 'POST', route, body });
    savedReplies.push({ route, body });
    return { id: 'reply-' + savedReplies.length };
  };

  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Fixture room', adapter, runtime);
  runtime.guilds.cache.set(TEST_ROOM, guild);
  await guild.roles.fetch();

  const warningQueries = [];
  const warningModel = {
    findOne(query, callback) {
      warningQueries.push(query);
      callback(null, { Warnings: [{ Case: 4, Reason: 'Fixture warning', Moderator: 'staff-fixture' }] });
    },
  };
  const messageQueries = [];
  const messageModel = {
    findOne(query, callback) {
      messageQueries.push(query);
      callback(null, { Messages: 128 });
    },
  };
  const discord = fakeDiscordLibrary();
  discord.PermissionsBitField.Flags = { ManageMessages: 8192n };
  const moderationWarnings = loadUnchangedReadOnlyCommand('moderation', 'warnings', {
    discord,
    '../../database/models/warnings': warningModel,
  });
  const messageShow = loadUnchangedReadOnlyCommand('messages', 'show', {
    discord,
    '../../database/models/messages': messageModel,
  });
  const roleInfo = loadUnchangedReadOnlyCommand('guild', 'roleinfo', { discord });
  const discordClient = baseDiscordClient();
  discordClient.emotes.normal.error = '⚠️';
  const facade = createVeiledCommandClient(discordClient, runtime, {
    logger: { error() {} },
    discordLibrary: discord,
    databaseModels: { warnings: warningModel, messages: messageModel },
    roomId: TEST_ROOM,
  });
  const dispatched = [];
  runtime.on('interactionCreate', async (interaction) => {
    dispatched.push(interaction.commandName);
    if (interaction.commandName === 'moderation') return moderationWarnings(facade, interaction, interaction.options._hoistedOptions);
    if (interaction.commandName === 'messages') return messageShow(facade, interaction, interaction.options._hoistedOptions);
    if (interaction.commandName === 'guild') return roleInfo(facade, interaction, interaction.options._hoistedOptions);
    throw new Error('Unexpected command in read-only acceptance fixture: ' + interaction.commandName);
  });

  const operator = { id: 'operator-fixture', username: 'Operator', discriminator: '1001', isBot: false };
  const target = { id: 'target-fixture', username: 'Target', discriminator: '2002', isBot: false };
  const makeInteraction = (id, name, subcommand) => ({
    id,
    interaction_id: id,
    application_id: 'veiled-app-fixture',
    type: 2,
    version: 1,
    token: 'fixture-token-' + id,
    guild_id: TEST_ROOM,
    channel_id: 'lane-fixture',
    data: {
      id: 'command-' + name,
      name,
      type: 1,
      options: [{ type: 1, name: subcommand, options: [{ type: 6, name: 'user', value: target.id }] }],
      resolved: { users: { [target.id]: target } },
    },
    user: operator,
    member: { user: operator, roles: ['moderator-role'] },
  });
  const roleInteraction = {
    id: 'roleinfo-interaction',
    interaction_id: 'roleinfo-interaction',
    application_id: 'veiled-app-fixture',
    type: 2,
    version: 1,
    token: 'fixture-token-roleinfo',
    guild_id: TEST_ROOM,
    channel_id: 'lane-fixture',
    data: {
      id: 'command-guild',
      name: 'guild',
      type: 1,
      options: [{ type: 1, name: 'roleinfo', options: [{ type: 8, name: 'role', value: 'moderator-role' }] }],
      resolved: { roles: { 'moderator-role': { id: 'moderator-role', name: 'Moderator', permissions: '8192', isMentionable: true } } },
    },
    user: operator,
    member: { user: operator, roles: ['moderator-role'] },
  };
  const gatewayHandlers = [...apiClient.listeners.get('INTERACTION_CREATE')];
  assert.equal(gatewayHandlers.length, 1);
  for (const event of [
    makeInteraction('warnings-interaction', 'moderation', 'warnings'),
    makeInteraction('messages-interaction', 'messages', 'show'),
    roleInteraction,
  ]) {
    await Promise.all(gatewayHandlers.map((handler) => handler(event)));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(dispatched, ['moderation', 'messages', 'guild']);
  assert.deepEqual(warningQueries, [{ Guild: TEST_ROOM, User: target.id }]);
  assert.deepEqual(messageQueries, [{ Guild: TEST_ROOM, User: target.id }]);
  assert.equal(savedReplies.length, 3);
  assert.deepEqual(savedReplies.map(({ route }) => route), [
    'interactions/commands/warnings-interaction/callback',
    'interactions/commands/messages-interaction/callback',
    'interactions/commands/roleinfo-interaction/callback',
  ]);
  assert.ok(savedReplies.every(({ body }) => body.type === 'reply'));
  assert.match(JSON.stringify(savedReplies[0].body.embeds), /Fixture warning/);
  assert.match(JSON.stringify(savedReplies[1].body.embeds), /128/);
  assert.match(JSON.stringify(savedReplies[2].body.embeds), /Moderator/);
  assert.deepEqual(apiRequests.map(({ method, route }) => [method, route]), [
    ['GET', 'rooms/' + TEST_ROOM + '/roles'],
    ['POST', 'interactions/commands/warnings-interaction/callback'],
    ['POST', 'interactions/commands/messages-interaction/callback'],
    ['POST', 'interactions/commands/roleinfo-interaction/callback'],
  ]);
  runtime.disconnect();
});

test('participant DM messages use an explicit Veiled log lane and never reach Discord message handlers or webhooks', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const apiClient = new sdk.VeiledBotClient({
    token: 'offlineid.offline_secret_fixture_value',
    apiUrl: 'https://api.veiled.test',
    gatewayUrl: 'https://ws.veiled.test',
    intents: sdk.BOT_GATEWAY_INTENTS.MESSAGES | sdk.BOT_GATEWAY_INTENTS.MESSAGE_CONTENT,
  });
  apiClient.get = async (route) => {
    if (route === 'dms') return {
      channels: [{
        id: 'dm-fixture-channel',
        isGroup: false,
        participants: [
          { id: 'veiled-bot-fixture', username: 'VeiledFixture', isBot: true },
          { id: 'dm-author-fixture', username: 'DmAuthor', discriminator: '2020', isBot: false },
        ],
      }],
    };
    throw new Error('Unexpected API read in the DM acceptance fixture: ' + route);
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  runtime.user = { id: 'veiled-bot-fixture', username: 'VeiledFixture' };
  runtime.connect = async () => {};
  runtime.disconnect = () => {};
  const deliveredToVeiled = [];
  const roomHandlerCalls = [];
  const veiledLogLane = {
    id: 'veiled-dm-log-lane',
    type: 0,
    guild: { id: TEST_ROOM },
    send: async (payload) => { deliveredToVeiled.push(payload); return payload; },
  };
  runtime.channels.fetch = async (id) => {
    if (id !== veiledLogLane.id) throw new Error('Unexpected Veiled log lane in DM acceptance fixture.');
    return veiledLogLane;
  };
  const discord = baseDiscordClient();
  let discordWebhookAccesses = 0;
  Object.defineProperty(discord, 'webhooks', { get() { discordWebhookAccesses += 1; return { dmLogs: { send() { throw new Error('Discord webhook must never receive Veiled DM content.'); } } }; } });
  const errors = [];
  const handle = await startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'offlineid.offline_secret_fixture_value',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_EVENTS: 'messageCreate',
      VEILED_RUNTIME_DM_MESSAGES: 'true',
      VEILED_DM_LOG_LANE_ID: veiledLogLane.id,
    },
    discordClient: discord,
    runtimeFactory: () => ({ apiClient, adapter, runtime }),
    eventLoader: (_root, eventName) => {
      assert.equal(eventName, 'messageCreate');
      return async (_client, message) => { roomHandlerCalls.push(message); };
    },
    discordLibrary: fakeDiscordLibrary(),
    logger: { error(...args) { errors.push(args); } },
  });

  const gatewayHandlers = [...apiClient.listeners.get('DM_MESSAGE_CREATE')];
  assert.equal(gatewayHandlers.length, 1);
  const dmEvent = {
    channelId: 'dm-fixture-channel',
    message: {
      id: 'dm-message-fixture',
      author: { id: 'dm-author-fixture', username: 'DmAuthor', discriminator: '2020', isBot: false },
      content: 'Private note for the bot',
      createdAt: '2026-10-30T12:30:00.000Z',
      attachments: [{ id: 'dm-attachment-fixture', url: 'https://cdn.veiled.test/dm/private.png' }],
    },
  };
  await Promise.all(gatewayHandlers.map((handler) => handler(dmEvent)));

  assert.equal(deliveredToVeiled.length, 1);
  assert.equal(deliveredToVeiled[0].embeds[0].title, 'Direct message received');
  assert.match(deliveredToVeiled[0].embeds[0].description, /Private note for the bot/);
  assert.match(deliveredToVeiled[0].embeds[0].fields[1].value, /cdn\.veiled\.test\/dm\/private\.png/);
  assert.deepEqual(roomHandlerCalls, [], 'guild message handlers with room-scoped model writes never receive DM messages');
  assert.equal(discordWebhookAccesses, 0, 'Veiled DMs never read or call Discord webhook credentials');
  assert.deepEqual(errors, []);

  const dmChannel = runtime.dmChannels.cache.get('dm-fixture-channel');
  dmChannel.recipients.delete('veiled-bot-fixture');
  await Promise.all(gatewayHandlers.map((handler) => handler({
    ...dmEvent,
    message: { ...dmEvent.message, id: 'unscoped-dm-message-fixture' },
  })));
  assert.equal(deliveredToVeiled.length, 1, 'a DM channel that no longer includes the bot is rejected');
  assert.deepEqual(roomHandlerCalls, []);

  dmChannel.recipients.set('veiled-bot-fixture', { id: 'veiled-bot-fixture' });
  runtime.channels.fetch = async () => ({
    id: veiledLogLane.id,
    type: 0,
    guild: { id: 'another-room-fixture' },
    send: async () => { throw new Error('A foreign room must never receive DM content.'); },
  });
  await Promise.all(gatewayHandlers.map((handler) => handler({
    ...dmEvent,
    message: { ...dmEvent.message, id: 'foreign-log-lane-message-fixture' },
  })));
  assert.equal(deliveredToVeiled.length, 1, 'a log lane outside the configured Veiled room is rejected');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]?.message || errors[0][1]), /VEILED_DM_LOG_LANE_ID/);

  await handle.stop();
});

test('DM message logging requires an explicit Veiled lane when enabled', async () => {
  let runtimeFactoryCalls = 0;
  await assert.rejects(startVeiledRuntime({
    env: {
      VEILED_RUNTIME_ENABLED: 'true',
      VEILED_BOT_TOKEN: 'fixture-veiled-token',
      VEILED_RUNTIME_ROOM_ID: TEST_ROOM,
      VEILED_RUNTIME_EVENTS: 'messageCreate',
      VEILED_RUNTIME_DM_MESSAGES: 'true',
    },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => { runtimeFactoryCalls += 1; return { runtime: makeRuntime() }; },
    discordLibrary: fakeDiscordLibrary(),
  }), /VEILED_DM_LOG_LANE_ID/);
  assert.equal(runtimeFactoryCalls, 0, 'the explicit log-lane requirement is checked before connecting the runtime');
});

test('the built SDK dispatches a durable Veiled invite event through the unchanged sample event handler', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const listeners = new Map();
  const apiClient = new sdk.VeiledBotClient({ token: '12345678.abcdefghijklmnopqrstuvwxyz123456', apiUrl: 'https://api.veiled.test', gatewayUrl: 'https://ws.veiled.test' });
  apiClient.connect = async () => {};
  apiClient.disconnect = () => {};
  apiClient.on = (eventName, listener) => { listeners.set(eventName, listener); return apiClient; };
  apiClient.off = (eventName, listener) => { if (listeners.get(eventName) === listener) listeners.delete(eventName); return apiClient; };
  apiClient.get = async (route) => {
    assert.equal(route, 'bots/@me');
    return { user: { id: 'veiled-bot-fixture', username: 'VeiledFixture', isBot: true }, application: { id: 'veiled-app-fixture', name: 'VeiledFixture' } };
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  runtime.connect = async () => {};
  runtime.disconnect = () => {};
  runtime.hydrate = async () => {};
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Migration Test', adapter, runtime);
  runtime.guilds.cache.set(TEST_ROOM, guild);

  const sent = [];
  const logChannel = { id: 'veiled-log-lane', toString: () => '<#veiled-log-lane>', send: async (payload) => { sent.push(payload); return payload; } };
  runtime.channels.fetch = async (id) => {
    if (id !== logChannel.id) throw new Error('Unconfigured Veiled log lane.');
    return logChannel;
  };
  const queriedKeys = [];
  const databaseModels = { logChannels: { findOne: async ({ Guild }) => { queriedKeys.push(Guild); return Guild === 'veiled:' + TEST_ROOM ? { Channel: logChannel.id } : null; } } };
  const Discord = fakeDiscordLibrary();
  const handle = await startVeiledRuntime({
    env: { VEILED_RUNTIME_ENABLED: 'true', VEILED_BOT_TOKEN: 'fixture-veiled-token', VEILED_RUNTIME_ROOM_ID: TEST_ROOM, VEILED_RUNTIME_EVENTS: 'inviteCreate,inviteDelete' },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => ({ apiClient, adapter, runtime }),
    eventLoader: (_sourceRoot, eventName) => loadUnchangedInviteEvent(eventName),
    discordLibrary: Discord,
    databaseModels,
    logger: { error(error, details) { throw details || error; } },
  });

  const inviteEvent = {
    roomId: TEST_ROOM,
    inviteId: 'invite-row-fixture',
    code: 'sample123',
    inviter: { id: 'user-fixture', username: 'FixtureUser', discriminator: '4321', avatar: null, isBot: false },
    maxAge: 3600,
    maxUses: 5,
    uses: 0,
    temporary: false,
    createdAt: '2026-10-30T12:00:00.000Z',
    expiresAt: '2026-10-30T13:00:00.000Z',
  };
  await listeners.get('INVITE_CREATE')(inviteEvent);
  await listeners.get('INVITE_DELETE')(inviteEvent);

  assert.deepEqual(queriedKeys, ['veiled:' + TEST_ROOM, 'veiled:' + TEST_ROOM]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].embeds[0].title, '📨・Invite created');
  assert.deepEqual(sent[0].embeds[0].fields.map((field) => field.value), ['- sample123', '- <@user-fixture> (FixtureUser#4321)', '- <t:1793361600:R>']);
  assert.equal(sent[1].embeds[0].title, '📨・Invite deleted');
  assert.deepEqual(sent[1].embeds[0].fields.map((field) => field.value), ['- sample123', '- <t:1793361600:R>']);
  await handle.stop();
});

test('the built SDK projects a Veiled lane-create event for the unchanged sample channel handler', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const listeners = new Map();
  const apiClient = new sdk.VeiledBotClient({ token: '12345678.abcdefghijklmnopqrstuvwxyz123456', apiUrl: 'https://api.veiled.test', gatewayUrl: 'https://ws.veiled.test' });
  apiClient.connect = async () => {};
  apiClient.disconnect = () => {};
  apiClient.on = (eventName, listener) => { listeners.set(eventName, listener); return apiClient; };
  apiClient.off = (eventName, listener) => { if (listeners.get(eventName) === listener) listeners.delete(eventName); return apiClient; };
  apiClient.get = async (route) => {
    if (route === 'lanes/category-fixture') return {
      lane: { id: 'category-fixture', roomId: TEST_ROOM, name: 'General', type: 'CATEGORY', parentId: null, topic: null, position: 0 },
    };
    if (route === 'lanes/lane-created-fixture') return {
      lane: { id: 'lane-created-fixture', roomId: TEST_ROOM, name: 'announcements', type: 'TEXT', parentId: 'category-fixture', topic: null, position: 2 },
    };
    throw new Error('Unexpected API request in the channel event fixture: ' + route);
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  runtime.connect = async () => {};
  runtime.disconnect = () => {};
  runtime.hydrate = async () => {};
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Migration Test', adapter, runtime);
  runtime.guilds.cache.set(TEST_ROOM, guild);
  await guild.channels.fetch('category-fixture');

  const sent = [];
  const logChannel = { id: 'veiled-log-lane', toString: () => '<#veiled-log-lane>', send: async (payload) => { sent.push(payload); return payload; } };
  runtime.channels.fetch = async (id) => {
    if (id !== logChannel.id) throw new Error('Unconfigured Veiled log lane.');
    return logChannel;
  };
  const databaseModels = { logChannels: { findOne: async ({ Guild }) => Guild === 'veiled:' + TEST_ROOM ? { Channel: logChannel.id } : null } };
  const handle = await startVeiledRuntime({
    env: { VEILED_RUNTIME_ENABLED: 'true', VEILED_BOT_TOKEN: 'fixture-veiled-token', VEILED_RUNTIME_ROOM_ID: TEST_ROOM, VEILED_RUNTIME_EVENTS: 'channelCreate' },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => ({ apiClient, adapter, runtime }),
    eventLoader: (_sourceRoot, eventName) => loadUnchangedChannelEvent(eventName),
    discordLibrary: fakeDiscordLibrary(),
    databaseModels,
    logger: { error(error, details) { throw details || error; } },
  });

  await listeners.get('LANE_CREATE')({ roomId: TEST_ROOM, laneId: 'lane-created-fixture' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].title, '🔧・Channel created');
  assert.deepEqual(sent[0].embeds[0].fields.map((field) => field.value), [
    '- announcements',
    '- lane-created-fixture',
    '- <#category-fixture>',
    '- <#lane-created-fixture>',
    '- Text Channel',
  ]);
  assert.equal(guild.channels.cache.get('lane-created-fixture')?.name, 'announcements');
  await handle.stop();
});

test('the built SDK projects public thread lifecycle events for the unchanged sample handlers', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const listeners = new Map();
  const apiClient = new sdk.VeiledBotClient({ token: '12345678.abcdefghijklmnopqrstuvwxyz123456', apiUrl: 'https://api.veiled.test', gatewayUrl: 'https://ws.veiled.test' });
  apiClient.connect = async () => {};
  apiClient.disconnect = () => {};
  apiClient.on = (eventName, listener) => { listeners.set(eventName, listener); return apiClient; };
  apiClient.off = (eventName, listener) => { if (listeners.get(eventName) === listener) listeners.delete(eventName); return apiClient; };
  apiClient.get = async (route) => {
    if (route === 'lanes/thread-parent-fixture') return {
      lane: { id: 'thread-parent-fixture', roomId: TEST_ROOM, name: 'forum', type: 'FORUM', parentId: null, topic: null, position: 0 },
    };
    throw new Error('Unexpected API request in the thread event fixture: ' + route);
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  runtime.connect = async () => {};
  runtime.disconnect = () => {};
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Migration Test', adapter, runtime);
  runtime.guilds.cache.set(TEST_ROOM, guild);

  const sent = [];
  const logChannel = { id: 'veiled-thread-log-lane', toString: () => '<#veiled-thread-log-lane>', send: async (payload) => { sent.push(payload); return payload; } };
  runtime.channels.fetch = async (id) => {
    if (id !== logChannel.id) throw new Error('Unconfigured Veiled log lane.');
    return logChannel;
  };
  const databaseModels = { logChannels: { findOne: async ({ Guild }) => Guild === 'veiled:' + TEST_ROOM ? { Channel: logChannel.id } : null } };
  const handle = await startVeiledRuntime({
    env: { VEILED_RUNTIME_ENABLED: 'true', VEILED_BOT_TOKEN: 'fixture-veiled-token', VEILED_RUNTIME_ROOM_ID: TEST_ROOM, VEILED_RUNTIME_EVENTS: 'threadCreate,threadUpdate,threadDelete' },
    discordClient: baseDiscordClient(),
    runtimeFactory: () => ({ apiClient, adapter, runtime }),
    eventLoader: (_sourceRoot, eventName) => loadUnchangedThreadEvent(eventName),
    discordLibrary: fakeDiscordLibrary(),
    databaseModels,
    logger: { error(error, details) { throw details || error; } },
  });

  const event = { roomId: TEST_ROOM, laneId: 'thread-parent-fixture', threadId: 'thread-fixture', name: 'Before rename', ownerId: 'thread-owner', isPrivate: false, isArchived: false, isLocked: false, autoArchiveDuration: 86400 };
  await listeners.get('THREAD_CREATE')(event);
  await listeners.get('THREAD_UPDATE')({ ...event, oldName: 'Before rename', name: 'After rename', isPinned: true });
  await listeners.get('THREAD_DELETE')({ ...event, name: 'After rename' });

  assert.equal(sent.length, 3);
  assert.equal(sent[0].embeds[0].title, '📖・Thread created');
  assert.deepEqual(sent[0].embeds[0].fields.map((field) => field.value), ['- Before rename', '- thread-fixture', '<#thread-parent-fixture>', '<#thread-fixture>', 'Public Thread']);
  assert.equal(sent[1].embeds[0].title, '📖・Thread updated');
  assert.deepEqual(sent[1].embeds[0].fields.map((field) => field.value), ['- Before rename', '- After rename', '- thread-fixture', '<#thread-parent-fixture>', '<#thread-fixture>', 'Public Thread']);
  assert.equal(sent[2].embeds[0].title, '📖・Thread deleted');
  assert.deepEqual(sent[2].embeds[0].fields.map((field) => field.value), ['- After rename', '- thread-fixture', '<#thread-parent-fixture>', 'Public Thread']);
  assert.equal(guild.channels.cache.has('thread-fixture'), false, 'delete should evict the thread from the guild cache');

  await listeners.get('THREAD_CREATE')({ ...event, threadId: 'private-thread-fixture', isPrivate: true });
  assert.equal(sent.length, 3, 'private thread events are not part of the bot gateway projection');
  await assert.rejects(listeners.get('THREAD_CREATE')({ ...event, roomId: 'other-room-fixture', threadId: 'foreign-thread-fixture' }), /Unexpected API request/);
  assert.equal(sent.length, 3, 'a thread outside the configured room must not reach unchanged handlers');
  await handle.stop();
});

test('the unchanged member-count command creates a Veiled voice lane with its mapped restricted overwrite', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const requestBodies = [];
  const apiClient = new sdk.VeiledBotClient({ token: '12345678.abcdefghijklmnopqrstuvwxyz123456', apiUrl: 'https://api.veiled.test', gatewayUrl: 'https://ws.veiled.test' });
  apiClient.post = async (route, body) => {
    assert.equal(route, 'rooms/' + TEST_ROOM + '/lanes');
    requestBodies.push(body);
    return { lane: { id: 'member-count-lane', roomId: TEST_ROOM, name: body.name, type: 'VOICE', parentId: null, bitrateKbps: 64, userLimit: 0 } };
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Migration Test', adapter, runtime, { memberCount: 1234 });
  runtime.guilds.cache.set(TEST_ROOM, guild);

  const records = new Map([['veiled:' + TEST_ROOM, { Guild: 'veiled:' + TEST_ROOM, ChannelTemplate: '{emoji} {name}' }]]);
  class StatsModel {
    constructor(values) { Object.assign(this, values); }
    async save() { records.set(this.Guild, this); return this; }
    static findOne(query, callback) {
      const value = records.get(query.Guild) || null;
      if (callback) { callback(null, value); return undefined; }
      return Promise.resolve(value);
    }
  }

  const command = loadUnchangedMembersStatCommand(StatsModel);
  const replyBodies = [];
  const interaction = { guild, editReply: async (body) => { replyBodies.push(body); return body; } };
  const facade = createVeiledCommandClient(baseDiscordClient(), runtime, {
    logger: { error() {} },
    discordLibrary: fakeDiscordLibrary(),
    databaseModels: { stats: StatsModel },
    roomId: TEST_ROOM,
  });

  await command(facade, interaction, []);

  assert.deepEqual(requestBodies, [{
    name: '👤 Members: 1,234',
    type: 'VOICE',
    permissionOverwrites: [{ targetId: TEST_ROOM, targetType: 'role', allow: '0', deny: String(1n << 20n) }],
  }]);
  assert.equal(replyBodies.length, 1);
  assert.match(replyBodies[0].embeds[0].description, /Member count created/);
  assert.equal(records.has(TEST_ROOM), true);
});

test('the unchanged guild member-count command uses the Veiled member manager and separates users from bots', { skip: !process.env.VEILED_SDK_PATH }, async () => {
  const { sdk, compat } = loadBuiltSdkModules();
  const requestedRoutes = [];
  const apiClient = new sdk.VeiledBotClient({ token: '12345678.abcdefghijklmnopqrstuvwxyz123456', apiUrl: 'https://api.veiled.test', gatewayUrl: 'https://ws.veiled.test' });
  apiClient.get = async (route) => {
    requestedRoutes.push(route);
    if (route !== 'rooms/' + TEST_ROOM + '/members?limit=500') throw new Error('Unexpected API request in the guild members fixture: ' + route);
    return {
      success: true,
      total: 3,
      hasMore: false,
      nextCursor: null,
      members: [
        { roomId: TEST_ROOM, userId: 'human-1', User: { id: 'human-1', username: 'HumanOne', isBot: false }, roles: [] },
        { roomId: TEST_ROOM, userId: 'human-2', User: { id: 'human-2', username: 'HumanTwo', isBot: false }, roles: [] },
        { roomId: TEST_ROOM, userId: 'bot-1', User: { id: 'bot-1', username: 'BotOne', isBot: true }, roles: [] },
      ],
    };
  };
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  const guild = new compat.DiscordGuildRuntime(TEST_ROOM, 'Migration Test', adapter, runtime, { _count: { RoomMember: 3 } });
  runtime.guilds.cache.set(TEST_ROOM, guild);
  const responses = [];
  const command = loadUnchangedGuildMembersCommand();
  const facade = createVeiledCommandClient(baseDiscordClient(), runtime, {
    logger: { error() {} },
    discordLibrary: fakeDiscordLibrary(),
    roomId: TEST_ROOM,
  });

  await command(facade, { guild, editReply: async (payload) => { responses.push(payload); return payload; } }, []);

  assert.deepEqual(requestedRoutes, ['rooms/' + TEST_ROOM + '/members?limit=500']);
  assert.equal(guild.memberCount, 3);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].embeds[0].fields.map((field) => field.value), ['2 members', '1 bots', '3 members']);
});
