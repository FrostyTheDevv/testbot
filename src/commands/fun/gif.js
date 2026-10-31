const Discord = require('discord.js');

module.exports = async (client, interaction, args) => {
    const msg = interaction.options.getString('text');

    if (!msg) return client.errUsage({ usage: "gif [text]", type: 'editreply' }, interaction);
    const giphy = process.env.GIPHY_TOKEN ? require('giphy-api')(process.env.GIPHY_TOKEN) : null;
    if (!giphy) return client.embed({ title: 'GIF search unavailable', desc: 'Set GIPHY_TOKEN in the bot environment to enable GIF search.', type: 'editreply' }, interaction);

    giphy.random(msg, function (err, res) {
        client.embed({
            title: `📺・${msg} Gif`,
            image: `https://media1.giphy.com/media/${res.data.id}/giphy.gif`,
            type: 'editreply'
        }, interaction);
    });
}

 