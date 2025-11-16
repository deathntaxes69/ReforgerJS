// reforger-server/commandFunctions/whois.js
const mysql = require("mysql2/promise");
const { EmbedBuilder } = require('discord.js');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const user = interaction.user;
        const identifier = interaction.options.getString('identifier');
        const value = interaction.options.getString('value');
        const serverIdOption = interaction.options.getInteger('server');
        
        logger.info(`[Whois Command] User: ${user.username} (ID: ${user.id}) used /whois with Identifier: ${identifier}, Value: ${value}, Server: ${serverIdOption || 'ALL'}`);

        // Check if MySQL is enabled in the main config
        const mainConfig = serverInstances[0]?.config;
        if (!mainConfig || !mainConfig.connectors ||
            !mainConfig.connectors.mysql ||
            !mainConfig.connectors.mysql.enabled) {
            await interaction.editReply('MySQL is not enabled in the configuration. This command cannot be used.');
            return;
        }

        const pool = process.mysqlPool; // Use the global pool
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const fieldMap = {
            beguid: 'beGUID',
            uuid: 'playerUID',
            name: 'playerName',
            ip: 'playerIP',
            steamid: 'steamID'
        };

        const dbField = fieldMap[identifier.toLowerCase()];

        if (!dbField) {
            await interaction.editReply(`Invalid identifier provided: ${identifier}.`);
            return;
        }

        if (identifier.toLowerCase() === 'steamid') {
            if (!/^\d{17}$/.test(value)) {
                await interaction.editReply('Invalid SteamID format. SteamID should be 17 digits long.');
                return;
            }
        }

        try {
            let query;
            let params;
            
            // Build server filter
            const serverFilter = serverIdOption ? `AND server_id = ?` : '';
            const serverParam = serverIdOption ? [serverIdOption.toString()] : [];

            if (dbField === 'playerName') {
                query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device, server_id FROM players WHERE ${dbField} LIKE ? ${serverFilter}`;
                params = [`%${value}%`, ...serverParam];
            } else {
                query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device, server_id FROM players WHERE ${dbField} = ? ${serverFilter}`;
                params = [value, ...serverParam];
            }

            const [rows] = await pool.query(query, params);

            if (rows.length === 0) {
                await interaction.editReply(`No information can be found for ${identifier}: ${value}${serverIdOption ? ` on server ${serverIdOption}` : ''}`);
                return;
            }

            if (dbField === 'playerName' && rows.length > 1) {
                const displayCount = Math.min(rows.length, 10);
                let responseMessage = `Found ${rows.length} players matching "${value}". `;
                
                if (rows.length > 10) {
                    responseMessage += `Showing first 10 results. Please refine your search for more specific results.\n\n`;
                } else {
                    responseMessage += `Full details for each match:\n\n`;
                }
                
                for (let i = 0; i < displayCount; i++) {
                    const player = rows[i];
                    let playerDetails = `${i+1}. ${player.playerName || 'Unknown'}\n` +
                                       `   Server ID: ${player.server_id || 'Unknown'}\n` +
                                       `   UUID: ${player.playerUID || 'Missing'}\n` +
                                       `   IP: ${player.playerIP || 'Missing'}\n` +
                                       `   beGUID: ${player.beGUID || 'Missing'}\n` +
                                       `   Device: ${player.device || 'Not Found'}\n`;
                    
                    if (player.device === 'PC') {
                        playerDetails += `   SteamID: ${player.steamID || 'Not Found'}\n`;
                    }
                    
                    responseMessage += playerDetails + '\n';
                }
                
                // Check if the response is too long for a single Discord reply
                if (responseMessage.length > 2000) {
                    responseMessage = responseMessage.substring(0, 1997) + '...';
                }
                
                await interaction.editReply(responseMessage);
                return;
            }

            const embeds = [];
            let currentEmbed = new EmbedBuilder()
                .setTitle('Reforger Lookup Directory')
                .setDescription(`🔍 Whois: ${value}\n${serverIdOption ? `**Server:** ${serverIdOption}\n` : ''}\n`)
                .setColor(0xFFA500)
                .setFooter({ text: 'ReforgerJS' });

            rows.forEach((player, index) => {
                let playerInfo = `**Name:** ${player.playerName || 'Missing Player Name'}\n` +
                               `**Server ID:** ${player.server_id || 'Unknown'}\n` +
                               `**IP Address:** ${player.playerIP || 'Missing IP Address'}\n` +
                               `**Reforger UUID:** ${player.playerUID || 'Missing UUID'}\n` +
                               `**be GUID:** ${player.beGUID || 'Missing beGUID'}\n` +
                               `**Device:** ${player.device || 'Not Found'}`;
                
                if (player.device === 'PC') {
                    playerInfo += `\n**SteamID:** ${player.steamID || 'Not Found'}`;
                }
                
                const fieldName = rows.length > 1 ? `Player ${index + 1}` : 'Player Information';

                // Check embed limits
                if (currentEmbed.data.fields && currentEmbed.data.fields.length >= 25) {
                    embeds.push(currentEmbed);
                    currentEmbed = new EmbedBuilder()
                        .setTitle('Reforger Lookup Directory (Continued)')
                        .setColor(0xFFA500)
                        .setFooter({ text: 'ReforgerJS' });
                }
                
                currentEmbed.addFields({ name: fieldName, value: playerInfo });
            });

            embeds.push(currentEmbed);

            for (let i = 0; i < embeds.length; i++) {
                if (i === 0) {
                    await interaction.editReply({ embeds: [embeds[i]] });
                } else {
                    await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
                }
            }
        } catch (queryError) {
            logger.error(`[Whois Command] Database query error: ${queryError.message}`);
            await interaction.editReply('An error occurred while querying the database.');
        }
    } catch (error) {
        logger.error(`[Whois Command] Unexpected error: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An unexpected error occurred while executing the command.',
                ephemeral: true
            });
        } else if (interaction.deferred && !interaction.replied) {
            await interaction.editReply('An unexpected error occurred while executing the command.');
        }
    }
};
