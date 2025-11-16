// reforger-server/commandFunctions/voteinfo.js
const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

module.exports = async (interaction, serverInstances, discordClient, extraData = {}) => {
    const uuid = interaction.options.getString('uuid');
    const serverIdOption = interaction.options.getInteger('server');
    const user = interaction.user;
    
    logger.info(`[VoteInfo Command] User: ${user.username} (ID: ${user.id}) requested vote info for UUID: ${uuid} on server: ${serverIdOption || 'ALL'}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool; // Use global pool
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
        if (!isUUID) {
            await interaction.editReply('Invalid UUID format. Please provide a valid player UUID.');
            return;
        }

        const [offendersTableCheck] = await pool.query(`SHOW TABLES LIKE 'VoteOffenders'`);
        const [victimsTableCheck] = await pool.query(`SHOW TABLES LIKE 'VoteVictims'`);
        const [playersTableCheck] = await pool.query(`SHOW TABLES LIKE 'players'`);
        
        if (!offendersTableCheck.length || !victimsTableCheck.length || !playersTableCheck.length) {
            await interaction.editReply('Required tables (VoteOffenders, VoteVictims, players) are missing in the database. Ensure the VoteLogs and DBLog plugins are enabled.');
            return;
        }
        
        // Build server filter
        const serverFilter = serverIdOption ? `AND server_id = ?` : '';
        const serverParam = serverIdOption ? [serverIdOption.toString()] : [];

        // Try to find the player's name
        let playerName = 'Unknown Player';
        try {
            const [playerRow] = await pool.query(
                `SELECT playerName FROM players WHERE playerUID = ? ${serverFilter} LIMIT 1`, 
                [uuid, ...serverParam]
            );
            if (playerRow.length > 0) {
                playerName = playerRow[0].playerName;
            } else {
                // If not found on specific server, try finding on any server
                const [anyPlayerRow] = await pool.query(
                    `SELECT playerName FROM players WHERE playerUID = ? LIMIT 1`, 
                    [uuid]
                );
                if (anyPlayerRow.length > 0) {
                    playerName = anyPlayerRow[0].playerName;
                }
            }
        } catch (e) {
            logger.warn(`[VoteInfo Command] Could not fetch player name for ${uuid}: ${e.message}`);
        }
        
        // Check if any vote data exists at all
        const [[playerExists]] = await pool.query(
            `SELECT (EXISTS (SELECT 1 FROM VoteOffenders WHERE (offenderUID = ? OR victimUID = ?) ${serverFilter}) 
             OR EXISTS (SELECT 1 FROM VoteVictims WHERE victimUID = ? ${serverFilter})) AS existsInDB`,
            [uuid, uuid, ...serverParam, uuid, ...serverParam]
        );
        
        if (!playerExists.existsInDB) {
            await interaction.editReply(`No vote data found for player: ${playerName} (${uuid})${serverIdOption ? ` on server ${serverIdOption}` : ''}`);
            return;
        }

        // 1. Votes started by player
        const [[votesStarted]] = await pool.query(
            `SELECT COUNT(*) AS count FROM VoteOffenders WHERE offenderUID = ? ${serverFilter}`,
            [uuid, ...serverParam]
        );

        // 2. Times player has been vote kicked
        const [[votesKicked]] = await pool.query(
            `SELECT COUNT(*) AS count FROM VoteVictims WHERE victimUID = ? ${serverFilter}`,
            [uuid, ...serverParam]
        );

        // 3. Top victims (players this person voted against)
        const [topVictims] = await pool.query(
            `SELECT victimName, victimUID, COUNT(*) as count
             FROM VoteOffenders
             WHERE offenderUID = ? AND victimUID IS NOT NULL ${serverFilter}
             GROUP BY victimUID, victimName
             ORDER BY count DESC
             LIMIT 3`,
            [uuid, ...serverParam]
        );

        // 4. Top voters (players who voted against this person)
        const [topVoters] = await pool.query(
            `SELECT offenderName, offenderUID, COUNT(*) as count
             FROM VoteOffenders
             WHERE victimUID = ? AND offenderUID IS NOT NULL ${serverFilter}
             GROUP BY offenderUID, offenderName
             ORDER BY count DESC
             LIMIT 3`,
            [uuid, ...serverParam]
        );

        const serverTitle = serverIdOption ? `on Server ${serverIdOption}` : `(All Servers)`;

        const embed = new EmbedBuilder()
            .setTitle(`🗳️ Player Vote Information ${serverTitle}`)
            .setDescription(`**Player:** ${playerName}\n**UUID:** ${uuid}\n---------------\n`)
            .setColor("#FFA500")
            .setFooter({ text: "Reforger Vote Info" });

        embed.addFields(
            {
                name: "**Votes Initiated**",
                value: `${votesStarted.count} vote${votesStarted.count !== 1 ? 's' : ''} started`
            },
            {
                name: "**Vote Kicked**",
                value: `Player has been vote kicked ${votesKicked.count} time${votesKicked.count !== 1 ? 's' : ''}`
            }
        );

        if (topVictims.length > 0) {
            let victimsText = '';
            topVictims.forEach((victim, index) => {
                victimsText += `${index + 1}. ${victim.victimName || 'Unknown'}: ${victim.count} vote${victim.count !== 1 ? 's' : ''}\n`;
            });
            
            embed.addFields({
                name: "**Top Voted Against**",
                value: victimsText || 'No data available'
            });
        } else {
            embed.addFields({
                name: "**Top Voted Against**",
                value: 'No data available'
            });
        }

        if (topVoters.length > 0) {
            let votersText = '';
            topVoters.forEach((voter, index) => {
                votersText += `${index + 1}. ${voter.offenderName || 'Unknown'}: ${voter.count} vote${voter.count !== 1 ? 's' : ''}\n`;
            });
            
            embed.addFields({
                name: "**Top Voted By**",
                value: votersText || 'No data available'
            });
        } else {
            embed.addFields({
                name: "**Top Voted By**",
                value: 'No data available'
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[VoteInfo Command] Error: ${error.message}`);
        await interaction.editReply('An error occurred while retrieving vote information.');
    }
};
