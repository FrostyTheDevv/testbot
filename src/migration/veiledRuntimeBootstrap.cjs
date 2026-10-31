'use strict';

const path = require('node:path');
const fs = require('node:fs');
const voiceCompat = require('./discordVoiceCompat.cjs');

const SUPPORTED_RUNTIME_EVENTS = new Set([
  'interactionCreate',
  'inviteCreate',
  'inviteDelete',
  'messageCreate',
  'messageUpdate',
  'messageDelete',
  'messageReactionAdd',
  'messageReactionRemove',
  'channelCreate',
  'channelUpdate',
  'channelDelete',
  'threadCreate',
  'threadUpdate',
  'threadDelete',


  'roleCreate',
  'roleUpdate',
  'roleDelete',



]);

const BLOCKED_DISCORD_CLIENT_PROPERTIES = new Set([
  'player',
  'playerManager',
  'queue',
  'triviaManager',
  'voice',
  'connectToChannel',
  'play',
  'radioStart',
  'radioStop',
  'soundboard',
  'startStream',
  'webhooks',
  'emojis',
  'token',
  'ws',
  'shard',
  'rest',
  'restManager',
  'login',
  'destroy',
]);

function enabled(env = process.env) {
  return env.VEILED_RUNTIME_ENABLED === 'true';
}

function parseRuntimeEvents(value) {
  const names = String(value || 'interactionCreate').split(',').map((name) => name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new TypeError('VEILED_RUNTIME_EVENTS must not contain duplicate event names.');
  for (const name of names) {
    if (!SUPPORTED_RUNTIME_EVENTS.has(name)) throw new TypeError('Unsupported Veiled runtime event requested: ' + name);
  }
  return names;
}

function eventRoomId(eventName, args) {
  const value = args[0];
  if (!value || typeof value !== 'object') return null;
  if ((eventName === 'messageReactionAdd' || eventName === 'messageReactionRemove') && typeof value.message?.guildId === 'string') return value.message.guildId;
  if (typeof value.guildId === 'string') return value.guildId;
  if (typeof value.guild_id === 'string') return value.guild_id;
  if (typeof value.roomId === 'string') return value.roomId;
  if (value.guild && typeof value.guild.id === 'string') return value.guild.id;
  if (value.room && typeof value.room.id === 'string') return value.room.id;
  if (eventName === 'voiceStateUpdate' && args[1] && typeof args[1].guild?.id === 'string') return args[1].guild.id;
  return null;
}

function isParticipantDmMessage(message, runtime) {
  const channel = message?.channel;
  const authorId = message?.author?.id;
  const botId = runtime?.user?.id;
  return message?.guildId === null
    && message?.guild === null
    && typeof authorId === 'string'
    && typeof botId === 'string'
    && channel?.guildId === null
    && (channel?.type === 1 || channel?.type === 3)
    && typeof channel.id === 'string'
    && channel.id === message.channelId
    && channel.recipients?.has?.(authorId) === true
    && channel.recipients?.has?.(botId) === true;
}

async function writeVeiledDmLog(runtime, roomId, laneId, message) {
  const lane = await runtime.channels.fetch(laneId);
  if (lane?.guild?.id !== roomId || lane.type !== 0 || typeof lane.send !== 'function') {
    throw new Error('VEILED_DM_LOG_LANE_ID must identify a text lane in VEILED_RUNTIME_ROOM_ID.');
  }
  const author = message.author;
  const attachments = [...(message.attachments?.values?.() || [])]
    .map((attachment) => attachment?.url)
    .filter((url) => typeof url === 'string' && url.length > 0)
    .slice(0, 10);
  const content = typeof message.content === 'string' && message.content.trim()
    ? message.content.slice(0, 3800)
    : '(No text content)';
  const fields = [{
    name: 'From',
    value: `${author?.tag || author?.username || 'Unknown user'} (${author?.id || 'unknown ID'})`.slice(0, 1024),
    inline: false,
  }];
  if (attachments.length) fields.push({ name: 'Attachments', value: attachments.join('\n').slice(0, 1024), inline: false });
  await lane.send({
    embeds: [{
      title: 'Direct message received',
      description: content,
      fields,
      ...(message.createdAt instanceof Date ? { timestamp: message.createdAt.toISOString() } : {}),
    }],
  });
}

function findEventModule(sourceRoot, eventName) {
  const updateHandlers = {
    channelUpdate: [
      { file: 'channel/channelNameUpdate.js', field: 'name' },
      { file: 'channel/channelTopicUpdate.js', field: 'topic' },
    ],
    roleUpdate: [
      { file: 'role/roleNameUpdate.js', field: 'name' },
      { file: 'role/roleColorUpdate.js', field: 'color' },
      { file: 'role/rolePermissionsUpdate.js', field: 'permissions' },
    ],
  }[eventName];
  if (updateHandlers) {
    const handlers = updateHandlers.map(({ file, field }) => ({
      field,
      handler: require(path.resolve(sourceRoot, 'src', 'events', file)),
    }));
    return async (client, oldValue, newValue) => {
      for (const { field, handler } of handlers) {
        const previous = field === 'permissions' ? oldValue?.permissions?.bitfield ?? oldValue?.permissions : oldValue?.[field];
        const next = field === 'permissions' ? newValue?.permissions?.bitfield ?? newValue?.permissions : newValue?.[field];
        if (previous !== next) await handler(client, newValue, previous, next);
      }
    };
  }
  const base = path.resolve(sourceRoot, 'src', 'events');
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === eventName + '.js') matches.push(fullPath);
    }
  };
  visit(base);
  if (matches.length !== 1) throw new Error('Expected exactly one unchanged event module for ' + eventName + '; found ' + matches.length + '.');
  return require(matches[0]);
}
function createVeiledCommandClient(discordClient, runtime, { logger = console, loadSubcommand, discordLibrary, databaseModels = {}, roomId = null } = {}) {
  const Discord = discordLibrary || require('discord.js');
  const config = sanitizeRuntimeConfig(discordClient.config);
  const emotes = sanitizeRuntimeConfig(discordClient.emotes);
  const commands = new Map(discordClient.commands || []);
  const templateEmbed = () => new Discord.EmbedBuilder()
    .setColor(config?.colors?.normal ?? 0x5865f2)
    .setFooter({ text: config?.discord?.footer || 'Veiled', ...(runtime.user?.displayAvatarURL?.() ? { iconURL: runtime.user.displayAvatarURL() } : {}) })
    .setTimestamp();
  const sendEmbed = async ({ embeds, content, components, type }, target) => {
    const normalizedType = String(type || '').toLowerCase();
    const payload = { embeds, content, components };
    if (normalizedType === 'ephemeral' || normalizedType === 'ephemeraledit') payload.flags = 64;
    const isInitialVeiledEditReply = normalizedType === 'editreply'
      && target && target.replied === false && target.deferred === false;
    const method = isInitialVeiledEditReply
      ? 'reply'
      : normalizedType === 'update'
      ? 'update'
      : normalizedType === 'editreply' || normalizedType === 'ephemeraledit'
        ? 'editReply'
        : normalizedType === 'edit'
          ? 'edit'
          : normalizedType === 'reply' || normalizedType === 'ephemeral'
            ? 'reply'
            : typeof target?.send === 'function' ? 'send' : 'reply';
    if (typeof target?.[method] !== 'function') throw new Error('Veiled response target does not support ' + method + '.');
    return target[method](payload);
  };
  const buildEmbed = (options = {}, simple = false) => {
    const embed = options.embed ?? templateEmbed();
    if (options.title) embed.setTitle(options.title);
    if (options.desc) embed.setDescription(options.desc.length >= 2048 ? options.desc.slice(0, 2044) + '...' : options.desc);
    if (options.image) embed.setImage(options.image);
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.fields) embed.addFields(options.fields);
    if (options.author) {
      if (Array.isArray(options.author)) embed.setAuthor({ name: options.author[0], ...(options.author[1] ? { iconURL: options.author[1] } : {}) });
      else embed.setAuthor(options.author);
    }
    if (options.url) embed.setURL(options.url);
    if (options.footer) embed.setFooter(typeof options.footer === 'string' ? { text: options.footer } : options.footer);
    if (options.color !== undefined) embed.setColor(options.color);
    else if (simple) embed.setColor(config?.colors?.normal ?? 0x5865f2);
    return embed;
  };
  const success = (options, target) => {
    const embed = buildEmbed(options);
    if (options.text) embed.setDescription(options.text);
    embed.setColor(config?.colors?.succes ?? 0x57f287);
    return sendEmbed({ embeds: [embed], content: options.content, components: options.components, type: options.type }, target);
  };
  const error = (options, target, description) => {
    const embed = buildEmbed(options);
    if (description) embed.setDescription(description);
    if (options.error) embed.addFields({ name: '💬┆Error', value: '```' + String(options.error).slice(0, 1000) + '```' });
    embed.setColor(config?.colors?.error ?? 0xed4245);
    return sendEmbed({ embeds: [embed], content: options.content, components: options.components, type: options.type }, target);
  };
  const hasPermission = (interaction, flags, includeBot) => (async () => {
    const required = Array.isArray(flags) ? flags : [];
    const userPermissions = interaction.member?.permissions;
    for (const flag of required) {
      if (!userPermissions?.has?.(flag)) {
        await facade.errMissingPerms({ perms: facade.bitfieldToName(flag), type: 'editreply' }, interaction);
        return false;
      }
    }
    if (includeBot) {
      const botId = runtime.user?.id;
      const bot = botId ? interaction.guild?.members?.cache?.get(botId) : null;
      for (const flag of required) {
        if (!bot?.permissions?.has?.(flag)) {
          await facade.errNoPerms({ perms: facade.bitfieldToName(flag), type: 'editreply' }, interaction);
          return false;
        }
      }
    }
    return true;
  })();
  const getSlashMentions = (commandName) => {
    const command = commands.get(commandName);
    const data = command?.data?.toJSON?.() ?? command?.data;
    const options = Array.isArray(data?.options) ? data.options : [];
    return options.map((option) => [`/${commandName} ${option.name}`, option.description || '']);
  };
  const scopedRoomKey = (guildId) => {
    if (typeof guildId !== 'string' || !guildId) throw new TypeError('A Veiled room ID is required for scoped configuration.');
    if (roomId && guildId !== roomId) throw new Error('Veiled runtime configuration is restricted to the configured room.');
    return 'veiled:' + guildId;
  };
  const loadModel = (name) => databaseModels[name] || require(path.resolve(__dirname, '..', 'database', 'models', name + '.js'));
  const persistRoomSetting = async (Schema, guildId, field, value) => {
    const key = scopedRoomKey(guildId);
    const data = await Schema.findOne({ Guild: key });
    if (data) {
      data[field] = value;
      await data.save();
      return data;
    }
    const created = new Schema({ Guild: key, [field]: value });
    await created.save();
    return created;
  };
  const overrides = {
    commands,
    uptime: Math.floor(process.uptime() * 1000),
    templateEmbed,
    sendEmbed,
    getSlashMentions,
    getLogs: async (guildId) => {
      const data = await loadModel('logChannels').findOne({ Guild: scopedRoomKey(guildId) });
      if (!data?.Channel) return false;
      try { return await runtime.channels.fetch(data.Channel); } catch { return false; }
    },
    getTemplate: async (guild) => {
      try {
        const data = await loadModel('stats').findOne({ Guild: scopedRoomKey(guild?.id) });
        return data?.ChannelTemplate || '{emoji} {name}';
      } catch {
        return '{emoji} {name}';
      }
    },
    createChannelSetup: async (Schema, channel, interaction) => {
      const guildId = interaction?.guild?.id;
      await persistRoomSetting(Schema, guildId, 'Channel', channel.id);
      return overrides.succNormal({
        text: 'Channel has been set up successfully!',
        fields: [{ name: '📘┆Channel', value: `${channel} (${channel.id})` }],
        type: 'editreply',
      }, interaction);
    },
    createRoleSetup: async (Schema, role, interaction) => {
      const guildId = interaction?.guild?.id;
      await persistRoomSetting(Schema, guildId, 'Role', role.id);
      return overrides.succNormal({
        text: 'Role has been set up successfully!',
        fields: [{ name: '📘┆Role', value: `${role} (${role.id})` }],
        type: 'editreply',
      }, interaction);
    },
    embed: async (options, target) => sendEmbed({ embeds: [buildEmbed(options)], content: options.content, components: options.components, type: options.type }, target),
    simpleEmbed: async (options, target) => sendEmbed({ embeds: [buildEmbed(options, true)], content: options.content, components: options.components, type: options.type }, target),
    succNormal: async (options, target) => success(options, target),
    errNormal: async (options, target) => error(options, target),
    errMissingPerms: async (options, target) => error(options, target, "You don't have the right permissions"),
    errNoPerms: async (options, target) => error(options, target, "I don't have the right permissions"),
    errUsage: async (options, target) => {
      const embed = buildEmbed(options).setTitle('Error!').setDescription('You did not provide the correct arguments');
      if (options.usage) embed.addFields({ name: 'Required arguments', value: '```' + String(options.usage).slice(0, 1000) + '```' });
      embed.setColor(config?.colors?.error ?? 0xed4245);
      return sendEmbed({ embeds: [embed], content: options.content, components: options.components, type: options.type }, target);
    },
    errWait: async (options, target) => error(options, target, 'Try again on <t:' + options.time + ':f>'),
    checkPerms: (options, interaction) => hasPermission(interaction, options?.flags, true),
    checkUserPerms: (options, interaction) => hasPermission(interaction, options?.flags, false),
    checkBotPerms: (options, interaction) => hasPermission(interaction, options?.flags, true),
    bitfieldToName: (bitfield) => {
      try { return new Discord.PermissionsBitField(bitfield).toArray(); }
      catch { return [String(bitfield)]; }
    },
    removeMentions: (text) => String(text).replaceAll('@', '@\u200b'),
    getChannel: (channel, message) => message?.mentions?.channels?.first?.() || message?.guild?.channels?.cache?.get?.(channel) || message?.guild?.channels?.cache?.find?.((item) => item.name === channel),
    getSlashMentions,
    emit(eventName, ...args) {
      logger.error('Veiled command emitted ' + String(eventName), ...args);
      return false;
    },
    loadSubcommands: async (_client, interaction, args) => {
      if (typeof loadSubcommand !== 'function') throw new Error('Veiled subcommand loading is not configured.');
      return loadSubcommand(overrides, interaction, args);
    },
  };
  runtime.getSlashMentions = getSlashMentions;
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol') {
        if (property === Symbol.toStringTag) return 'VeiledCommandClient';
        return undefined;
      }
      if (property === 'user') return runtime.user;
      if (property === 'application') return runtime.application;
      if (property === 'guilds') return runtime.guilds;
      if (property === 'channels') return runtime.channels;
      if (property === 'users') return runtime.users;
      if (property === 'users') return runtime.users;
      if (property === 'config') return config;
      if (property === 'emotes') return emotes;
      if (property === 'on' || property === 'once' || property === 'off' || property === 'removeListener') {
        const method = runtime[property];
        return typeof method === 'function' ? method.bind(runtime) : undefined;
      }
      if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      if (typeof property === 'string' && BLOCKED_DISCORD_CLIENT_PROPERTIES.has(property)) {
        throw new Error('Discord-only client capability is blocked in the Veiled runtime: ' + property);
      }
      throw new Error('Unmapped Discord.js client property is unavailable in the Veiled runtime: ' + property);
    },
    set(_target, property, value) {
      if (property === 'user' || property === 'guilds' || property === 'channels' || property === 'commands' || property === 'application') {
        throw new Error('Veiled runtime identity and managers are read-only.');
      }
      overrides[property] = value;
      return true;
    },
  });
}

function sanitizeRuntimeConfig(value) {
  const sensitiveKey = /token|secret|password|credential|api.?key|private.?key|webhook/i;
  const clone = (input) => {
    if (Array.isArray(input)) return input.map(clone);
    if (!input || typeof input !== 'object') return input;
    const output = {};
    for (const [key, child] of Object.entries(input)) {
      if (sensitiveKey.test(key)) continue;
      output[key] = clone(child);
    }
    return output;
  };
  return clone(value || {});
}

function defaultRuntimeFactory(env) {
  const { sdk, compat } = loadSdkModules(env);
  const token = env.VEILED_BOT_TOKEN;
  if (!token) throw new Error('VEILED_BOT_TOKEN is required when VEILED_RUNTIME_ENABLED=true.');
  const intents = env.VEILED_RUNTIME_INTENTS === undefined || String(env.VEILED_RUNTIME_INTENTS).trim() === ''
    ? sdk.BOT_GATEWAY_INTENTS.INTERACTIONS | sdk.BOT_GATEWAY_INTENTS.ROOMS | sdk.BOT_GATEWAY_INTENTS.MEMBERS
    : Number(env.VEILED_RUNTIME_INTENTS);
  if (!Number.isSafeInteger(intents) || intents < 0) throw new TypeError('VEILED_RUNTIME_INTENTS must be a non-negative integer bitfield.');
  const apiClient = new sdk.VeiledBotClient({
    token,
    apiUrl: env.VEILED_RUNTIME_API_URL || 'https://api.veiled.lol',
    gatewayUrl: env.VEILED_GATEWAY_URL || 'https://ws.veiled.lol',
    intents,
  });
  const adapter = new compat.DiscordBotAdapter(apiClient);
  const runtime = new compat.DiscordRuntimeClient(adapter);
  return { apiClient, adapter, runtime };
}

function resolveVoiceSessionPath(env = process.env) {
  const configured = String(env.VEILED_RUNTIME_VOICE_SESSION_PATH || '').trim();
  if (configured) return path.resolve(configured);
  let packageRoot = String(env.VEILED_SDK_PATH || '').trim();
  if (!packageRoot) {
    const packageName = env.VEILED_SDK_PACKAGE || '@veiled/bot-sdk';
    const entry = require.resolve(packageName + '/discord');
    packageRoot = path.resolve(path.dirname(entry), '..');
  }
  return path.resolve(packageRoot, '..', '..', 'bot-voice', 'VoiceSession.js');
}

function loadSdkModules(env = process.env) {
  const configuredPath = String(env.VEILED_SDK_PATH || '').trim();
  if (configuredPath) {
    const packageRoot = path.resolve(configuredPath);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const mainEntry = packageJson.exports?.['.']?.require?.default || packageJson.main;
    const discordEntry = packageJson.exports?.['./discord']?.require?.default;
    if (typeof mainEntry !== 'string' || typeof discordEntry !== 'string') {
      throw new Error('VEILED_SDK_PATH must point to a built @veiled/bot-sdk package with CommonJS root and ./discord exports.');
    }
    return {
      sdk: require(path.resolve(packageRoot, mainEntry)),
      compat: require(path.resolve(packageRoot, discordEntry)),
    };
  }
  const packageName = env.VEILED_SDK_PACKAGE || '@veiled/bot-sdk';
  return { sdk: require(packageName), compat: require(packageName + '/discord') };
}

function defaultLoadSubcommand(sourceRoot) {
  return async (client, interaction, args) => {
    const commandName = interaction.commandName;
    const subcommand = interaction.options?.getSubcommand?.();
    if (!/^[a-z0-9_-]+$/i.test(String(commandName || '')) || !/^[a-z0-9_-]+$/i.test(String(subcommand || ''))) {
      throw new TypeError('Command and subcommand names must be simple path-safe identifiers.');
    }
    let filename = path.resolve(sourceRoot, 'src', 'commands', commandName, subcommand + '.js');
    const base = path.resolve(sourceRoot, 'src', 'commands') + path.sep;
    if (!filename.startsWith(base)) throw new TypeError('Subcommand path escaped the sample command directory.');
    try {
      const Functions = require(path.resolve(sourceRoot, 'src', 'database', 'models', 'functions.js'));
      const settings = await Functions.findOne({ Guild: interaction.guild?.id });
      if (settings?.Beta === true) {
        const beta = path.resolve(sourceRoot, 'src', 'commands', commandName, subcommand + '-beta.js');
        if (fs.existsSync(beta)) filename = beta;
      }
    } catch {}
    const command = require(filename);
    const run = typeof command === 'function' ? command : command?.run;
    if (typeof run !== 'function') throw new TypeError('The selected subcommand does not export a runnable handler.');
    return run(client, interaction, args);
  };
}

async function startVeiledRuntime({
  env = process.env,
  discordClient,
  sourceRoot = process.cwd(),
  runtimeFactory = defaultRuntimeFactory,
  eventLoader = findEventModule,
  subcommandLoader,
  logger = console,
  discordLibrary,
  databaseModels = {},
} = {}) {
  if (!enabled(env)) return { enabled: false, stop: async () => {} };
  if (!discordClient) throw new TypeError('The existing Discord.js client is required.');
  const roomId = String(env.VEILED_RUNTIME_ROOM_ID || '').trim();
  if (!roomId) throw new Error('VEILED_RUNTIME_ROOM_ID is required to isolate this Veiled test runtime.');
  const veiledToken = String(env.VEILED_BOT_TOKEN || '').trim().replace(/^Bot\s+/i, '');
  const discordToken = String(env.DISCORD_TOKEN || '').trim().replace(/^Bot\s+/i, '');
  if (veiledToken && discordToken && veiledToken === discordToken) throw new Error('Discord and Veiled bot credentials must be different.');
  const eventNames = parseRuntimeEvents(env.VEILED_RUNTIME_EVENTS);
  const dmMessagesEnabled = env.VEILED_RUNTIME_DM_MESSAGES === 'true';
  const dmLogLaneId = String(env.VEILED_DM_LOG_LANE_ID || '').trim();
  if (dmMessagesEnabled && !eventNames.includes('messageCreate')) {
    throw new Error('VEILED_RUNTIME_DM_MESSAGES=true requires messageCreate in VEILED_RUNTIME_EVENTS.');
  }
  if (dmMessagesEnabled && !dmLogLaneId) {
    throw new Error('VEILED_RUNTIME_DM_MESSAGES=true requires VEILED_DM_LOG_LANE_ID; Veiled DM content is never sent to Discord webhooks.');
  }
  if (eventNames.includes('messageCreate') && !dmMessagesEnabled) {
    logger.warn?.('Veiled DM message logging is disabled. Set VEILED_RUNTIME_DM_MESSAGES=true and VEILED_DM_LOG_LANE_ID to opt in to Veiled-only logging.');
  }
  const { apiClient, adapter, runtime } = runtimeFactory(env);
  if (!runtime || typeof runtime.connect !== 'function' || typeof runtime.on !== 'function') throw new TypeError('The Veiled runtime factory returned an invalid runtime.');
  if (typeof runtime.guilds?.fetch === 'function') {
    await voiceCompat.configureVeiledRuntime({
      runtime,
      roomId,
      token: veiledToken,
      api: env.VEILED_RUNTIME_API_URL || 'https://api.veiled.lol',
      gatewayUrl: env.VEILED_GATEWAY_URL || 'https://ws.veiled.lol',
      voiceSessionPath: resolveVoiceSessionPath(env),
      logger,
    });
  }
  const facade = createVeiledCommandClient(discordClient, runtime, {
    logger,
    loadSubcommand: subcommandLoader ?? defaultLoadSubcommand(sourceRoot),
    discordLibrary,
    databaseModels,
    roomId,
  });
  const subscriptions = [];
  for (const eventName of eventNames) {
    const handler = eventLoader(sourceRoot, eventName);
    const listener = (...args) => {
      const eventRoom = eventRoomId(eventName, args);
      const isReactionEvent = eventName === 'messageReactionAdd' || eventName === 'messageReactionRemove';
      const isDmReaction = isReactionEvent && args[0]?.message?.guildId === null;
      const message = args[0];
      const isDmMessage = eventName === 'messageCreate' && isParticipantDmMessage(message, runtime);
      if (eventName === 'messageCreate' && message?.guildId === null) {
        if (!isDmMessage || !dmMessagesEnabled) return undefined;
        return Promise.resolve(writeVeiledDmLog(runtime, roomId, dmLogLaneId, message)).catch((error) => {
          logger.error('Veiled DM messageCreate log failed.', error);
        });
      }
      if (!isDmReaction && eventRoom !== roomId) return undefined;
      return Promise.resolve(handler(facade, ...args)).catch((error) => {
        logger.error('Veiled ' + eventName + ' handler failed.', error);
      });
    };
    runtime.on(eventName, listener);
    subscriptions.push([eventName, listener]);
  }
  const stop = async () => {
    for (const [eventName, listener] of subscriptions) runtime.off?.(eventName, listener);
    await runtime.disconnect?.();
  };
  try {
    await runtime.connect();
    if (env.VEILED_RUNTIME_REGISTER_COMMANDS === 'true') {
      if (!runtime.application?.commands?.set) throw new Error('The Veiled runtime has no application command manager.');
      const commands = [...discordClient.commands.values()].map((command) => command.data?.toJSON?.() ?? command.data).filter(Boolean);
      await runtime.application.commands.set(commands, roomId);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { enabled: true, apiClient, adapter, runtime, client: facade, stop };
}

module.exports = {
  SUPPORTED_RUNTIME_EVENTS,
  createVeiledCommandClient,
  defaultRuntimeFactory,
  enabled,
  eventRoomId,
  isParticipantDmMessage,
  loadSdkModules,
  parseRuntimeEvents,
  resolveVoiceSessionPath,
  startVeiledRuntime,
};

