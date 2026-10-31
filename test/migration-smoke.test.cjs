'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMigrationSmoke } = require('../src/migration/migrationSmoke.cjs');

const config = {
  discordToken: 'discord-fixture',
  veiledToken: 'veiled-fixture',
  discordGuildId: 'guild-123',
  discordChannelId: 'discord-channel',
  veiledRoomId: 'room-12345678',
  veiledLaneId: 'lane-12345678',
};

function response(value, status = 200) {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixtureFetch({ discordGuildId = 'guild-123', veiledLaneRoomId = 'room-12345678', veiledRoomInstalled = true, failVeiledPost = false } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers, body: init.body });
    if (url.hostname === 'discord.com' && url.pathname === '/api/v10/users/@me') return response({ id: 'discord-bot', username: 'FixtureDiscord' });
    if (url.hostname === 'discord.com' && url.pathname === '/api/v10/channels/discord-channel' && method === 'GET') return response({ id: 'discord-channel', guild_id: discordGuildId });
    if (url.hostname === 'api.veiled.lol' && url.pathname === '/api/v1/bots/@me') return response({ user: { id: 'veiled-bot', username: 'FixtureVeiled' } });
    if (url.hostname === 'api.veiled.lol' && url.pathname === '/api/v1/bots/@me/rooms') return response({ rooms: veiledRoomInstalled ? [{ id: 'room-12345678', name: 'Test room' }] : [] });
    if (url.hostname === 'api.veiled.lol' && url.pathname === '/api/v1/rooms/room-12345678/lanes') return response({ lanes: [{ id: 'lane-12345678', roomId: veiledLaneRoomId }] });
    if (url.hostname === 'discord.com' && url.pathname === '/api/v10/channels/discord-channel/messages' && method === 'POST') return response({ id: 'discord-message' });
    if (url.hostname === 'api.veiled.lol' && url.pathname === '/api/v1/lanes/lane-12345678/messages' && method === 'POST') {
      if (failVeiledPost) return response({ error: 'simulated Veiled failure' }, 500);
      return response({ message: { id: 'veiled-message' } });
    }
    if (url.hostname === 'discord.com' && url.pathname === '/api/v10/channels/discord-channel/messages/discord-message' && method === 'DELETE') return response(null, 204);
    if (url.hostname === 'api.veiled.lol' && url.pathname === '/api/v1/messages/veiled-message' && method === 'DELETE') return response(null, 204);
    throw new Error('Unexpected request in test fixture: ' + method + ' ' + url.pathname);
  };
  return { calls, fetchImpl };
}

test('read-only mode verifies both identities and exact test target ownership without sending', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const result = await runMigrationSmoke({ ...config, fetchImpl });
  assert.equal(result.passed, true);
  assert.equal(result.mode, 'read-only');
  assert.equal(result.discord.botId, 'discord-bot');
  assert.equal(result.veiled.botId, 'veiled-bot');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('send-and-delete mode writes one harmless test message per provider and removes both', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const result = await runMigrationSmoke({ ...config, sendAndDelete: true, fetchImpl });
  assert.equal(result.mode, 'send-and-delete');
  assert.equal(result.cleanedUp, true);
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.slice(-2).map((call) => [call.method, call.url.pathname]), [
    ['DELETE', '/api/v10/channels/discord-channel/messages/discord-message'],
    ['DELETE', '/api/v1/messages/veiled-message'],
  ]);
  const discordBody = JSON.parse(calls[5].body);
  assert.deepEqual(discordBody.allowed_mentions, { parse: [] });
});

test('refuses a Discord channel outside the configured test guild before any writes', async () => {
  const { calls, fetchImpl } = fixtureFetch({ discordGuildId: 'another-guild' });
  await assert.rejects(runMigrationSmoke({ ...config, sendAndDelete: true, fetchImpl }), /does not belong to the configured test server/);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('refuses a Veiled lane outside the configured test room before any writes', async () => {
  const { calls, fetchImpl } = fixtureFetch({ veiledLaneRoomId: 'another-room' });
  await assert.rejects(runMigrationSmoke({ ...config, sendAndDelete: true, fetchImpl }), /Veiled lane is not available in the configured test room/);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('refuses a Veiled room where the bot is not installed before any writes', async () => {
  const { calls, fetchImpl } = fixtureFetch({ veiledRoomInstalled: false });
  await assert.rejects(runMigrationSmoke({ ...config, sendAndDelete: true, fetchImpl }), /bot is not installed in the configured test room/);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('cleans the Discord test message if the Veiled write fails', async () => {
  const { calls, fetchImpl } = fixtureFetch({ failVeiledPost: true });
  await assert.rejects(runMigrationSmoke({ ...config, sendAndDelete: true, fetchImpl }), /failed \(500\)/);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.hostname === 'discord.com'));
});


