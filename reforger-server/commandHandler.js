// reforger-server/commandHandler.js
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
            // Reply to the user so the command doesn't time out
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
            logger.error(error.stack); // Log the stack for more detail
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
            // Ensure level is treated as a number
            const numericLevel = parseInt(key, 10);
            
            // User's level must be less than or equal to the command's level.
            // (e.g., Level 1 user can use Level 1, 2, 3 commands)
            // Or is it the other way? (Level 1 is highest perm)
            // The README says: "Level 1 has full access... Level 3 can only access level 3 or lower"
            // This implies a lower number is a HIGHER privilege.
            // So, a user's level (e.g., 1) must be <= the command's level (e.g., 3).
            
            // Let's re-read the roles: "Level 1 has full access... Level 3 can only access level 3 or lower commands"
            // This is confusingly worded. Let's assume lower number = higher privilege.
            // A level 1 user should be able to run a level 3 command.
            // A level 3 user should NOT be able to run a level 1 command.
            // Therefore, the check should be: if (user's_permission_level <= command_required_level)
            // We need to find the user's BEST level.
            
            // Let's re-implement this check based on how it's used.
            // The commandHandler checks if a user's roles are in the list for that level or HIGHER.
            // Example: Command needs level 3.
            // We check roles for level 1, 2, and 3.
            
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
