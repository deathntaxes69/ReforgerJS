// ReforgerJS/reforger-server/plugins/AltChecker.js
const mysql = require("mysql2/promise");
const { EmbedBuilder } = require("discord.js");

class AltChecker {
  constructor(config) {
    this.config = config;
    this.name = "AltChecker Plugin";
    this.serverInstance = null;
    this.discordClient = null;
    this.channelOrThread = null;
    this.channelId = null;
    this.logAlts = false;
    this.logOnlyOnline = false;
    this.playerIPCache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
    this.serverId = null; // To store the server ID
  }

  async prepareToMount(serverInstance, discordClient) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;
    // Get the server ID from the instance's scoped config
    this.serverId = this.serverInstance.config.server.id || null;
  
    try {
      if (!this.config.connectors || !this.config.connectors.mysql || !this.config.connectors.mysql.enabled) {
        logger.warn(`[${this.name}] MySQL is not enabled in the configuration. Plugin will be disabled for Server ${this.serverId || '?'}.`);
        return;
      }
  
      if (!process.mysqlPool) {
        logger.error(`[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`);
        return;
      }

      if (!this.serverId) {
        logger.error(`[${this.name}] Server ID is missing. Plugin will be disabled.`);
        return;
      }
  
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "AltChecker");
      if (!pluginConfig || !pluginConfig.channel) {
        logger.warn(`[${this.name}] Missing 'channel' ID in plugin config. Plugin disabled for Server ${this.serverId}.`);
        return;
      }
  
      this.channelId = pluginConfig.channel;
      this.logAlts = pluginConfig.logAlts || false;
      this.logOnlyOnline = pluginConfig.logOnlyOnline || false;
  
      const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, { cache: true, force: true });
  
      const channelOrThread = await guild.channels.fetch(this.channelId);
      if (!channelOrThread) {
        logger.warn(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}. Plugin disabled for Server ${this.serverId}.`);
        return;
      }
  
      if (channelOrThread.isThread() || channelOrThread.isTextBased()) {
        this.channelOrThread = channelOrThread;
      } else {
        logger.warn(`[${this.name}] The specified ID is not a valid text channel or thread. Plugin disabled for Server ${this.serverId}.`);
        return;
      }
  
      if (!this.channelOrThread.permissionsFor(this.discordClient.user).has("SendMessages")) {
        logger.warn(`[${this.name}] Bot does not have permission to send messages in the channel or thread. Plugin disabled for Server ${this.serverId}.`);
        return;
      }
  
      this.serverInstance.removeListener("playerJoined", this.handlePlayerJoined);
      this.serverInstance.on("playerJoined", this.handlePlayerJoined.bind(this));
  
      logger.info(`[${this.name}] Initialized for Server ${this.serverId} and listening to playerJoined events.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization for Server ${this.serverId}: ${error.stack}`);
    }
  }
  
  async handlePlayerJoined(player) {
    const { playerIP, playerName, beGUID, playerUid } = player;
    const currentServerId = this.serverId;

    if (!playerIP) {
      logger.warn(`[${this.name}] Player joined without an IP address: ${playerName} on Server ${currentServerId}`);
      return;
    }

    try {
      // Check cache first
      if (this.playerIPCache.has(playerIP)) {
        logger.verbose(`[${this.name}] Cache hit for IP: ${playerIP} on Server ${currentServerId}`);
      } else {
        logger.verbose(`[${this.name}] Cache miss for IP: ${playerIP}. Querying database...`);
        const [rows] = await process.mysqlPool.query("SELECT * FROM players WHERE playerIP = ?", [playerIP]);
        this.playerIPCache.set(playerIP, rows);

        // Set timeout to clear cache entry
        setTimeout(() => this.playerIPCache.delete(playerIP), this.cacheTTL);
      }

      const allAccountsOnIP = this.playerIPCache.get(playerIP);

      // Filter out the player who just joined (checking by UID, which is the most reliable)
      const otherAccounts = allAccountsOnIP.filter(
        (dbPlayer) => dbPlayer.playerUID !== playerUid
      );

      if (otherAccounts.length === 0) {
        logger.verbose(`[${this.name}] No other accounts found for ${playerName} on IP ${playerIP}.`);
        return;
      }

      // Separate accounts into "alts on this server" vs "players on other servers"
      const altsOnThisServer = [];
      const playersOnOtherServers = [];

      otherAccounts.forEach(acc => {
        if (acc.server_id == currentServerId) {
          altsOnThisServer.push(acc);
        } else {
          playersOnOtherServers.push(acc);
        }
      });

      if (altsOnThisServer.length === 0 && playersOnOtherServers.length === 0) {
        return; // No alts to report
      }

      // Check online status
      const playerList = this.serverInstance.players || [];
      const onlineBeGUIDs = new Set(playerList.map((p) => p.beGUID?.trim().toLowerCase()).filter((beGUID) => beGUID));
      let atLeastOneOnline = false;

      const mapOnlineStatus = (acc) => {
        const normalizedAltBeGUID = acc.beGUID?.trim().toLowerCase();
        if (!normalizedAltBeGUID) {
          acc.online = false;
        } else {
          // Note: This only checks for online status on the CURRENT server instance.
          // A more complex check would require querying other server instances.
          acc.online = onlineBeGUIDs.has(normalizedAltBeGUID);
        }
        if (acc.online) {
          atLeastOneOnline = true;
        }
        return acc;
      };

      const altsOnThisServerWithStatus = altsOnThisServer.map(mapOnlineStatus);
      
      if (this.logOnlyOnline && !atLeastOneOnline) {
        logger.verbose(`[${this.name}] Alt accounts found for ${playerName}, but none are online on Server ${currentServerId}. Skipping log.`);
        return;
      }

      if (this.logAlts) {
        const embed = new EmbedBuilder()
          .setTitle("🔎 Alt Account Check")
          .setDescription(`Player **${playerName}** joined **Server ${currentServerId}**.\n**📡 IP Address:** ${playerIP}`)
          .setColor("#FFA500")
          .addFields({ name: "Joining Player", value: `**Name:** ${playerName}\n**UID:** ${playerUid}\n**BEGUID:** ${beGUID || "Missing"}` })
          .setFooter({ text: "AltChecker Plugin - ReforgerJS" });
          
        if (altsOnThisServerWithStatus.length > 0) {
          embed.addFields({
            name: `🚨 ALTS ON THIS SERVER (${currentServerId})`,
            value: altsOnThisServerWithStatus.map(alt => {
              return `**Name:** ${alt.playerName || 'Unknown'} (${alt.online ? 'Online' : 'Offline'})\n**UID:** ${alt.playerUID}\n**BEGUID:** ${alt.beGUID || "Missing"}`;
            }).join('\n\n')
          });
        }
        
        if (playersOnOtherServers.length > 0) {
          // Group by server ID
          const groupedByServer = playersOnOtherServers.reduce((acc, player) => {
             const serverId = player.server_id || 'Unknown';
             if (!acc[serverId]) acc[serverId] = [];
             acc[serverId].push(player);
             return acc;
          }, {});
          
          for (const [serverId, players] of Object.entries(groupedByServer)) {
            embed.addFields({
              name: `ℹ️ Players on Other Servers (Server ${serverId})`,
              value: players.map(alt => {
                return `**Name:** ${alt.playerName || 'Unknown'}\n**UID:** ${alt.playerUID}`;
              }).join('\n\n')
            });
          }
        }

        try {
          if (embed.data.fields.length > 1) { // Only send if we have alts to report
            await this.channelOrThread.send({ embeds: [embed] });
            logger.info(`[${this.name}] Alt accounts detected and logged for ${playerName} (IP: ${playerIP}) on Server ${currentServerId}`);
          }
        } catch (error) {
          logger.error(`[${this.name}] Failed to send embed for Server ${currentServerId}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`[${this.name}] Error handling playerJoined for '${playerName}' on Server ${currentServerId}: ${error.stack}`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeListener("playerJoined", this.handlePlayerJoined);
    }
    this.serverInstance = null;
    this.playerIPCache.clear();
    logger.verbose(`[${this.name}] Cleanup complete for Server ${this.serverId || '?'}.`);
  }
}

module.exports = AltChecker;
