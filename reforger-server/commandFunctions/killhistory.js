// ReforgerJS/reforger-server/commandFunctions/killhistory.js
const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    const identifier = interaction.options.getString('identifier');
    const teamkillsOnly = interaction.options.getBoolean('teamkills_only') || false;
    const serverIdOption = interaction.options.getInteger('server');
    const user = interaction.user;
    
    logger.info(`[KillHistoryRJS Command] User: ${user.username} (ID: ${user.id}) requested kill history for identifier: ${identifier} (teamkills only: ${teamkillsOnly}) on server: ${serverIdOption || 'ALL'}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool; // Use global pool
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const [rjsKillsTableCheck] = await pool.query(`SHOW TABLES LIKE 'rjs_playerkills'`);
        const [playersTableCheck] = await pool.query(`SHOW TABLES LIKE 'players'`);
        
        if (!rjsKillsTableCheck.length) {
            await interaction.editReply('`rjs_playerkills` table is missing. The WCS_DBEvents plugin may not be enabled or has not run yet.');
            return;
        }

        if (!playersTableCheck.length) {
            await interaction.editReply('`players` table is missing. The DBLog plugin may not be enabled or has not run yet.');
            return;
        }

        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
        
        let killerGUID;
        let killerName = 'Unknown Player';
        
        // Build server filter
        const serverFilter = serverIdOption ? `AND server_id = ?` : '';
        const serverParam = serverIdOption ? [serverIdOption.toString()] : [];
        const serverMessage = serverIdOption ? ` on server ${serverIdOption}` : '';

        if (isUUID) {
            killerGUID = identifier;
            
            // Try to find player name
            try {
                const [playerRow] = await pool.query(
                    `SELECT playerName FROM players WHERE playerUID = ? ${serverFilter} LIMIT 1`, 
                    [killerGUID, ...serverParam]
                );
                if (playerRow.length > 0) {
                    killerName = playerRow[0].playerName;
                } else {
                    const [anyPlayerRow] = await pool.query(
                        `SELECT playerName FROM players WHERE playerUID = ? LIMIT 1`, 
                        [killerGUID]
                    );
                    if (anyPlayerRow.length > 0) killerName = anyPlayerRow[0].playerName;
                }
            } catch (e) {
                logger.warn(`[KillHistoryRJS Command] Could not fetch player name for ${killerGUID}: ${e.message}`);
            }

            // Check if player exists in DB
            let existsQuery = `SELECT (
                EXISTS (SELECT 1 FROM rjs_playerkills WHERE killerBiId = ? ${serverFilter}) 
                OR EXISTS (SELECT 1 FROM players WHERE playerUID = ? ${serverFilter})
            ) AS existsInDB`;
            
            const [[playerExists]] = await pool.query(existsQuery, [killerGUID, ...serverParam, killerGUID, ...serverParam]);
            
            if (!playerExists.existsInDB) {
                await interaction.editReply(`Player with UUID: ${killerGUID} could not be found${serverMessage}.`);
                return;
            }
            
        } else {
            // Find by name
            const [matchingPlayers] = await pool.query(
                `SELECT DISTINCT playerUID, playerName, server_id FROM players WHERE playerName LIKE ? ${serverFilter}`,
                [`%${identifier}%`, ...serverParam]
            );
            
            if (matchingPlayers.length === 0) {
                // If not in players table, check kill history
                const [matchingKillers] = await pool.query(
                    `SELECT DISTINCT killerBiId, killerName, server_id FROM rjs_playerkills WHERE killerName LIKE ? AND killerBiId IS NOT NULL ${serverFilter}`,
                    [`%${identifier}%`, ...serverParam]
                );
                
                if (matchingKillers.length === 0) {
                    await interaction.editReply(`No players found with name containing: ${identifier}${serverMessage}`);
                    return;
                } else if (matchingKillers.length > 1) {
                    const displayCount = Math.min(matchingKillers.length, 5);
                    let responseMessage = `Found ${matchingKillers.length} players in kill history matching "${identifier}"${serverMessage}. Showing first ${displayCount}. Please refine your search or use a UUID.\n\n`;
                    
                    for (let i = 0; i < displayCount; i++) {
                        const player = matchingKillers[i];
                        responseMessage += `${i+1}. ${player.killerName} (Server ${player.server_id})\n   UUID: ${player.killerBiId}\n`;
                    }
                    await interaction.editReply(responseMessage);
                    return;
                } else {
                    killerGUID = matchingKillers[0].killerBiId;
                    killerName = matchingKillers[0].killerName;
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
                killerGUID = matchingPlayers[0].playerUID;
                killerName = matchingPlayers[0].playerName;
            }
        }

        let killHistoryQuery = `
            SELECT 
                victimName, victimBiId, weapon, distance, friendlyFire, teamKill, killType, timestamp, server_id
            FROM rjs_playerkills 
            WHERE killerBiId = ?
        `;
        
        let queryParams = [killerGUID];

        if (serverIdOption) {
            killHistoryQuery += ` AND server_id = ?`;
            queryParams.push(serverIdOption.toString());
        }

        if (teamkillsOnly) {
            killHistoryQuery += ` AND (friendlyFire = true OR teamKill = true)`;
        }

        killHistoryQuery += ` ORDER BY timestamp DESC LIMIT 10`;

        const [killRows] = await pool.query(killHistoryQuery, queryParams);

        if (killRows.length === 0) {
            const teamkillText = teamkillsOnly ? ' teamkill' : '';
            await interaction.editReply(`No${teamkillText} kill history found for player: ${killerName} (${killerGUID})${serverMessage}`);
            return;
        }

        const teamkillText = teamkillsOnly ? ' Teamkill' : '';
        let serverDisplay = "";
        if (serverIdOption) {
            serverDisplay = `**Server:** ${serverIdOption}\n`;
        } else {
            const serverList = [...new Set(killRows.map(row => row.server_id).filter(Boolean))];
            if (serverList.length > 0) {
                serverDisplay = `**Servers:** ${serverList.join(', ')}\n`;
            }
        }

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ Kill History${teamkillText}`)
            .setDescription(`**Player:** ${killerName}\n**UUID:** ${killerGUID}\n${serverDisplay}**Last ${killRows.length} kills:**\n---------------`)
            .setColor(teamkillsOnly ? "#FF6B35" : "#FFA500")
            .setFooter({ text: "RJS Kill History" });

        let fieldsAdded = 0;
        const maxFields = 25;

        for (let i = 0; i < killRows.length && fieldsAdded < maxFields; i++) {
            const kill = killRows[i];
            const isFriendlyFire = kill.friendlyFire || kill.teamKill;
            const friendlyFireIcon = isFriendlyFire ? "⚠️ " : "";
            const distance = kill.distance ? `${parseFloat(kill.distance).toFixed(1)}m` : 'Unknown';
            const weapon = kill.weapon || 'Unknown';
            const victimGUID = kill.victimBiId || 'Unknown';
            const killType = kill.killType || 'Kill';
            const serverIdText = !serverIdOption ? ` (Server ${kill.server_id || '?'})` : '';
            
            const fieldName = `${friendlyFireIcon}${i + 1}. ${kill.victimName || 'Unknown Victim'}${serverIdText}`;
            const fieldValue = `**GUID:** ${victimGUID}\n**Weapon:** ${weapon}\n**Distance:** ${distance}\n**Type:** ${killType}\n**Friendly Fire:** ${isFriendlyFire ? 'Yes' : 'No'}`;
            
            embed.addFields({
                name: fieldName,
                value: fieldValue,
                inline: false
            });
            
            fieldsAdded++;
        }
        
        // Check total embed size before sending
        if (JSON.stringify(embed.data).length > 5900) {
             // This is a rough check. If it's too big, we'd need to paginate.
             // For now, we'll just send it. Discord will error if it's too big.
             logger.warn(`[KillHistoryRJS Command] Embed size for ${killerGUID} is very large, may be truncated.`);
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[KillHistoryRJS Command] Error: ${error.message}`);
        logger.error(error.stack);
        await interaction.editReply('An error occurred while retrieving kill history.');
    }
};
