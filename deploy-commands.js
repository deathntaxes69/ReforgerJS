const { REST } = require('@discordjs/rest');
const { Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord-api-types/v10');

// Helper to inject server choices recursively (handles subcommands)
function injectServerChoices(options, serverChoices) {
    if (!options) return;
    for (const option of options) {
        // If this option is named 'server' and is an Integer type
        if (option.name === 'server' && option.type === ApplicationCommandOptionType.Integer) {
            option.choices = serverChoices;
        }
        // Recursively check sub-options (for subcommands like /rcon restart)
        if (option.options) {
            injectServerChoices(option.options, serverChoices);
        }
    }
}

async function deployCommands(config, logger, discordClient = null) {
    if (!config || !logger) {
        console.error('Missing required parameters: config and logger');
        return false;
    }

    try {
        const discordConfig = config.connectors.discord;
        if (!discordConfig?.token || !discordConfig?.clientId || !discordConfig?.guildId) {
            logger.error('Discord configuration missing.');
            return false;
        }

        // Build the list of server choices from config
        // Discord limits choices to 25 max.
        const serverChoices = config.servers.slice(0, 25).map(s => ({
            name: `${s.name} (ID: ${s.id})`.substring(0, 100), // Discord name limit
            value: s.id
        }));

        const rest = new REST({ version: '10' }).setToken(discordConfig.token);
        const commandsPath = path.resolve(process.cwd(), './reforger-server/commands');
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        const commands = [];

        for (const file of commandFiles) {
            const command = require(path.join(commandsPath, file));
            const commandConfig = config.commands.find(cmd => cmd.command === command.data.name);
            
            if (commandConfig && commandConfig.enabled) {
                // Convert to JSON first so we can modify the structure directly
                const commandData = command.data.toJSON();
                
                // Inject our dynamic server list
                if (serverChoices.length > 0) {
                    injectServerChoices(commandData.options, serverChoices);
                }

                commands.push(commandData);
                logger.info(`Command '/${command.data.name}' loaded with ${serverChoices.length} server choices.`);
            }
        }

        if (commands.length > 0) {
            logger.info('Deploying commands to Discord...');
            await rest.put(
                Routes.applicationGuildCommands(discordConfig.clientId, discordConfig.guildId),
                { body: commands }
            );
            logger.info(`Successfully registered ${commands.length} slash commands.`);
            return true;
        } else {
            logger.warn('No commands enabled to deploy.');
            return false;
        }
        
    } catch (error) {
        logger.error(`Error deploying commands: ${error.message}`);
        return false;
    }
}

// Allow running directly
if (require.main === module) {
    // Mock logger for standalone run
    const logger = { 
        info: console.log, 
        error: console.error, 
        warn: console.warn, 
        verbose: () => {} 
    };
    
    (async () => {
        try {
            const configPath = path.resolve(__dirname, './config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            await deployCommands(config, logger);
        } catch (error) {
            console.error('Standalone deployment failed:', error);
        }
    })();
} else {
    module.exports = deployCommands;
}
