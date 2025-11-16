// ReforgerJS/reforger-server/plugins/WCS_TKAutokick.js
const mysql = require("mysql2/promise");

class WCS_TKAutokick {
  constructor(config) {
    this.config = config;
    this.name = "WCS_TKAutokick Plugin";
    this.isInitialized = false;
    this.serverInstance = null;
    this.serverId = null; // To store the server ID
    
    this.teamkillLimit = 5;
    this.timeWindowMinutes = 20;
    this.warningMessage = "Watch your fire, Teamkilling will result in your removal from the server";
    
    this.teamkillTracker = new Map();
    
    this.cleanupInterval = null;
    this.cleanupIntervalMs = 60000;
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    // Get the server ID from the instance's scoped config
    this.serverId = this.serverInstance.config.server.id || null;

    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "WCS_TKAutokick");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.verbose(`[${this.name}] Plugin is disabled in configuration for Server ${this.serverId || '?'}.`);
        return;
      }
      
      if (!this.serverId) {
        logger.error(`[${this.name}] Server ID is missing. Plugin will be disabled.`);
        return;
      }

      if (typeof pluginConfig.teamkillLimit === 'number' && pluginConfig.teamkillLimit > 0) {
        this.teamkillLimit = pluginConfig.teamkillLimit;
      }

      if (typeof pluginConfig.timeWindowMinutes === 'number' && pluginConfig.timeWindowMinutes > 0) {
        this.timeWindowMinutes = pluginConfig.timeWindowMinutes;
      }

      if (typeof pluginConfig.warningMessage === 'string' && pluginConfig.warningMessage.trim()) {
        this.warningMessage = pluginConfig.warningMessage.trim();
      }

      if (!this.serverInstance.rcon) {
        logger.error(`[${this.name}] [Server ${this.serverId}] RCON is not available. Plugin will be disabled.`);
        return;
      }

      this.setupEventListeners();
      this.startCleanup();

      this.isInitialized = true;
      logger.info(`[${this.name}] [Server ${this.serverId}] Initialized successfully. Monitoring for friendly fire (${this.teamkillLimit} teamkills in ${this.timeWindowMinutes} minutes = auto-kick).`);
      logger.info(`[${this.name}] [Server ${this.serverId}] Warning message: "${this.warningMessage}"`);
    } catch (error) {
      logger.error(`[${this.name}] [Server ${this.serverId}] Error during initialization: ${error.message}`);
    }
  }

  setupEventListeners() {
    // This listener is on the serverInstance, so it's already scoped to this server
    this.serverInstance.on('playerKilledEvent', this.handlePlayerKilled.bind(this));
  }

  async handlePlayerKilled(data) {
    // Check if the event is from the correct server
    if (data.serverId !== this.serverId) {
      return;
    }
    
    if (!data || !data.killer || !data.victim || !data.kill) {
      return;
    }

    if (!data.kill.friendlyFire) {
      return;
    }

    if (!data.kill.weapon || data.kill.weapon === 'unknown') {
      logger.verbose(`[${this.name}] [Server ${this.serverId}] Ignoring friendly fire with unknown weapon by ${data.killer.name}`);
      return;
    }

    if (!data.killer.guid || data.killer.guid === 'AI' || data.killer.guid === 'World' || !data.killer.id || data.killer.id <= 0) {
      return;
    }

    const killerGUID = data.killer.guid;
    const killerId = data.killer.id;
    const killerName = data.killer.name;
    const victimName = data.victim.name;
    const weapon = data.kill.weapon;
    const currentTime = Date.now();

    logger.info(`[${this.name}] [Server ${this.serverId}] Friendly fire detected: ${killerName} (ID: ${killerId}) killed ${victimName} with ${weapon}`);

    if (!this.teamkillTracker.has(killerGUID)) {
      this.teamkillTracker.set(killerGUID, []);
    }

    const playerTeamkills = this.teamkillTracker.get(killerGUID);
    playerTeamkills.push({
      timestamp: currentTime,
      victimName: victimName,
      weapon: weapon,
      killerId: killerId
    });

    this.cleanupPlayerEntries(killerGUID);

    const recentTeamkills = this.teamkillTracker.get(killerGUID);
    if (recentTeamkills.length >= this.teamkillLimit) {
      await this.kickPlayer(killerGUID, killerId, killerName, recentTeamkills);
    } else {
      await this.warnPlayer(killerId, killerName, recentTeamkills.length);
      
      const remaining = this.teamkillLimit - recentTeamkills.length;
      logger.warn(`[${this.name}] [Server ${this.serverId}] ${killerName} (ID: ${killerId}) has ${recentTeamkills.length} friendly fire incidents in the last ${this.timeWindowMinutes} minutes. ${remaining} more will result in auto-kick.`);
    }
  }

  async warnPlayer(killerId, killerName, currentCount) {
    try {
      if (!this.serverInstance.rcon || !this.serverInstance.rcon.isConnected) {
        logger.error(`[${this.name}] [Server ${this.serverId}] Cannot warn ${killerName} - RCON is not connected.`);
        return;
      }

      const warnCommand = `#warn ${killerId} "${this.warningMessage}"`;
      
      logger.info(`[${this.name}] [Server ${this.serverId}] WARNING: Sending teamkill warning to ${killerName} (${currentCount}/${this.teamkillLimit}). Command: ${warnCommand}`);

      this.serverInstance.rcon.sendCustomCommand(warnCommand);

      logger.info(`[${this.name}] [Server ${this.serverId}] Successfully warned ${killerName} for friendly fire.`);
    } catch (error) {
      logger.error(`[${this.name}] [Server ${this.serverId}] Error warning player ${killerName}: ${error.message}`);
    }
  }

  cleanupPlayerEntries(playerGUID) {
    const currentTime = Date.now();
    const timeWindowMs = this.timeWindowMinutes * 60 * 1000;
    const cutoffTime = currentTime - timeWindowMs;

    if (this.teamkillTracker.has(playerGUID)) {
      const playerTeamkills = this.teamkillTracker.get(playerGUID);
      const filteredTeamkills = playerTeamkills.filter(tk => tk.timestamp > cutoffTime);
      
      if (filteredTeamkills.length === 0) {
        this.teamkillTracker.delete(playerGUID);
      } else {
        this.teamkillTracker.set(playerGUID, filteredTeamkills);
      }
    }
  }

  async kickPlayer(killerGUID, killerId, killerName, teamkills) {
    try {
      if (!this.serverInstance.rcon || !this.serverInstance.rcon.isConnected) {
        logger.error(`[${this.name}] [Server ${this.serverId}] Cannot kick ${killerName} - RCON is not connected.`);
        return;
      }

      const kickCommand = `#kick ${killerId}`;
      
      logger.warn(`[${this.name}] [Server ${this.serverId}] AUTO-KICK: ${killerName} (ID: ${killerId}, GUID: ${killerGUID}) exceeded friendly fire limit (${teamkills.length}/${this.teamkillLimit}). Executing: ${kickCommand}`);

      logger.info(`[${this.name}] [Server ${this.serverId}] Friendly fire history for ${killerName}:`);
      teamkills.forEach((tk, index) => {
        const timeAgo = Math.round((Date.now() - tk.timestamp) / 60000);
        logger.info(`[${this.name}] [Server ${this.serverId}]   ${index + 1}. Killed ${tk.victimName} with ${tk.weapon} (${timeAgo} minutes ago)`);
      });

      this.serverInstance.rcon.sendCustomCommand(kickCommand);

      this.teamkillTracker.delete(killerGUID);

      logger.warn(`[${this.name}] [Server ${this.serverId}] Successfully kicked ${killerName} (ID: ${killerId}) for excessive friendly fire.`);
    } catch (error) {
      logger.error(`[${this.name}] [Server ${this.serverId}] Error kicking player ${killerName}: ${error.message}`);
    }
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupAllEntries();
    }, this.cleanupIntervalMs);
  }

  cleanupAllEntries() {
    const currentTime = Date.now();
    const timeWindowMs = this.timeWindowMinutes * 60 * 1000;
    const cutoffTime = currentTime - timeWindowMs;
    let cleanedPlayers = 0;

    for (const [playerGUID, teamkills] of this.teamkillTracker.entries()) {
      const filteredTeamkills = teamkills.filter(tk => tk.timestamp > cutoffTime);
      
      if (filteredTeamkills.length === 0) {
        this.teamkillTracker.delete(playerGUID);
        cleanedPlayers++;
      } else if (filteredTeamkills.length !== teamkills.length) {
        this.teamkillTracker.set(playerGUID, filteredTeamkills);
      }
    }

    if (cleanedPlayers > 0) {
      logger.verbose(`[${this.name}] [Server ${this.serverId}] Cleaned up friendly fire history for ${cleanedPlayers} players.`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeAllListeners('playerKilledEvent');
      this.serverInstance = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.teamkillTracker.clear();
    this.isInitialized = false;
    logger.verbose(`[${this.name}] Cleanup completed for Server ${this.serverId || '?'}.`);
  }
}

module.exports = WCS_TKAutokick;
