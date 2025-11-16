// reforger-server/commands/reload.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Reload plugins or commands without restarting the bot')
        .addStringOption(option =>
            option
                .setName('type')
                .setDescription('What to reload')
                .setRequired(true)
                .addChoices(
                    { name: 'All Plugins (All Servers)', value: 'plugins' },
                    { name: 'Specific Plugin (One Server)', value: 'plugin' },
                    { name: 'Discord Commands', value: 'commands' },
                    { name: 'Everything (All Servers)', value: 'all' }
                )
        )
        .addIntegerOption(option =>
            option
                .setName('server')
                .setDescription('Server ID (Required if reloading a "Specific Plugin")')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('plugin_name')
                .setDescription('Name of specific plugin to reload (e.g., "DBLog")')
                .setRequired(false)
        )
};
