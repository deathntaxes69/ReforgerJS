const fs = require('fs');
const path = require('path');

class CommandHandler {
    constructor(config, serverInstances, discordClient) {
        this.config = config;
        this.serverInstances = serverInstances; // This is now an array
        this.discordClient = discordClient;
    }

    async initialize() {
        if (!this.config || !this.config.commands || !this.config.roleLevels || !this.config.roles) {
            throw new Error('CommandHandler configuration is missing required fields.');
        }

        logger.info('CommandHandler initialized successfully.');
    }

    async handleCommand(interaction, extraData = {}) {
        if (!interaction.isCommand()) return;
    
        const commandName = interaction.commandName;
        const commandConfig = this.config.commands.find(cmd => cmd.command === commandName);
    
        if (!commandConfig || !commandConfig.enabled) {
            logger.info(`Command '${commandName}' is disabled in this instance. Ignoring.`);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({
                    content: `This command (/ ${commandName}) is disabled in the bot's configuration.`,
                    ephemeral: true
                });
            }
            return;
        }
    
        const commandLevel = commandConfig.commandLevel;
    
        if (commandLevel !== 0) {
            const userRoles = interaction.member.roles.cache.map(role => role.id);
            const allowedRoles = this.getAllowedRolesForLevel(commandLevel);
    
            if (!this.userHasPermission(userRoles, allowedRoles)) {
                await interaction.reply({
                    content: 'You do not have permission to use this command.',
                    ephemeral: true
                });
                return;
            }
        }
    
        try {
            extraData.commandConfig = commandConfig;
            
            const commandFunction = require(`./commandFunctions/${commandName}`);
            // Pass the FULL ARRAY of server instances to the command
            await commandFunction(interaction, this.serverInstances, this.discordClient, extraData);
        } catch (error) {
            logger.error(`Error executing command '${commandName}': ${error.message}`);
            logger.error(error.stack);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: 'An error occurred while executing the command.',
                    ephemeral: true
                });
            } else if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({
                    content: 'An error occurred while executing the command.'
                });
            }
        }
    }

    getAllowedRolesForLevel(level) {
        const roleLevels = this.config.roleLevels;
        const allowedRoles = [];

        for (const [key, roles] of Object.entries(roleLevels)) {
            // Logic: lower number = higher privilege.
            // If command level is 3, users with level 1, 2, and 3 can use it.
            if (parseInt(key, 10) <= level) {
                roles.forEach(role => {
                    if (this.config.roles[role]) {
                        allowedRoles.push(this.config.roles[role]);
                    }
                });
            }
        }

        return allowedRoles;
    }

    userHasPermission(userRoles, allowedRoles) {
        return userRoles.some(role => allowedRoles.includes(role));
    }

    async cleanup() {
        logger.info('CommandHandler cleanup completed.');
    }
}

module.exports = CommandHandler;
