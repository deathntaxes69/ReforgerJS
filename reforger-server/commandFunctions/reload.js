// reforger-server/commandFunctions/reload.js
const fs = require('fs');
const path = require('path');
const { loadPlugins, mountPlugins } = require('../pluginLoader');
const deployCommands = require('../../deploy-commands');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    const reloadType = interaction.options.getString('type');
    const pluginName = interaction.options.getString('plugin_name');
    const serverId = interaction.options.getInteger('server'); // Get the new server option
    const user = interaction.user;
    
    logger.info(`[Reload Command] User: ${user.username} (ID: ${user.id}) requested reload of: ${reloadType} ${pluginName ? `(plugin: ${pluginName})` : ''} ${serverId ? `(server: ${serverId})` : ''}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }
// reforger-server/commandFunctions/reload.js
const fs = require('fs');
const path = require('path');
const { loadPlugins, mountPlugins } = require('../pluginLoader');
const deployCommands = require('../../deploy-commands');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    const reloadType = interaction.options.getString('type');
    const pluginName = interaction.options.getString('plugin_name');
    const serverId = interaction.options.getInteger('server'); // Get the new server option
    const user = interaction.user;
    
    logger.info(`[Reload Command] User: ${user.username} (ID: ${user.id}) requested reload of: ${reloadType} ${pluginName ? `(plugin: ${pluginName})` : ''} ${serverId ? `(server: ${serverId})` : ''}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const configPath = path.resolve(__dirname, '../../config.json');
        let newConfig;
        
        try {
            const rawData = fs.readFileSync(configPath, 'utf8');
            newConfig = JSON.parse(rawData);
        } catch (error) {
            await interaction.editReply(`❌ **Error loading config:** ${error.message}`);
            return;
        }

        let reloadResults = [];

        // --- REFACTORED for multi-server 'plugins' and 'all' ---
        if (reloadType === 'plugins' || reloadType === 'all') {
            reloadResults.push(await reloadAllPlugins(serverInstances, discordClient, newConfig));
        }

        // --- REFACTORED for multi-server 'plugin' ---
        if (reloadType === 'plugin') {
            if (!pluginName || !serverId) {
                await interaction.editReply('❌ **Error:** `plugin_name` and `server` ID are required when reloading a specific plugin.');
                return;
            }
            
            const targetInstance = serverInstances.find(s => s.config.server.id === serverId);
            if (!targetInstance) {
                await interaction.editReply(`❌ **Error:** Server with ID ${serverId} was not found.`);
                return;
            }
            
            reloadResults.push(await reloadSpecificPlugin(targetInstance, discordClient, newConfig, pluginName));
        }

        // --- 'commands' is global and remains the same ---
        if (reloadType === 'commands' || reloadType === 'all') {
            reloadResults.push(await reloadCommands(newConfig, discordClient));
        }

        // Update the config on ALL running server instances
        for (const instance of serverInstances) {
            const serverConfig = newConfig.servers.find(s => s.id === instance.config.server.id);
            if (serverConfig) {
                // This creates the new "scoped config" for each instance
                instance.config = {
                    ...newConfig,
                    server: serverConfig
                };
            }
        }

        const successCount = reloadResults.filter(r => r.success).length;
        const totalCount = reloadResults.length;
        
        let responseMessage = `✅ **Reload Complete** (${successCount}/${totalCount} operations successful)\n\n`;
        
        reloadResults.forEach(result => {
            const emoji = result.success ? '✅' : '❌';
            responseMessage += `${emoji} **${result.operation}:** ${result.message}\n`;
        });

        if (responseMessage.length > 2000) {
            responseMessage = responseMessage.substring(0, 1950) + '...\n*Response truncated*';
        }

        await interaction.editReply(responseMessage);

    } catch (error) {
        logger.error(`[Reload Command] Error: ${error.message}`);
        await interaction.editReply(`❌ **Unexpected error:** ${error.message}`);
    }
};

/**
 * Reloads all plugins on ALL server instances.
 */
async function reloadAllPlugins(serverInstances, discordClient, newConfig) {
    try {
        logger.info('[Reload Command] Starting full plugin reload for ALL servers...');
        
        // 1. Cleanup all existing plugins on all instances
        let cleanupCount = 0;
        if (global.currentPlugins && Array.isArray(global.currentPlugins)) {
            for (const pluginInstance of global.currentPlugins) {
                if (typeof pluginInstance.cleanup === 'function') {
                    try {
                        await pluginInstance.cleanup();
                        cleanupCount++;
                    } catch (error) {
                        logger.error(`[Reload Command] Error cleaning up plugin '${pluginInstance.name || 'Unnamed Plugin'}': ${error.message}`);
                    }
                }
            }
            logger.info(`[Reload Command] Cleaned up ${cleanupCount} plugins`);
        }
        global.currentPlugins = []; // Reset global list
        
        // 2. Clear server-specific plugin lists
        for (const instance of serverInstances) {
            instance.plugins = [];
        }

        // 3. Clear the require cache
        clearPluginCache();

        // 4. Re-load and mount plugins for EACH server
        let totalLoaded = 0;
        
        for (const instance of serverInstances) {
            const serverId = instance.config.server.id;
            // Create the scoped config for this instance
            const serverConfig = newConfig.servers.find(s => s.id === serverId);
            if (!serverConfig) {
                logger.warn(`[Reload Command] Server ${serverId} not found in new config. Skipping reload for it.`);
                continue;
            }
            const scopedConfig = {
                ...newConfig,
                server: serverConfig
            };

            const newPlugins = await loadPlugins(scopedConfig);
            logger.info(`[Reload Command] [Server ${serverId}] Loaded ${newPlugins.length} plugins`);
            
            await mountPlugins(newPlugins, instance, discordClient);
            logger.info(`[Reload Command] [Server ${serverId}] Mounted ${newPlugins.length} plugins`);

            instance.plugins = newPlugins; // Assign to instance
            global.currentPlugins.push(...newPlugins); // Add to global list
            totalLoaded += newPlugins.length;
        }

        return {
            success: true,
            operation: 'All Plugins Reload',
            message: `Successfully reloaded ${totalLoaded} plugins across ${serverInstances.length} servers`
        };

    } catch (error) {
        logger.error(`[Reload Command] Plugin reload failed: ${error.message}`);
        return {
            success: false,
            operation: 'All Plugins Reload',
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Reloads one specific plugin on one specific server instance.
 */
async function reloadSpecificPlugin(targetInstance, discordClient, newConfig, pluginName) {
    const serverId = targetInstance.config.server.id;
    try {
        logger.info(`[Reload Command] Starting reload of plugin: ${pluginName} on Server ${serverId}`);

        // 1. Find and cleanup the old plugin on the target instance
        if (targetInstance.plugins && Array.isArray(targetInstance.plugins)) {
            // Find by constructor name, which is the file name (e.g., "DBLog")
            const pluginIndex = targetInstance.plugins.findIndex(p => 
                p.constructor.name === pluginName
            );

            if (pluginIndex !== -1) {
                const oldPlugin = targetInstance.plugins[pluginIndex];
                if (typeof oldPlugin.cleanup === 'function') {
                    await oldPlugin.cleanup();
                    logger.info(`[Reload Command] [Server ${serverId}] Cleaned up plugin: ${oldPlugin.name}`);
                }
                // Remove from instance list
                targetInstance.plugins.splice(pluginIndex, 1);
                
                // Also remove from global list
                const globalPluginIndex = global.currentPlugins.findIndex(p => p === oldPlugin);
                if (globalPluginIndex !== -1) {
                    global.currentPlugins.splice(globalPluginIndex, 1);
                }
            } else {
                logger.warn(`[Reload Command] [Server ${serverId}] Plugin ${pluginName} not found in running instance list. Will attempt to load it as a new plugin.`);
            }
        }

        // 2. Clear the require cache for this plugin
        const pluginPath = path.join(__dirname, '../plugins', `${pluginName}.js`);
        if (require.cache[require.resolve(pluginPath)]) {
            delete require.cache[require.resolve(pluginPath)];
            logger.verbose(`[Reload Command] Cleared cache for: ${pluginPath}`);
        } else {
            logger.warn(`[Reload Command] Plugin path not found in cache, it might be new: ${pluginPath}`);
        }

        // 3. Find the plugin's config in the new main config
        const pluginConfig = newConfig.plugins.find(plugin => plugin.plugin === pluginName);
        if (!pluginConfig) {
            return {
                success: false,
                operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                message: `Plugin not found in configuration`
            };
        }

        if (!pluginConfig.enabled) {
            return {
                success: true,
                operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                message: `Plugin is disabled in configuration - skipped`
            };
        }

        // 4. Load, mount, and add the new plugin instance
        if (fs.existsSync(pluginPath)) {
            try {
                // Get the scoped config for THIS server
                const serverConfig = newConfig.servers.find(s => s.id === serverId);
                const scopedConfig = {
                    ...newConfig,
                    server: serverConfig
                };

                const PluginClass = require(pluginPath);
                const pluginInstance = new PluginClass(scopedConfig); // Use scoped config
                
                if (typeof pluginInstance.prepareToMount === 'function') {
                    await pluginInstance.prepareToMount(targetInstance, discordClient);
                }

                if (!targetInstance.plugins) targetInstance.plugins = [];
                targetInstance.plugins.push(pluginInstance); // Add to instance list
                
                if (!global.currentPlugins) global.currentPlugins = [];
                global.currentPlugins.push(pluginInstance); // Add to global list

                logger.info(`[Reload Command] [Server ${serverId}] Successfully reloaded plugin: ${pluginName}`);
                return {
                    success: true,
                    operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                    message: `Successfully reloaded`
                };

            } catch (error) {
                logger.error(`[Reload Command] [Server ${serverId}] Error loading plugin ${pluginName}: ${error.message}`);
                return {
                    success: false,
                    operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                    message: `Load error: ${error.message}`
                };
            }
        } else {
            return {
                success: false,
                operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                message: `Plugin file not found: ${pluginPath}`
            };
        }

    } catch (error) {
        logger.error(`[Reload Command] [Server ${serverId}] Specific plugin reload failed: ${error.message}`);
        return {
            success: false,
            operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Reloads all Discord commands. This is a global operation.
 */
async function reloadCommands(newConfig, discordClient) {
    try {
        logger.info('[Reload Command] Starting command reload...');
        
        const success = await deployCommands(newConfig, logger, discordClient);
        
        if (success) {
            return {
                success: true,
                operation: 'Commands Reload',
                message: 'Successfully reloaded Discord commands'
            };
        } else {
            return {
                success: false,
                operation: 'Commands Reload',
                message: 'Failed to deploy commands'
            };
        }

    } catch (error) {
        logger.error(`[Reload Command] Command reload failed: ${error.message}`);
        return {
            success: false,
            operation: 'Commands Reload',
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Clears the require() cache for all files in the plugins directory.
 */
function clearPluginCache() {
    const pluginsDir = path.join(__dirname, '../plugins');
    
    if (fs.existsSync(pluginsDir)) {
        const pluginFiles = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
        
        pluginFiles.forEach(file => {
            const pluginPath = path.join(pluginsDir, file);
            if (require.cache[require.resolve(pluginPath)]) {
                delete require.cache[require.resolve(pluginPath)];
                logger.verbose(`[Reload Command] Cleared cache for: ${pluginPath}`);
            }
        });
        
        logger.info(`[Reload Command] Cleared require cache for ${pluginFiles.length} plugin files`);
    }
}
    try {
        const configPath = path.resolve(__dirname, '../../config.json');
        let newConfig;
        
        try {
            const rawData = fs.readFileSync(configPath, 'utf8');
            newConfig = JSON.parse(rawData);
        } catch (error) {
            await interaction.editReply(`❌ **Error loading config:** ${error.message}`);
            return;
        }

        let reloadResults = [];

        // --- REFACTORED for multi-server 'plugins' and 'all' ---
        if (reloadType === 'plugins' || reloadType === 'all') {
            reloadResults.push(await reloadAllPlugins(serverInstances, discordClient, newConfig));
        }

        // --- REFACTORED for multi-server 'plugin' ---
        if (reloadType === 'plugin') {
            if (!pluginName || !serverId) {
                await interaction.editReply('❌ **Error:** `plugin_name` and `server` ID are required when reloading a specific plugin.');
                return;
            }
            
            const targetInstance = serverInstances.find(s => s.config.server.id === serverId);
            if (!targetInstance) {
                await interaction.editReply(`❌ **Error:** Server with ID ${serverId} was not found.`);
                return;
            }
            
            reloadResults.push(await reloadSpecificPlugin(targetInstance, discordClient, newConfig, pluginName));
        }

        // --- 'commands' is global and remains the same ---
        if (reloadType === 'commands' || reloadType === 'all') {
            reloadResults.push(await reloadCommands(newConfig, discordClient));
        }

        // Update the config on ALL running server instances
        for (const instance of serverInstances) {
            const serverConfig = newConfig.servers.find(s => s.id === instance.config.server.id);
            if (serverConfig) {
                instance.config = {
                    ...newConfig,
                    server: serverConfig
                };
            }
        }

        const successCount = reloadResults.filter(r => r.success).length;
        const totalCount = reloadResults.length;
        
        let responseMessage = `✅ **Reload Complete** (${successCount}/${totalCount} operations successful)\n\n`;
        
        reloadResults.forEach(result => {
            const emoji = result.success ? '✅' : '❌';
            responseMessage += `${emoji} **${result.operation}:** ${result.message}\n`;
        });

        if (responseMessage.length > 2000) {
            responseMessage = responseMessage.substring(0, 1950) + '...\n*Response truncated*';
        }

        await interaction.editReply(responseMessage);

    } catch (error) {
        logger.error(`[Reload Command] Error: ${error.message}`);
        await interaction.editReply(`❌ **Unexpected error:** ${error.message}`);
    }
};

/**
 * Reloads all plugins on ALL server instances.
 */
async function reloadAllPlugins(serverInstances, discordClient, newConfig) {
    try {
        logger.info('[Reload Command] Starting full plugin reload for ALL servers...');
        
        // 1. Cleanup all existing plugins on all instances
        let cleanupCount = 0;
        if (global.currentPlugins && Array.isArray(global.currentPlugins)) {
            for (const pluginInstance of global.currentPlugins) {
                if (typeof pluginInstance.cleanup === 'function') {
                    try {
                        await pluginInstance.cleanup();
                        cleanupCount++;
                    } catch (error) {
                        logger.error(`[Reload Command] Error cleaning up plugin '${pluginInstance.name || 'Unnamed Plugin'}': ${error.message}`);
                    }
                }
            }
            logger.info(`[Reload Command] Cleaned up ${cleanupCount} plugins`);
        }
        global.currentPlugins = []; // Reset global list
        
        // 2. Clear server-specific plugin lists
        for (const instance of serverInstances) {
            instance.plugins = [];
        }

        // 3. Clear the require cache
        clearPluginCache();

        // 4. Re-load and mount plugins for EACH server
        let totalLoaded = 0;
        
        for (const instance of serverInstances) {
            const serverId = instance.config.server.id;
            // Create the scoped config for this instance
            const serverConfig = newConfig.servers.find(s => s.id === serverId);
            if (!serverConfig) {
                logger.warn(`[Reload Command] Server ${serverId} not found in new config. Skipping reload for it.`);
                continue;
            }
            const scopedConfig = {
                ...newConfig,
                server: serverConfig
            };

            const newPlugins = await loadPlugins(scopedConfig);
            logger.info(`[Reload Command] [Server ${serverId}] Loaded ${newPlugins.length} plugins`);
            
            await mountPlugins(newPlugins, instance, discordClient);
            logger.info(`[Reload Command] [Server ${serverId}] Mounted ${newPlugins.length} plugins`);

            instance.plugins = newPlugins; // Assign to instance
            global.currentPlugins.push(...newPlugins); // Add to global list
            totalLoaded += newPlugins.length;
        }

        return {
            success: true,
            operation: 'All Plugins Reload',
            message: `Successfully reloaded ${totalLoaded} plugins across ${serverInstances.length} servers`
        };

    } catch (error) {
        logger.error(`[Reload Command] Plugin reload failed: ${error.message}`);
        return {
            success: false,
            operation: 'All Plugins Reload',
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Reloads one specific plugin on one specific server instance.
 */
async function reloadSpecificPlugin(targetInstance, discordClient, newConfig, pluginName) {
    const serverId = targetInstance.config.server.id;
    try {
        logger.info(`[Reload Command] Starting reload of plugin: ${pluginName} on Server ${serverId}`);

        // 1. Find and cleanup the old plugin on the target instance
        if (targetInstance.plugins && Array.isArray(targetInstance.plugins)) {
            // Find by constructor name, which is the file name (e.g., "DBLog")
            const pluginIndex = targetInstance.plugins.findIndex(p => 
                p.constructor.name === pluginName
            );

            if (pluginIndex !== -1) {
                const oldPlugin = targetInstance.plugins[pluginIndex];
                if (typeof oldPlugin.cleanup === 'function') {
                    await oldPlugin.cleanup();
                    logger.info(`[Reload Command] [Server ${serverId}] Cleaned up plugin: ${oldPlugin.name}`);
                }
                // Remove from instance list
                targetInstance.plugins.splice(pluginIndex, 1);
                
                // Also remove from global list
                const globalPluginIndex = global.currentPlugins.findIndex(p => p === oldPlugin);
                if (globalPluginIndex !== -1) {
                    global.currentPlugins.splice(globalPluginIndex, 1);
                }
            } else {
                logger.warn(`[Reload Command] [Server ${serverId}] Plugin ${pluginName} not found in running instance list. Will attempt to load it as a new plugin.`);
            }
        }

        // 2. Clear the require cache for this plugin
        const pluginPath = path.join(__dirname, '../plugins', `${pluginName}.js`);
        if (require.cache[require.resolve(pluginPath)]) {
            delete require.cache[require.resolve(pluginPath)];
            logger.verbose(`[Reload Command] Cleared cache for: ${pluginPath}`);
        } else {
            logger.warn(`[Reload Command] Plugin path not found in cache, it might be new: ${pluginPath}`);
        }

        // 3. Find the plugin's config in the new main config
        const pluginConfig = newConfig.plugins.find(plugin => plugin.plugin === pluginName);
        if (!pluginConfig) {
            return {
                success: false,
                operation: `Plugin Reload (${pluginName})`,
                message: `Plugin not found in configuration`
            };
        }

        if (!pluginConfig.enabled) {
            return {
                success: true,
                operation: `Plugin Reload (${pluginName})`,
                message: `Plugin is disabled in configuration - skipped`
            };
        }

        // 4. Load, mount, and add the new plugin instance
        if (fs.existsSync(pluginPath)) {
            try {
                // Get the scoped config for THIS server
                const serverConfig = newConfig.servers.find(s => s.id === serverId);
                const scopedConfig = {
                    ...newConfig,
                    server: serverConfig
                };

                const PluginClass = require(pluginPath);
                const pluginInstance = new PluginClass(scopedConfig); // Use scoped config
                
                if (typeof pluginInstance.prepareToMount === 'function') {
                    await pluginInstance.prepareToMount(targetInstance, discordClient);
                }

                if (!targetInstance.plugins) targetInstance.plugins = [];
                targetInstance.plugins.push(pluginInstance); // Add to instance list
                
                if (!global.currentPlugins) global.currentPlugins = [];
                global.currentPlugins.push(pluginInstance); // Add to global list

                logger.info(`[Reload Command] [Server ${serverId}] Successfully reloaded plugin: ${pluginName}`);
                return {
                    success: true,
                    operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                    message: `Successfully reloaded`
                };

            } catch (error) {
                logger.error(`[Reload Command] [Server ${serverId}] Error loading plugin ${pluginName}: ${error.message}`);
                return {
                    success: false,
                    operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                    message: `Load error: ${error.message}`
                };
            }
        } else {
            return {
                success: false,
                operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
                message: `Plugin file not found: ${pluginPath}`
            };
        }

    } catch (error) {
        logger.error(`[Reload Command] [Server ${serverId}] Specific plugin reload failed: ${error.message}`);
        return {
            success: false,
            operation: `Plugin Reload (${pluginName} on Srv ${serverId})`,
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Reloads all Discord commands. This is a global operation.
 */
async function reloadCommands(newConfig, discordClient) {
    try {
        logger.info('[Reload Command] Starting command reload...');
        
        const success = await deployCommands(newConfig, logger, discordClient);
        
        if (success) {
            return {
                success: true,
                operation: 'Commands Reload',
                message: 'Successfully reloaded Discord commands'
            };
        } else {
            return {
                success: false,
                operation: 'Commands Reload',
                message: 'Failed to deploy commands'
            };
        }

    } catch (error) {
        logger.error(`[Reload Command] Command reload failed: ${error.message}`);
        return {
            success: false,
            operation: 'Commands Reload',
            message: `Failed: ${error.message}`
        };
    }
}

/**
 * Clears the require() cache for all files in the plugins directory.
 */
function clearPluginCache() {
    const pluginsDir = path.join(__dirname, '../plugins');
    
    if (fs.existsSync(pluginsDir)) {
        const pluginFiles = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
        
        pluginFiles.forEach(file => {
            const pluginPath = path.join(pluginsDir, file);
            if (require.cache[require.resolve(pluginPath)]) {
                delete require.cache[require.resolve(pluginPath)];
                logger.verbose(`[Reload Command] Cleared cache for: ${pluginPath}`);
            }
        });
        
        logger.info(`[Reload Command] Cleared require cache for ${pluginFiles.length} plugin files`);
    }
}
