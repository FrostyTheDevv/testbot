'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');
const {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createDiscordVoiceCompat,
  createVeiledVoiceAdapterCreator,
  configureVeiledRuntime,
  entersState,
  isVeiledAdapter,
  markGuildForVeiledVoice,
} = require('../src/migration/discordVoiceCompat.cjs');

class FakeNativePlayer extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle' }; this.played = []; }
  play(resource) { this.played.push(resource); const old = this.state; this.state = { status: 'playing', resource }; this.emit('stateChange', old, this.state); }
  pause() { this.state = { status: 'paused' }; return true; }
  unpause() { this.state = { status: 'playing' }; return true; }
  stop() { this.state = { status: 'idle' }; return true; }
}

function nativeVoice() {
  const calls = { joins: [], resources: [], players: [] };
  const voice = {
    joinVoiceChannel: (options) => { calls.joins.push(options); return { native: true, options, subscribe: (player) => ({ nativePlayer: player }) }; },
    createAudioPlayer: (options) => { const player = new FakeNativePlayer(); player.options = options; calls.players.push(player); return player; },
    createAudioResource: (input, options) => { const resource = { native: true, input, options }; calls.resources.push(resource); return resource; },
  };
  return { voice, calls };
}

class FakeSession {
  constructor(options) {
    this.options = options;
    this.lane = options.lane;
    this.socket = { connected: true, emit: (event, payload, callback) => { this.emitted.push([event, payload]); callback({ success: true }); } };
    this.emitted = [];
    this.playCalls = [];
    this.packets = [];
    this.stageSpeakerGranted = false;
  }
  async join() { this.joined = true; }
  async leave() { this.left = true; }
  sendPacket(packet) { this.packets.push(packet); }
  play(input, callbacks) { this.playCalls.push({ input, callbacks }); callbacks.onStart?.(); }
  stopPlayback() { this.stopped = true; }
  pausePlayback() { this.paused = true; }
  resumePlayback() { this.resumed = true; }
}

function makeRuntime(laneType = 'VOICE') {
  const guild = { id: 'room-1', client: { user: { id: 'bot-1' } }, members: { cache: new Map(), me: null, fetch: async (id) => {
    const member = { id, voice: {} };
    guild.members.cache.set(id, member);
    Object.defineProperty(guild.members, 'me', { configurable: true, get: () => guild.members.cache.get('bot-1') || null });
    return member;
  } } };
  const lane = { id: 'lane-1', type: 2, veiled: { type: laneType }, guild };
  const runtime = { channels: { fetch: async () => lane }, guilds: { fetch: async () => guild } };
  return { runtime, guild, lane };
}

test('Discord voice calls keep the original native connection and resource path', () => {
  const { voice, calls } = nativeVoice();
  const compat = createDiscordVoiceCompat(voice);
  const channel = { id: 'discord-lane' };
  const connection = compat.joinVoiceChannel({ channelId: channel.id, guildId: 'discord-guild', adapterCreator() {} });
  const player = compat.createAudioPlayer({ behaviors: { noSubscriber: compat.NoSubscriberBehavior.Play } });
  const resource = compat.createAudioResource('https://radio.example/live.mp3', { inputType: StreamType.Arbitrary });
  player.play(resource);
  player.subscribe(connection);
  assert.equal(connection.native, true);
  assert.equal(calls.joins[0].channelId, channel.id);
  assert.equal(calls.players[0].played[0].native, true);
  assert.equal(calls.players[0].played[0].input, 'https://radio.example/live.mp3');
  assert.deepEqual(calls.players[0].options.behaviors, { noSubscriber: compat.NoSubscriberBehavior.Play });
});

test('only the tagged Veiled adapter routes through the Veiled SFU session', async () => {
  const { voice, calls } = nativeVoice();
  const compat = createDiscordVoiceCompat(voice);
  const { runtime, guild } = makeRuntime();
  const sessions = [];
  const adapterCreator = createVeiledVoiceAdapterCreator({
    runtime, roomId: 'room-1', token: 'veiled-test-token', api: 'https://api.test', gatewayUrl: 'https://ws.test', botUserId: 'bot-1',
    createSession: async (options) => { const session = new FakeSession(options); sessions.push(session); return session; },
  });
  guild.voiceAdapterCreator = adapterCreator;
  assert.equal(isVeiledAdapter(adapterCreator), true);
  const connection = compat.joinVoiceChannel({ channelId: 'lane-1', guildId: 'room-1', adapterCreator });
  const player = compat.createAudioPlayer();
  player.subscribe(connection);
  const resource = compat.createAudioResource('https://radio.example/live.mp3', { inputType: StreamType.Arbitrary });
  player.play(resource);
  await entersState(connection, VoiceConnectionStatus.Ready, 500);
  await entersState(player, AudioPlayerStatus.Playing, 500);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].playCalls[0].input, 'https://radio.example/live.mp3');
  assert.equal(calls.joins.length, 0);
  assert.equal(calls.players[0].played.length, 0);
  await connection.destroy();
  assert.equal(sessions[0].left, true);
  assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed);
});

test('Veiled stage join requests speaker access before publishing and setSuppressed is guarded', async () => {
  const { voice } = nativeVoice();
  const compat = createDiscordVoiceCompat(voice);
  const { runtime, guild } = makeRuntime('STAGE');
  let session;
  const adapterCreator = createVeiledVoiceAdapterCreator({
    runtime, roomId: 'room-1', token: 'token', api: 'https://api.test', gatewayUrl: 'https://ws.test', botUserId: 'bot-1',
    createSession: async (options) => (session = new FakeSession(options)),
  });
  guild.voiceAdapterCreator = adapterCreator;
  const connection = compat.joinVoiceChannel({ channelId: 'lane-1', guildId: 'room-1', adapterCreator });
  await entersState(connection, VoiceConnectionStatus.Ready, 500);
  assert.equal(session.lane.type, 'STAGE');
  await connection.setSuppressed(false);
  assert.equal(session.emitted[0][0], 'stage:promote-speaker');
  assert.equal(session.emitted[0][1].targetUserId, 'bot-1');
  await assert.rejects(() => connection.setSuppressed(1), /boolean/);
  await connection.destroy();
});

test('resource creation rejects unsupported values instead of fabricating playback', () => {
  const compat = createDiscordVoiceCompat(nativeVoice().voice);
  assert.throws(() => compat.createAudioResource({ url: 'https://radio.example/live.mp3' }), /URL or readable stream/);
  assert.equal(compat.createAudioResource(Readable.from([Buffer.from('audio')])).inputType, undefined);
});

test('Readable audio resources are transcoded to Opus RTP packets for the Veiled session', async () => {
  const { voice } = nativeVoice();
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on('finish', () => {
      setImmediate(() => {
        const header = Buffer.alloc(28);
        header.write('OggS', 0, 'latin1');
        header[26] = 1;
        header[27] = 3;
        child.stdout.write(Buffer.concat([header, Buffer.from([0x01, 0x02, 0x03])]));
        child.stdout.end();
        child.exitCode = 0;
        child.emit('close', 0);
      });
    });
    child.kill = () => { child.exitCode = 0; return true; };
    children.push(child);
    return child;
  };
  const compat = createDiscordVoiceCompat(voice, { spawnProcess, ffmpegPath: 'ffmpeg-test' });
  const { runtime, guild } = makeRuntime();
  let session;
  const adapterCreator = createVeiledVoiceAdapterCreator({
    runtime, roomId: 'room-1', token: 'token', api: 'https://api.test', gatewayUrl: 'https://ws.test', botUserId: 'bot-1',
    createSession: async (options) => (session = new FakeSession(options)),
  });
  guild.voiceAdapterCreator = adapterCreator;
  const connection = compat.joinVoiceChannel({ channelId: 'lane-1', guildId: 'room-1', adapterCreator });
  const player = compat.createAudioPlayer();
  player.subscribe(connection);
  const resource = compat.createAudioResource(Readable.from([Buffer.from('encoded source')]), { inputType: StreamType.Arbitrary });
  const idle = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Readable audio did not finish.')), 1000);
    player.on('stateChange', (oldState, newState) => {
      if (oldState.status !== AudioPlayerStatus.Idle && newState.status === AudioPlayerStatus.Idle) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  player.play(resource);
  await entersState(connection, VoiceConnectionStatus.Ready, 500);
  await idle;
  assert.equal(children.length, 1);
  assert.deepEqual(session.packets, [Buffer.from([0x01, 0x02, 0x03])]);
  await connection.destroy();
});

test('a Veiled connection cannot target another room and native connections stay unmarked', async () => {
  const compat = createDiscordVoiceCompat(nativeVoice().voice);
  const { runtime } = makeRuntime();
  const adapterCreator = createVeiledVoiceAdapterCreator({ runtime, roomId: 'room-1', token: 'token', api: 'api', gatewayUrl: 'ws', botUserId: 'bot-1', createSession: async () => new FakeSession({ lane: { type: 'VOICE' } }) });
  assert.throws(() => compat.joinVoiceChannel({ channelId: 'lane-1', guildId: 'other-room', adapterCreator }), /restricted to its configured room/);
  const nativeConnection = compat.joinVoiceChannel({ channelId: 'lane-1', guildId: 'room-1', adapterCreator: () => {} });
  assert.equal(nativeConnection.native, true);
});

test('guild decoration exposes a Veiled adapter and stage control only for the configured room', async () => {
  const { runtime, guild } = makeRuntime('STAGE');
  const config = { runtime, roomId: 'room-1', token: 'token', api: 'api', gatewayUrl: 'ws', botUserId: 'bot-1', createSession: async () => new FakeSession({ lane: { type: 'STAGE' } }) };
  await guild.members.fetch('bot-1');
  markGuildForVeiledVoice(guild, config);
  assert.equal(isVeiledAdapter(guild.voiceAdapterCreator), true);
  assert.equal(typeof guild.members.me.voice.setSuppressed, 'function');
  assert.throws(() => markGuildForVeiledVoice({ id: 'other-room' }, config), /configured Veiled room/);
});

test('voice setup does not require the runtime identity until a Veiled voice join', async () => {
  const guild = { id: 'room-1', members: { cache: new Map(), get me() { return null; }, fetch: async () => null } };
  const runtime = { user: null, guilds: { cache: new Map(), fetch: async () => guild } };
  const voiceSetup = await configureVeiledRuntime({
    runtime,
    roomId: 'room-1',
    token: 'token',
    api: 'api',
    gatewayUrl: 'ws',
    voiceSessionPath: require('node:path').resolve(__dirname, '../src/migration/does-not-load-until-join.mjs'),
  });
  assert.equal(voiceSetup.botUserId, undefined);
  await runtime.guilds.fetch('room-1');
  const adapter = guild.voiceAdapterCreator[require('../src/migration/discordVoiceCompat.cjs').VEILED_ADAPTER];
  assert.equal(adapter.getBotUserId(), undefined);
  runtime.user = { id: 'bot-1' };
  assert.equal(adapter.getBotUserId(), 'bot-1');
});
