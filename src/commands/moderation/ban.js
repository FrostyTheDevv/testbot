const Discord = require('discord.js');

module.exports = async (client, interaction, args) => {
  const perms = await client.checkPerms({
    flags: [Discord.PermissionsBitField.Flags.BanMembers],
    perms: [Discord.PermissionsBitField.Flags.BanMembers]
  }, interaction)

  if (perms == false) return;

  const member = await interaction.guild.members.fetch(interaction.options.getUser('user').id);
  const reason = interaction.options.getString('reason') || 'Not given';

  if (member.permissions.has(Discord.PermissionsBitField.Flags.BanMembers)) return client.errNormal({
    error: "You can't ban a moderator",
    type: 'editreply'
  }, interaction);

  let notified = true;
  try {
    await client.embed({
      title: `🔨・Ban`,
      desc: `You've been banned in **${interaction.guild.name}**`,
      fields: [
        { name: "👤┆Banned by", value: interaction.user.tag, inline: true },
        { name: "💬┆Reason", value: reason, inline: true }
      ]
    }, member);
  } catch {
    notified = false;
  }

  try {
    await member.ban({ reason });
  } catch (error) {
    return client.errNormal({
      error: error?.message || "The user could not be banned.",
      type: 'editreply'
    }, interaction);
  }

  return client.succNormal({
    text: notified
      ? "The specified user has been successfully banned and successfully received a notification!"
      : "The specified user has been successfully banned, but could not be notified!",
    fields: [
      { name: "👤┆Banned user", value: member.user.tag, inline: true },
      { name: "💬┆Reason", value: reason, inline: true }
    ],
    type: 'editreply'
  }, interaction);
}