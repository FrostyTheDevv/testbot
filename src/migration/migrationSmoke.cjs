'use strict';

const { randomUUID } = require('node:crypto');

function unwrap(value, key) {
  return value && typeof value === 'object' && value[key] && typeof value[key] === 'object' ? value[key] : value;
}

function tokenValue(value) {
  return String(value || '').replace(/^Bot\s+/i, '').trim();
}

async function apiRequest(fetchImpl, base, token, path, { method = 'GET', body } = {}) {
  const url = new URL(path, base);
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: 'Bot ' + tokenValue(token),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(method + ' ' + url.pathname + ' failed (' + response.status + ').');
  return data;
}

async function runMigrationSmoke({
  discordToken,
  veiledToken,
  discordGuildId,
  discordChannelId,
  veiledRoomId,
  veiledLaneId,
  sendAndDelete = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const required = { discordToken, veiledToken, discordGuildId, discordChannelId, veiledRoomId, veiledLaneId };
  const missing = Object.keys(required).filter((key) => !required[key]);
  if (missing.length) throw new TypeError('Migration smoke configuration is missing: ' + missing.join(', '));
  const discordBase = 'https://discord.com/api/v10/';
  const veiledBase = 'https://api.veiled.lol/api/v1/';
  let discordMessageId = null;
  let veiledMessageId = null;
  let primaryError = null;
  const target = 'veiled-discord-migration-' + randomUUID();

  try {
    const [discordIdentity, discordChannel, veiledIdentityRaw, veiledRoomsRaw, veiledLanesRaw] = await Promise.all([
      apiRequest(fetchImpl, discordBase, discordToken, 'users/@me'),
      apiRequest(fetchImpl, discordBase, discordToken, 'channels/' + encodeURIComponent(discordChannelId)),
      apiRequest(fetchImpl, veiledBase, veiledToken, 'bots/@me'),
      apiRequest(fetchImpl, veiledBase, veiledToken, 'bots/@me/rooms'),
      apiRequest(fetchImpl, veiledBase, veiledToken, 'rooms/' + encodeURIComponent(veiledRoomId) + '/lanes'),
    ]);
    const veiledIdentity = unwrap(veiledIdentityRaw, 'user');
    const veiledRooms = unwrap(veiledRoomsRaw, 'rooms');
    const veiledLanes = unwrap(veiledLanesRaw, 'lanes');
    const veiledRoom = Array.isArray(veiledRooms) ? veiledRooms.find((room) => String(room.id) === String(veiledRoomId)) : null;
    const veiledLane = Array.isArray(veiledLanes) ? veiledLanes.find((lane) => String(lane.id) === String(veiledLaneId)) : null;
    const laneRoomId = veiledLane && (veiledLane.roomId || (veiledLane.Room && veiledLane.Room.id) || (veiledLane.room && veiledLane.room.id));
    if (String(discordChannel && discordChannel.guild_id) !== String(discordGuildId)) throw new Error('The Discord channel does not belong to the configured test server.');
    if (!veiledRoom) throw new Error('The Veiled bot is not installed in the configured test room.');
    if (!veiledLane || (laneRoomId !== undefined && String(laneRoomId) !== String(veiledRoomId))) throw new Error('The Veiled lane is not available in the configured test room.');

    if (sendAndDelete) {
      const discordMessage = await apiRequest(fetchImpl, discordBase, discordToken, 'channels/' + encodeURIComponent(discordChannelId) + '/messages', {
        method: 'POST',
        body: { content: target, allowed_mentions: { parse: [] } },
      });
      discordMessageId = discordMessage && discordMessage.id || null;
      if (!discordMessageId) throw new Error('Discord accepted the test message but returned no message ID.');

      const veiledMessageRaw = await apiRequest(fetchImpl, veiledBase, veiledToken, 'lanes/' + encodeURIComponent(veiledLaneId) + '/messages', {
        method: 'POST',
        body: { content: target },
      });
      const veiledMessage = unwrap(veiledMessageRaw, 'message');
      veiledMessageId = veiledMessage && veiledMessage.id || null;
      if (!veiledMessageId) throw new Error('Veiled accepted the test message but returned no message ID.');
    }

    return {
      passed: true,
      mode: sendAndDelete ? 'send-and-delete' : 'read-only',
      discord: { botId: String(discordIdentity.id), username: discordIdentity.username, guildId: String(discordChannel.guild_id), channelId: String(discordChannel.id) },
      veiled: { botId: String(veiledIdentity && veiledIdentity.id), username: veiledIdentity && veiledIdentity.username, roomId: String(veiledRoom.id), laneId: String(veiledLane.id) },
      messageCreated: sendAndDelete,
      cleanedUp: sendAndDelete,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanup = [];
    if (discordMessageId) cleanup.push(apiRequest(fetchImpl, discordBase, discordToken, 'channels/' + encodeURIComponent(discordChannelId) + '/messages/' + encodeURIComponent(discordMessageId), { method: 'DELETE' }));
    if (veiledMessageId) cleanup.push(apiRequest(fetchImpl, veiledBase, veiledToken, 'messages/' + encodeURIComponent(veiledMessageId), { method: 'DELETE' }));
    const cleanupResults = await Promise.allSettled(cleanup);
    const failed = cleanupResults.filter((result) => result.status === 'rejected');
    if (failed.length) {
      const cleanupError = new Error('One or more migration smoke messages could not be deleted; check the configured test channels.');
      if (!primaryError) throw cleanupError;
      primaryError.cleanupError = cleanupError.message;
    }
  }
}

module.exports = { runMigrationSmoke };
