const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const flags = Object.freeze({ BanMembers: 1, KickMembers: 2, ModerateMembers: 4, ManageChannels: 8 });
const discordStub = { PermissionsBitField: { Flags: flags } };

function loadCommand(name) {
  const filename = path.join(root, 'src', 'commands', 'moderation', name);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request === 'discord.js') return discordStub;
    throw new Error(`External dependency blocked by the command test sandbox: ${request}`);
  };
  const blockedNetwork = () => { throw new Error('Network access is disabled in the command test sandbox.'); };
  const wrapped = vm.runInNewContext(`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`, {
    fetch: blockedNetwork,
    XMLHttpRequest: blockedNetwork,
    WebSocket: blockedNetwork,
  }, { filename });
  wrapped(module.exports, localRequire, module, filename, path.dirname(filename));
  return module.exports;
}

function interactionFor(member, { reason = 'fixture reason', time = 5 } = {}) {
  return {
    guild: {
      name: 'Migration Fixture Room',
      members: { fetch: async () => member },
      roles: { cache: { find: (predicate) => predicate({ name: '@everyone' }) ? { name: '@everyone' } : null } },
    },
    user: { tag: 'fixture-operator#0001' },
    options: {
      getUser: () => ({ id: member.user.id }),
      getString: () => reason,
      getNumber: () => time,
      getChannel: () => null,
    },
    channel: { permissionOverwrites: { edit: async (_role, patch) => patch } },
  };
}

function commandClient({ allowed = true, log = [] } = {}) {
  return {
    checkPerms: async () => allowed,
    embed: async () => undefined,
    succNormal: async (payload) => { log.push({ type: 'success', payload }); },
    errNormal: async (payload) => { log.push({ type: 'error', payload }); },
  };
}

function memberFixture({ permissions = [], timeout = async () => ({}), ban = async () => ({}), kick = async () => ({}) } = {}) {
  return {
    user: { id: 'target-user', tag: 'target#0002' },
    permissions: { has: (flag) => permissions.includes(flag) },
    isCommunicationDisabled: () => false,
    timeout,
    ban,
    kick,
  };
}

test('sample ban command stops before side effects when the operator lacks permission', async () => {
  let banCalls = 0;
  const member = memberFixture({ ban: async () => { banCalls += 1; } });
  const client = commandClient({ allowed: false });
  await loadCommand('ban.js')(client, interactionFor(member), []);
  assert.equal(banCalls, 0);
});

test('sample ban command rejects a moderator target', async () => {
  let banCalls = 0;
  const member = memberFixture({ permissions: [flags.BanMembers], ban: async () => { banCalls += 1; } });
  const log = [];
  await loadCommand('ban.js')(commandClient({ log }), interactionFor(member), []);
  assert.equal(banCalls, 0);
  assert.equal(log[0]?.type, 'error');
});

test('sample ban command waits for the ban to complete before reporting success', async () => {
  const order = [];
  let finishBan;
  const pendingBan = new Promise((resolve) => { finishBan = resolve; });
  const member = memberFixture({ ban: () => { order.push('ban-started'); return pendingBan.then(() => order.push('ban-finished')); } });
  const client = commandClient({ log: order });
  const run = loadCommand('ban.js')(client, interactionFor(member), []);
  await new Promise((resolve) => setImmediate(resolve));
  const successIndex = order.findIndex((entry) => entry?.type === 'success');
  assert.ok(order.indexOf('ban-started') >= 0);
  assert.equal(successIndex, -1);
  assert.equal(order.includes('ban-finished'), false);
  finishBan();
  await run;
  assert.ok(order.includes('ban-finished'));
  assert.ok(order.findIndex((entry) => entry?.type === 'success') > order.indexOf('ban-finished'));
});

test('sample kick command waits for the kick to complete before reporting success', async () => {
  const order = [];
  let finishKick;
  const pendingKick = new Promise((resolve) => { finishKick = resolve; });
  const member = memberFixture({ kick: () => { order.push('kick-started'); return pendingKick.then(() => order.push('kick-finished')); } });
  const run = loadCommand('kick.js')(commandClient({ log: order }), interactionFor(member), []);
  await new Promise((resolve) => setImmediate(resolve));
  const successIndex = order.findIndex((entry) => entry?.type === 'success');
  assert.equal(successIndex, -1);
  assert.equal(order.includes('kick-finished'), false);
  finishKick();
  await run;
  assert.ok(order.includes('kick-finished'));
  assert.ok(order.findIndex((entry) => entry?.type === 'success') > order.indexOf('kick-finished'));
});

test('sample ban command reports failure and never success when the ban API rejects', async () => {
  const log = [];
  const member = memberFixture({ ban: async () => { throw new Error('fixture ban failure'); } });
  await loadCommand('ban.js')(commandClient({ log }), interactionFor(member), []);
  assert.equal(log.some((entry) => entry?.type === 'success'), false);
  assert.equal(log[0]?.type, 'error');
  assert.match(log[0]?.payload?.error, /fixture ban failure/);
});

test('sample kick command reports failure and never success when the kick API rejects', async () => {
  const log = [];
  const member = memberFixture({ kick: async () => { throw new Error('fixture kick failure'); } });
  await loadCommand('kick.js')(commandClient({ log }), interactionFor(member), []);
  assert.equal(log.some((entry) => entry?.type === 'success'), false);
  assert.equal(log[0]?.type, 'error');
  assert.match(log[0]?.payload?.error, /fixture kick failure/);
});

test('sample timeout command waits for completion and reports a rejected operation', async () => {
  const log = [];
  const member = memberFixture({ timeout: async () => { throw new Error('fixture rejection'); } });
  await loadCommand('timeout.js')(commandClient({ log }), interactionFor(member), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(log[0]?.type, 'error');
});

test('sample channel lock writes only the intended deny-send permission in the mock', async () => {
  let overwrite;
  const interaction = interactionFor(memberFixture());
  interaction.channel.permissionOverwrites.edit = async (_role, patch) => { overwrite = patch; };
  const log = [];
  await loadCommand('lock.js')(commandClient({ log }), interaction, []);
  assert.deepEqual({ ...overwrite }, { SendMessages: false });
  assert.equal(log[0]?.type, 'success');
});
