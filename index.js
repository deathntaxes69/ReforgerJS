const fs = require('fs');
const path = require('path');
const express = require('express');
const { printLogo } = require('./reforger-server/utils/logo');
const { loadConfig, validateConfig, performGlobalStartupChecks, performServerStartupChecks } = require('./reforger-server/factory');
const { loadPlugins, mountPlugins } = require('./reforger-server/pluginLoader');
const logger = require('./reforger-server/logger/logger');
const deployCommands = require('./deploy-commands');
const { checkVersion } = require('./reforger-server/utils/versionChecker');

async function main() {
    try {
        printLogo();

        // 1) Load config
        const configPath = path.resolve(__dirname, './config.json');
        const config = loadConfig(configPath); // This now has config.servers[]

        // 2) Validate config
        if (!validateConfig(config)) { // This now validates the new structure
            logger.error('Invalid configuration. Please check your config.json.');
            process.exit(1);
        }

        // 3) Perform GLOBAL startup checks (Discord, DB) ONCE
        const discordClient = await performGlobalStartupChecks(config);
        
        const githubOwner = config.github?.owner || 'ZSU-GG-Reforger';
        const githubRepo = config.github?.repo || 'ReforgerJS';
        
        await checkVersion(githubOwner, githubRepo, logger);

        // 3.5) Reload Discord commands ONCE
        // Note: this config key is now ambiguous, but we respect it.
        const reloadCommandsSetting = config.servers[0]?.reloadCommandsOnStartup;
        if (reloadCommandsSetting === true) {
            logger.info('Reloading Discord commands on startup (reloadCommandsOnStartup=true)...');
            const success = await deployCommands(config, logger, discordClient);
            if (success) {
                logger.info('Discord commands successfully reloaded.');
            } else {
                logger.warn('Failed to reload Discord commands. Bot will continue with existing commands.');
            }
        } else {
            logger.verbose('Skipping command reload on startup.');
        }

        // 4) === MAIN MULTI-SERVER LOOP ===
        
        const serverInstances = []; // This will hold all our server instances
        global.serverInstances = serverInstances; // Make globally accessible
        
        const ReforgerServer = require('./reforger-server/main');
        const CommandHandler = require('./reforger-server/commandHandler');
        
        // This array will hold all loaded plugins from all servers for shutdown
        let allLoadedPlugins = [];

        for (const serverConfig of config.servers) {
            logger.info(`Initializing server: ${serverConfig.name} (ID: ${serverConfig.id})`);

            // Create a "scoped config" that mimics the OLD config structure.
            // This is the trick that allows us to re-use Rcon, LogParser, and Plugins
            // without having to refactor them all.
            const scopedConfig = {
                ...config,       // Copy all global keys (connectors, plugins, etc.)
                server: serverConfig // Set the 'server' key to this specific server's config
            };

            try {
                // 5) Perform PER-SERVER startup checks (e.g., log dir)
                await performServerStartupChecks(scopedConfig);

                // 6) Create and initialize a ReforgerServer for THIS server
                const serverInstance = new ReforgerServer(scopedConfig);
                await serverInstance.initialize();
                logger.info(`ReforgerServer initialized for ${serverConfig.name}`);

                // 7) Load plugins for THIS server instance
                const loadedPlugins = await loadPlugins(scopedConfig);
                allLoadedPlugins = allLoadedPlugins.concat(loadedPlugins); // Add to global list for shutdown

                // 8) Mount plugins with THIS server instance and the ONE Discord client
                await mountPlugins(loadedPlugins, serverInstance, discordClient);
                
                // Store this instance's plugins on the instance itself for targeted reloads
                serverInstance.plugins = loadedPlugins; 

                // 9) Start this server's RCON polling
                serverInstance.startSendingPlayersCommand(30000);
                
                // 10) Add the new instance to our list
                serverInstances.push(serverInstance);

            } catch (serverError) {
                logger.error(`Failed to initialize server ${serverConfig.name} (ID: ${serverConfig.id}): ${serverError.message}`);
                logger.error("This server will be skipped.");
            }
        }
        
        // This global is problematic for reloads, but we'll set it.
        // The reload command will need to manage this global list.
        global.currentPlugins = allLoadedPlugins; 

        if (serverInstances.length === 0) {
            logger.error("No servers were successfully initialized. Exiting.");
            process.exit(1);
        }

        // 11) Load and initialize ONE CommandHandler
        // Pass the FULL ARRAY of instances to the handler
        const commandHandler = new CommandHandler(config, serverInstances, discordClient);
        await commandHandler.initialize();

        // 12) Add ONE interaction listener for all commands
        discordClient.on('interactionCreate', async (interaction) => {
            try {
                if (interaction.isCommand()) {
                    const commandName = interaction.commandName;
                    const extraData = {};
                    
                    if (interaction.options && interaction.options._hoistedOptions) {
                        interaction.options._hoistedOptions.forEach(option => {
                            extraData[option.name] = option.value;
                        });
                    }
                    
                    // The commandHandler will now figure out which server to talk to
                    await commandHandler.handleCommand(interaction, extraData);
                }
            } catch (error) {
                logger.error(`Error handling interaction: ${error.message}`);
            }
        });
        
        logger.info(`Successfully initialized and running ${serverInstances.length} server(s)!`);

        // Graceful shutdown handling
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT. Shutting down gracefully...');
            
            // Cleanup all loaded plugins
            for (const pluginInstance of global.currentPlugins || []) {
                if (typeof pluginInstance.cleanup === 'function') {
                    try {
                        await pluginInstance.cleanup();
                        logger.info(`Plugin '${pluginInstance.name || 'Unnamed Plugin'}' cleaned up successfully.`);
                    } catch (error) {
                        logger.error(`Error during cleanup of plugin '${pluginInstance.name || 'Unnamed Plugin'}': ${error.message}`);
                    }
                }
            }
            
            // Cleanup commandHandler
            if (typeof commandHandler?.cleanup === 'function') {
                await commandHandler.cleanup();
            }

            // Cleanup all server instances
            for (const serverInstance of global.serverInstances || []) {
                logger.info(`Cleaning up server: ${serverInstance.config.server.name}`);
                if (typeof serverInstance.cleanup === 'function') {
                    await serverInstance.cleanup();
                }
            }
            
            if (discordClient) {
                await discordClient.destroy();
            }
            
            logger.info('Shutdown complete. Exiting.');
            process.exit(0);
        });

    } catch (error) {
        logger.error(`A critical error occurred: ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    }
}

main();
