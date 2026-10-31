'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const VEILED_ADAPTER = Symbol.for('veiled.discordjs.voice.adapter');
const RESOURCE = Symbol.for('veiled.discordjs.voice.resource');
const activeConnections = new Map();

const AudioPlayerStatus = Object.freeze({ Idle: 'idle', Buffering: 'buffering', Playing: 'playing', Paused: 'paused', AutoPaused: 'autopaused' });
const VoiceConnectionStatus = Object.freeze({ Signalling: 'signalling', Connecting: 'connecting', Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' });
const VoiceConnectionDisconnectReason = Object.freeze({ WebSocketClose: 'websocket-close', AdapterUnavailable: 'adapter-unavailable', Manual: 'manual' });
const NoSubscriberBehavior = Object.freeze({ Pause: 'pause', Play: 'play', Stop: 'stop' });
const StreamType = Object.freeze({ Arbitrary: 'arbitrary', Raw: 'raw', OggOpus: 'ogg/opus', WebmOpus: 'webm/opus' });

function createVeiledVoiceAdapterCreator({ runtime, roomId, token, api, gatewayUrl, botUserId, getBotUserId, createSession }) {
  if (!runtime || typeof roomId !== 'string' || !roomId || typeof token !== 'string' || !token || typeof createSession !== 'function') {
    throw new TypeError('Veiled voice adapter requires the scoped runtime, room, token, and session factory.');
  }
  const creator = function veiledVoiceAdapterCreator() {
    throw new Error('The Veiled voice adapter is consumed by the Veiled @discordjs/voice compatibility layer.');
  };
  Object.defineProperty(creator, VEILED_ADAPTER, { value: Object.freeze({ runtime, roomId, token, api, gatewayUrl, botUserId, getBotUserId, createSession }) });
  return creator;
}

function markGuildForVeiledVoice(guild, adapterOptions) {
  if (!guild || typeof guild.id !== 'string' || guild.id !== adapterOptions.roomId) {
    throw new Error('Voice can only be enabled for the configured Veiled room.');
  }
  if (!guild.voiceAdapterCreator) {
    Object.defineProperty(guild, 'voiceAdapterCreator', {
      configurable: true,
      enumerable: false,
      value: createVeiledVoiceAdapterCreator({ ...adapterOptions, runtime: adapterOptions.runtime || guild.client }),
    });
  }
  const me = guild.members?.me;
  if (me?.voice && typeof me.voice.setSuppressed !== 'function') {
    Object.defineProperty(me.voice, 'setSuppressed', {
      configurable: true,
      value: async (suppressed) => {
        const connections = activeConnections.get(guild.id) || new Set();
        const connection = [...connections].reverse().find((item) => item.session?.lane?.type === 'STAGE' && !item.destroyed);
        if (!connection) throw new Error('The Veiled bot is not connected to a stage lane in this room.');
        return connection.setSuppressed(suppressed);
      },
    });
  }
  return guild;
}

async function configureVeiledRuntime({ runtime, roomId, token, api, gatewayUrl, voiceSessionPath, logger = console }) {
  if (!runtime?.guilds || typeof runtime.guilds.fetch !== 'function') throw new TypeError('Veiled runtime guild manager is required.');
  if (typeof voiceSessionPath !== 'string' || !voiceSessionPath) throw new Error('VEILED voice session source path is required.');
  const sessionPath = pathToFileURL(voiceSessionPath).href;
  let sessionClassPromise;
  const createSession = async (options) => {
    if (!sessionClassPromise) {
      sessionClassPromise = import(sessionPath).then(({ VoiceSession }) => {
        if (typeof VoiceSession !== 'function') throw new TypeError('VoiceSession export was not found in the configured source module.');
        return class StageAwareVoiceSession extends VoiceSession {
          async publishAudio() {
            if (this.lane.type === 'STAGE') {
              const response = await this.emitWithAck('stage:promote-speaker', { laneId: this.lane.id, targetUserId: this.botUserId });
              if (response?.success !== true) throw new Error(response?.error || 'Bot must have stage moderation permission to speak in this stage lane.');
              this.stageSpeakerGranted = true;
            }
            return super.publishAudio();
          }
        };
      });
    }
    const Session = await sessionClassPromise;
    return new Session(options);
  };
  const adapterOptions = { runtime, roomId, token, api, gatewayUrl, getBotUserId: () => runtime.user?.id, createSession };
  const originalFetch = runtime.guilds.fetch.bind(runtime.guilds);
  runtime.guilds.fetch = async (...args) => {
    const guild = await originalFetch(...args);
    if (guild?.id === roomId) markGuildForVeiledVoice(guild, adapterOptions);
    return guild;
  };
  const cache = runtime.guilds.cache;
  if (cache && typeof cache.set === 'function' && !cache.__veiledVoiceSetWrapped) {
    const originalSet = cache.set.bind(cache);
    cache.set = (id, guild) => {
      if (id === roomId && guild?.id === roomId) markGuildForVeiledVoice(guild, adapterOptions);
      return originalSet(id, guild);
    };
    Object.defineProperty(cache, '__veiledVoiceSetWrapped', { value: true });
  }
  return {
    roomId,
    get botUserId() { return runtime.user?.id; },
    createSession,
    async hydrateBotMember() {
      const currentBotUserId = runtime.user?.id;
      if (!currentBotUserId) return false;
      const guild = await runtime.guilds.fetch(roomId);
      if (guild.members?.me == null && typeof guild.members?.fetch === 'function') await guild.members.fetch(currentBotUserId);
      markGuildForVeiledVoice(guild, adapterOptions);
      return true;
    },
  };
}

function isVeiledAdapter(adapterCreator) {
  return typeof adapterCreator === 'function' && Boolean(adapterCreator[VEILED_ADAPTER]);
}

function createDiscordVoiceCompat(nativeVoice, { logger = console, spawnProcess = spawn, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
  if (!nativeVoice || typeof nativeVoice.joinVoiceChannel !== 'function' || typeof nativeVoice.createAudioPlayer !== 'function') {
    throw new TypeError('The native @discordjs/voice module is required.');
  }

  function createAudioResource(input, options = {}) {
    if (!(typeof input === 'string' || input instanceof Readable || (input && typeof input.pipe === 'function'))) {
      throw new TypeError('Audio resource input must be a URL or readable stream.');
    }
    return { [RESOURCE]: true, input, options, metadata: options.metadata, playbackDuration: 0 };
  }

  function createAudioPlayer(options = {}) {
    return new CompatAudioPlayer(nativeVoice, options, logger, { spawnProcess, ffmpegPath });
  }

  function joinVoiceChannel(options) {
    if (!isVeiledAdapter(options?.adapterCreator)) return nativeVoice.joinVoiceChannel(options);
    return new VeiledVoiceConnection(options, options.adapterCreator[VEILED_ADAPTER], logger);
  }

  return {
    ...nativeVoice,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    VoiceConnectionDisconnectReason,
    NoSubscriberBehavior,
    StreamType,
    createAudioResource,
    createAudioPlayer,
    joinVoiceChannel,
    entersState,
    isVeiledAdapter,
  };
}

class VeiledVoiceConnection extends EventEmitter {
  constructor(options, adapter, logger) {
    super();
    if (options.guildId !== adapter.roomId) throw new Error('Veiled voice connection is restricted to its configured room.');
    if (typeof options.channelId !== 'string' || !options.channelId) throw new TypeError('A Veiled voice channel ID is required.');
    this.options = options;
    this.adapter = adapter;
    this.logger = logger;
    this.channelId = options.channelId;
    this.joinConfig = { ...options };
    this.state = { status: VoiceConnectionStatus.Signalling, reason: null, closeCode: null };
    this.rejoinAttempts = 0;
    this.destroyed = false;
    this.session = null;
    this.player = null;
    let connections = activeConnections.get(adapter.roomId);
    if (!connections) activeConnections.set(adapter.roomId, connections = new Set());
    connections.add(this);
    this.ready = this.startSession().catch((error) => {
      if (!this.destroyed) this.setState(VoiceConnectionStatus.Disconnected, VoiceConnectionDisconnectReason.AdapterUnavailable, error.message);
      this._readyError = error;
      return this;
    });
  }

  async startSession() {
    if (this.destroyed) throw new Error('Cannot start a destroyed voice connection.');
    this.setState(VoiceConnectionStatus.Connecting);
    const botUserId = this.adapter.getBotUserId?.() ?? this.adapter.botUserId;
    if (typeof botUserId !== 'string' || !botUserId) throw new Error('Veiled bot identity is not ready for a voice connection.');
    this.botUserId = botUserId;
    const guild = await this.adapter.runtime.guilds.fetch(this.adapter.roomId);
    if (guild.members?.me == null && typeof guild.members?.fetch === 'function') await guild.members.fetch(botUserId);
    markGuildForVeiledVoice(guild, this.adapter);
    const lane = await this.adapter.runtime.channels.fetch(this.channelId);
    if (!lane || lane.guild?.id !== this.adapter.roomId || !['VOICE', 'STAGE', 2, 13].includes(lane.veiled?.type ?? lane.type)) {
      throw new Error('Veiled voice channel is not a voice or stage lane in the configured room.');
    }
    const normalizedType = String(lane.veiled?.type ?? lane.type).toUpperCase();
    const session = await this.adapter.createSession({
      api: this.adapter.api,
      gatewayUrl: this.adapter.gatewayUrl,
      token: this.adapter.token,
      botUserId: this.botUserId,
      lane: { id: lane.id, roomId: this.adapter.roomId, type: normalizedType },
    });
    if (!session || typeof session.join !== 'function' || typeof session.leave !== 'function' || typeof session.sendPacket !== 'function') {
      throw new TypeError('Veiled voice session factory returned an invalid session.');
    }
    this.session = session;
    session.onGatewayDisconnect = (reason) => {
      if (!this.destroyed) this.setState(VoiceConnectionStatus.Disconnected, VoiceConnectionDisconnectReason.WebSocketClose, reason);
    };
    session.onClose = () => {
      if (!this.destroyed && this.state.status !== VoiceConnectionStatus.Disconnected) {
        this.setState(VoiceConnectionStatus.Disconnected, VoiceConnectionDisconnectReason.WebSocketClose);
      }
    };
    await session.join();
    if (this.destroyed) { await session.leave(); throw new Error('Voice connection was destroyed while joining.'); }
    this.setState(VoiceConnectionStatus.Ready);
    this.player?.connectionReady(this);
    return this;
  }

  setState(status, reason = null, detail = null) {
    const oldState = this.state;
    this.state = { status, reason, closeCode: detail };
    this.emit('stateChange', oldState, this.state);
    this.emit(status, this.state);
  }

  subscribe(player) {
    if (!player || typeof player.attachConnection !== 'function') throw new TypeError('Veiled voice connection requires a compatible audio player.');
    this.player = player;
    player.attachConnection(this);
    return { connection: this, player, unsubscribe: () => { if (this.player === player) { this.player = null; player.detachConnection(this); } } };
  }

  async rejoin(options = {}) {
    if (this.destroyed) return false;
    this.joinConfig = { ...this.joinConfig, ...options };
    this.rejoinAttempts += 1;
    const previous = this.session;
    this.session = null;
    await previous?.leave().catch((error) => this.logger.warn?.('Old Veiled voice session cleanup failed during rejoin.', error));
    this.ready = this.startSession();
    return true;
  }

  async setSuppressed(suppressed) {
    if (this.state.status !== VoiceConnectionStatus.Ready || !this.session?.socket) await this.ready;
    if (this.session.lane.type !== 'STAGE') throw new Error('Speaker suppression is available only in Veiled stage lanes.');
    if (typeof suppressed !== 'boolean') throw new TypeError('suppressed must be a boolean.');
    if (!suppressed && this.session.stageSpeakerGranted === true) return true;
    const event = suppressed ? 'stage:demote-speaker' : 'stage:promote-speaker';
    const response = await emitWithAck(this.session, event, { laneId: this.channelId, targetUserId: this.botUserId });
    if (response?.success !== true) throw new Error(response?.error || 'Veiled stage speaker update failed.');
    return true;
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.player?.detachConnection(this);
    const session = this.session;
    this.session = null;
    await session?.leave();
    this.setState(VoiceConnectionStatus.Destroyed, VoiceConnectionDisconnectReason.Manual);
    activeConnections.get(this.adapter.roomId)?.delete(this);
    this.removeAllListeners();
  }

  disconnect() { return this.destroy(); }
}

class CompatAudioPlayer extends EventEmitter {
  constructor(nativeVoice, options, logger, { spawnProcess = spawn, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
    super();
    this.nativeVoice = nativeVoice;
    this.options = options;
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.ffmpegPath = ffmpegPath;
    this.native = nativeVoice.createAudioPlayer(options);
    this.mode = null;
    this.connection = null;
    this.resource = null;
    this.state = this.native.state || { status: AudioPlayerStatus.Idle, resource: null };
    this.subscription = null;
    this.streamProcess = null;
    this.streamTimer = null;
    this.streamQueue = [];
    this.forwardNativeState = (oldState, newState) => {
      if (this.mode === 'veiled') return;
      this.state = newState;
      this.emit('stateChange', oldState, newState);
      this.emit(newState.status, newState);
    };
    this.native.on('stateChange', this.forwardNativeState);
    this.native.on('error', (error) => this.emit('error', error));
  }

  play(resource) {
    if (!resource?.[RESOURCE]) throw new TypeError('Audio resource must be created by the compatibility layer.');
    this.resource = resource;
    if (this.mode === 'native') this.native.play(this.nativeResource(resource));
    else if (this.mode === 'veiled') this.startVeiledResource(resource);
    else this.setState(AudioPlayerStatus.Buffering, resource);
    return this;
  }

  nativeResource(resource) {
    return this.nativeVoice.createAudioResource(resource.input, resource.options);
  }

  subscribe(connection) {
    if (connection instanceof VeiledVoiceConnection) {
      this.mode = 'veiled';
      return connection.subscribe(this);
    }
    this.mode = 'native';
    this.subscription = connection.subscribe(this.native);
    if (this.resource) this.native.play(this.nativeResource(this.resource));
    this.state = this.native.state;
    return this.subscription;
  }

  attachConnection(connection) {
    if (this.mode === 'native') throw new Error('A native Discord audio player cannot be attached to a Veiled voice connection.');
    this.mode = 'veiled';
    this.connection = connection;
    if (this.resource && connection.state.status === VoiceConnectionStatus.Ready) this.startVeiledResource(this.resource);
  }

  detachConnection(connection) {
    if (this.connection !== connection) return;
    this.connection = null;
    if (!this.resource) this.setState(AudioPlayerStatus.Idle, null);
  }

  connectionReady(connection) {
    if (this.connection !== connection || !this.resource) return;
    this.startVeiledResource(this.resource);
  }

  startVeiledResource(resource) {
    const connection = this.connection;
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready || !connection.session) return;
    this.stopStreamProcess();
    this.setState(AudioPlayerStatus.Buffering, resource);
    if (typeof resource.input === 'string') {
      connection.session.play(resource.input, {
        onStart: () => { if (this.resource === resource) this.setState(AudioPlayerStatus.Playing, resource); },
        onEnd: () => { if (this.resource === resource) this.finishResource(resource); },
        onError: (error) => { if (this.resource === resource) this.failResource(resource, error); },
      });
      return;
    }
    this.startReadable(resource, connection);
  }

  startReadable(resource, connection) {
    if (typeof resource.input.pipe !== 'function') return this.failResource(resource, new TypeError('Readable audio stream is invalid.'));
    const child = this.spawnProcess(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-map_metadata', '-1',
      '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-frame_duration', '20',
      '-application', 'audio', '-f', 'ogg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.streamProcess = child;
    this.streamQueue = [];
    let buffer = Buffer.alloc(0);
    let packetParts = [];
    let stderr = '';
    const emitPacket = (packet) => {
      if (packet.length && !['OpusHead', 'OpusTags'].includes(packet.toString('latin1', 0, 8))) this.streamQueue.push(packet);
    };
    const finishPacket = () => { emitPacket(Buffer.concat(packetParts)); packetParts = []; };
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 27) {
        if (buffer.toString('latin1', 0, 4) !== 'OggS') {
          const next = buffer.indexOf('OggS', 1, 'latin1');
          buffer = next < 0 ? Buffer.alloc(0) : buffer.subarray(next);
          if (buffer.length < 27) break;
        }
        const count = buffer[26];
        const headerLength = 27 + count;
        if (buffer.length < headerLength) break;
        const laces = buffer.subarray(27, headerLength);
        const bodyLength = laces.reduce((sum, size) => sum + size, 0);
        if (buffer.length < headerLength + bodyLength) break;
        let offset = headerLength;
        for (const length of laces) {
          packetParts.push(buffer.subarray(offset, offset + length));
          offset += length;
          if (length < 255) finishPacket();
        }
        buffer = buffer.subarray(headerLength + bodyLength);
      }
      if (this.streamQueue.length > 250) child.stdout.pause();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => this.failResource(resource, new Error('ffmpeg failed to start: ' + error.message)));
    child.on('close', (code) => {
      if (this.resource !== resource) return;
      if (code !== 0 && code !== null) return this.failResource(resource, new Error(stderr.trim() || 'ffmpeg could not decode this audio stream.'));
      this.streamEnded = true;
      if (!this.streamQueue.length) this.finishResource(resource);
    });
    resource.input.on('error', (error) => this.failResource(resource, error));
    resource.input.pipe(child.stdin);
    child.stdin.on('error', () => {});
    this.streamEnded = false;
    this.setState(AudioPlayerStatus.Buffering, resource);
    this.sendStreamPacket(resource, connection);
  }

  sendStreamPacket(resource, connection) {
    if (this.resource !== resource || this.state.status === AudioPlayerStatus.Paused || !this.streamProcess) return;
    const packet = this.streamQueue.shift();
    if (packet && this.connection?.session && this.connection.state.status === VoiceConnectionStatus.Ready) {
      this.connection.session.sendPacket(packet);
      if (this.state.status === AudioPlayerStatus.Buffering) this.setState(AudioPlayerStatus.Playing, resource);
    }
    if (this.streamQueue.length < 100) this.streamProcess.stdout.resume();
    if (!packet && this.streamEnded) return this.finishResource(resource);
    this.streamTimer = setTimeout(() => this.sendStreamPacket(resource, this.connection || connection), 20);
  }

  pause() {
    if (this.mode === 'native') return this.native.pause();
    if (!this.resource || this.state.status !== AudioPlayerStatus.Playing) return false;
    if (typeof this.resource.input === 'string') this.connection?.session?.pausePlayback();
    else { clearTimeout(this.streamTimer); this.streamProcess?.stdout.pause(); }
    this.setState(AudioPlayerStatus.Paused, this.resource);
    return true;
  }

  unpause() {
    if (this.mode === 'native') return this.native.unpause();
    if (!this.resource || this.state.status !== AudioPlayerStatus.Paused) return false;
    if (typeof this.resource.input === 'string') this.connection?.session?.resumePlayback();
    else { this.streamProcess?.stdout.resume(); this.sendStreamPacket(this.resource, this.connection); }
    this.setState(AudioPlayerStatus.Playing, this.resource);
    return true;
  }

  stop(force = false) {
    const resource = this.resource;
    if (!resource) return false;
    if (this.mode === 'native') return this.native.stop(force);
    if (typeof resource.input === 'string') this.connection?.session?.stopPlayback();
    this.stopStreamProcess();
    this.resource = null;
    this.setState(AudioPlayerStatus.Idle, null);
    return true;
  }

  setState(status, resource) {
    const oldState = this.state;
    this.state = { status, ...(resource ? { resource } : {}) };
    this.emit('stateChange', oldState, this.state);
    this.emit(status, this.state);
  }

  finishResource(resource) {
    if (this.resource !== resource) return;
    this.stopStreamProcess();
    this.resource = null;
    this.setState(AudioPlayerStatus.Idle, null);
  }

  failResource(resource, error) {
    if (this.resource !== resource) return;
    this.stopStreamProcess();
    this.resource = null;
    this.setState(AudioPlayerStatus.Idle, null);
    this.emit('error', error);
  }

  stopStreamProcess() {
    clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.streamQueue = [];
    if (this.streamProcess) {
      const process = this.streamProcess;
      this.streamProcess = null;
      process.stdin?.destroy();
      if (process.exitCode === null) process.kill('SIGKILL');
    }
  }

  get stateStatus() { return this.state.status; }
}

function emitWithAck(session, event, payload) {
  return new Promise((resolve, reject) => {
    if (!session.socket?.connected) return reject(new Error('Veiled voice signaling is not connected.'));
    const timer = setTimeout(() => reject(new Error(`${event} timed out.`)), 8000);
    session.socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(response.error));
      else resolve(response || {});
    });
  });
}

function entersState(target, status, timeoutMs) {
  if (!target || typeof target.on !== 'function') return Promise.reject(new TypeError('State target must be an event emitter.'));
  if (target.state?.status === status) return Promise.resolve(target);
  if (target._readyError && target.state?.status !== status) return Promise.reject(target._readyError);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for state ${status}.`)), timeoutMs);
    const listener = (_old, next) => { if (next?.status === status || target.state?.status === status) done(null); };
    const errorListener = (error) => done(error);
    function done(error) {
      clearTimeout(timer);
      target.off('stateChange', listener);
      target.off('error', errorListener);
      if (error) reject(error); else resolve(target);
    }
    target.on('stateChange', listener);
    target.once('error', errorListener);
  });
}

function installRequireHook({ Module = require('node:module'), getOptions = () => ({}) } = {}) {
  if (Module.__veiledDiscordVoiceHook) return Module.__veiledDiscordVoiceHook;
  const originalLoad = Module._load;
  const cache = new WeakMap();
  Module._load = function veiledVoiceLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== '@discordjs/voice' || !loaded || typeof loaded !== 'object') return loaded;
    let facade = cache.get(loaded);
    if (!facade) { facade = createDiscordVoiceCompat(loaded, getOptions()); cache.set(loaded, facade); }
    return facade;
  };
  const remove = () => {
    if (Module._load === wrappedLoad) Module._load = originalLoad;
    delete Module.__veiledDiscordVoiceHook;
  };
  const wrappedLoad = Module._load;
  Module.__veiledDiscordVoiceHook = { remove, originalLoad };
  return Module.__veiledDiscordVoiceHook;
}

module.exports = {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  RESOURCE,
  StreamType,
  VEILED_ADAPTER,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  CompatAudioPlayer,
  VeiledVoiceConnection,
  createDiscordVoiceCompat,
  configureVeiledRuntime,
  createVeiledVoiceAdapterCreator,
  entersState,
  installRequireHook,
  isVeiledAdapter,
  markGuildForVeiledVoice,
};
