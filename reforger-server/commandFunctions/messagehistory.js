// ReforgerJS/reforger-server/commandFunctions/messagehistory.js
const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    const identifier = interaction.options.getString('identifier');
    const serverIdOption = interaction.options.getInteger('server');
    const user = interaction.user;
    
    logger.info(`[MessageHistoryRJS Command] User: ${user.username} (ID: ${user.id}) requested message history for identifier: ${identifier} on server: ${serverIdOption || 'ALL'}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool; // Use global pool
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const [rjsChatTableCheck] = await pool.query(`SHOW TABLES LIKE 'rjs_chat'`);
        const [playersTableCheck] = await pool.query(`SHOW TABLES LIKE 'players'`);
        
        if (!rjsChatTableCheck.length) {
            await interaction.editReply('`rjs_chat` table is missing. The WCS_DBEvents plugin may not be enabled or has not run yet.');
            return;
        }

        if (!playersTableCheck.length) {
            await interaction.editReply('`players` table is missing. The DBLog plugin may not be enabled or has not run yet.');
            return;
        }

        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
        
        let playerGUID;
        let playerName = 'Unknown Player';

        // Build server filter
        const serverFilter = serverIdOption ? `AND server_id = ?` : '';
        const serverParam = serverIdOption ? [serverIdOption.toString()] : [];
        const serverMessage = serverIdOption ? ` on server ${serverIdOption}` : '';

        if (isUUID) {
            playerGUID = identifier;
            
            // Try to find player name
            try {
                const [playerRow] = await pool.query(
                    `SELECT playerName FROM players WHERE playerUID = ? ${serverFilter} LIMIT 1`, 
                    [playerGUID, ...serverParam]
                );
                if (playerRow.length > 0) {
                    playerName = playerRow[0].playerName;
                } else {
                    const [anyPlayerRow] = await pool.query(
                        `SELECT playerName FROM players WHERE playerUID = ? LIMIT 1`, 
                        [playerGUID]
                    );
                    if (anyPlayerRow.length > 0) playerName = anyPlayerRow[0].playerName;
                }
            } catch (e) {
                logger.warn(`[MessageHistoryRJS Command] Could not fetch player name for ${playerGUID}: ${e.message}`);
            }

            // Check if player exists in DB
            let existsQuery = `SELECT (
                EXISTS (SELECT 1 FROM rjs_chat WHERE playerBiId = ? ${serverFilter}) 
                OR EXISTS (SELECT 1 FROM players WHERE playerUID = ? ${serverFilter})
            ) AS existsInDB`;
            
            const [[playerExists]] = await pool.query(existsQuery, [playerGUID, ...serverParam, playerGUID, ...serverParam]);
            
            if (!playerExists.existsInDB) {
                await interaction.editReply(`Player with UUID: ${playerGUID} could not be found${serverMessage}.`);
                return;
            }
            
        } else {
            // Find by name
            const [matchingPlayers] = await pool.query(
                `SELECT DISTINCT playerUID, playerName, server_id FROM players WHERE playerName LIKE ? ${serverFilter}`,
                [`%${identifier}%`, ...serverParam]
            );
            
            if (matchingPlayers.length === 0) {
                 // If not in players table, check chat history
                const [matchingChatters] = await pool.query(
                    `SELECT DISTINCT playerBiId, playerName, server_id FROM rjs_chat WHERE playerName LIKE ? AND playerBiId IS NOT NULL ${serverFilter}`,
                    [`%${identifier}%`, ...serverParam]
                );
                
                if (matchingChatters.length === 0) {
                    await interaction.editReply(`No players found with name containing: ${identifier}${serverMessage}`);
                    return;
                } else if (matchingChatters.length > 1) {
                    const displayCount = Math.min(matchingChatters.length, 5);
                    let responseMessage = `Found ${matchingChatters.length} players in chat history matching "${identifier}"${serverMessage}. Showing first ${displayCount}. Please refine your search or use a UUID.\n\n`;
                    
                    for (let i = 0; i < displayCount; i++) {
                        const player = matchingChatters[i];
                        responseMessage += `${i+1}. ${player.playerName} (Server ${player.server_id})\n   UUID: ${player.playerBiId}\n`;
                    }
                    
                    await interaction.editReply(responseMessage);
                    return;
                } else {
                    playerGUID = matchingChatters[0].playerBiId;
                    playerName = matchingChatters[0].playerName;
                }
            } else if (matchingPlayers.length > 1) {
                const displayCount = Math.min(matchingPlayers.length, 5);
                let responseMessage = `Found ${matchingPlayers.length} players matching "${identifier}"${serverMessage}. Showing first ${displayCount}. Please refine your search or use a UUID.\n\n`;
                
                for (let i = 0; i < displayCount; i++) {
                    const player = matchingPlayers[i];
                    responseMessage += `${i+1}. ${player.playerName} (Server ${player.server_id})\n   UUID: ${player.playerUID}\n`;
                }
                
                await interaction.editReply(responseMessage);
                return;
            } else {
                playerGUID = matchingPlayers[0].playerUID;
                playerName = matchingPlayers[0].playerName;
            }
        }

        let messageHistoryQuery = `
            SELECT 
                channelType, message, timestamp, server_id
            FROM rjs_chat 
            WHERE playerBiId = ?
        `;
        
        let queryParams = [playerGUID];

        if (serverIdOption) {
            messageHistoryQuery += ` AND server_id = ?`;
            queryParams.push(serverIdOption.toString());
        }

        messageHistoryQuery += ` ORDER BY timestamp DESC LIMIT 10`;

        const [messageRows] = await pool.query(messageHistoryQuery, queryParams);

        if (messageRows.length === 0) {
            await interaction.editReply(`No chat message history found for player: ${playerName} (${playerGUID})${serverMessage}`);
            return;
        }

        let serverDisplay = "";
        if (serverIdOption) {
            serverDisplay = `**Server:** ${serverIdOption}\n`;
        } else {
            const serverList = [...new Set(messageRows.map(row => row.server_id).filter(Boolean))];
            if (serverList.length > 0) {
                serverDisplay = `**Servers:** ${serverList.join(', ')}\n`;
            }
        }

        const embed = new EmbedBuilder()
            .setTitle(`💬 Chat Message History`)
            .setDescription(`**Player:** ${playerName}\n**UUID:** ${playerGUID}\n${serverDisplay}**Last ${messageRows.length} messages:**\n---------------`)
            .setColor("#4287f5")
            .setFooter({ text: "RJS Message History" });

        let fieldsAdded = 0;
        const maxFields = 25;

        for (let i = 0; i < messageRows.length && fieldsAdded < maxFields; i++) {
            const msg = messageRows[i];
            const channelType = msg.channelType || 'Unknown';
            const message = msg.message || 'Empty message';
            const serverIdText = !serverIdOption ? ` (Server ${msg.server_id || '?'})` : '';
            
            let truncatedMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;
            
            const fieldName = `${i + 1}. [${channelType}]${serverIdText}`;
            
            embed.addFields({
                name: fieldName,
                value: truncatedMessage,
                inline: false
            });
            
            fieldsAdded++;
        }
        
        // Check total embed size before sending
        if (JSON.stringify(embed.data).length > 5900) {
             logger.warn(`[MessageHistoryRJS Command] Embed size for ${playerGUID} is very large, may be truncated.`);
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[MessageHistoryRJS Command] Error: ${error.message}`);
        logger.error(error.stack);
        await interaction.editReply('An error occurred while retrieving message history.');
    }
};
