const Discord = require('discord.js');

module.exports = async (client, interaction, args) => {
  const perms = await client.checkPerms({
    flags: [Discord.PermissionsBitField.Flags.KickMembers],
    perms: [Discord.PermissionsBitField.Flags.KickMembers]
  }, interaction)

  if (perms == false) return;

  const member = await interaction.guild.members.fetch(interaction.options.getUser('user').id);
  const reason = interaction.options.getString('reason') || 'Not given';

  if (member.permissions.has(Discord.PermissionsBitField.Flags.KickMembers)) return client.errNormal({
    error: "You can't kick a moderator",
    type: 'editreply'
  }, interaction);

  let notified = true;
  try {
    await client.embed({
      title: `🔨・Kick`,
      desc: `You've been kicked from **${interaction.guild.name}**`,
      fields: [
        { name: "👤┆Kicked by", value: interaction.user.tag, inline: true },
        { name: "💬┆Reason", value: reason, inline: true }
      ]
    }, member);
  } catch {
    notified = false;
  }

  try {
    await member.kick(reason);
  } catch (error) {
    return client.errNormal({
      error: error?.message || "The user could not be kicked.",
      type: 'editreply'
    }, interaction);
  }

  return client.succNormal({
    text: notified
      ? "The specified user has been successfully kicked and successfully received a notification!"
      : "The specified user has been successfully kicked, but could not be notified!",
    fields: [
      { name: "👤┆Kicked user", value: member.user.tag, inline: true },
      { name: "💬┆Reason", value: reason, inline: true }
    ],
    type: 'editreply'
  }, interaction);
}