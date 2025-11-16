// ReforgerJS/reforger-server/plugins/WCS_DBLog.js
const mysql = require("mysql2/promise");

class WCS_DBLog {
  constructor(config) {
    this.config = config;
    this.name = "WCS_DBLog Plugin";
    this.isInitialized = false;
    this.serverInstance = null;
    this.serverId = null; // To store the server ID
    this.playerCache = new Map();
    this.cacheTTL = 10 * 60 * 1000;
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    // Get the server ID from the instance's scoped config
    this.serverId = this.serverInstance.config.server.id || null; 

    try {
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
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

      const dbLogPlugin = this.config.plugins.find(plugin => plugin.plugin === "DBLog");
      if (!dbLogPlugin || !dbLogPlugin.enabled) {
        logger.error(`[${this.name}] DBLog plugin must be enabled for WCS_DBLog to work. Plugin will be disabled for Server ${this.serverId}.`);
        return;
      }

      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "WCS_DBLog");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.verbose(`[${this.name}] Plugin is disabled in configuration for Server ${this.serverId}.`);
        return;
      }

      if (!(await this.checkPlayersTable())) {
        logger.error(`[${this.name}] 'players' table not found. DBLog plugin must run first to create the table. Plugin will be disabled for Server ${this.serverId}.`);
        return;
      }

      await this.migrateSchema();

      this.setupEventListeners();

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized successfully for Server ${this.serverId} and listening for WCS events.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization for Server ${this.serverId}: ${error.message}`);
    }
  }

  async checkPlayersTable() {
    try {
      const connection = await process.mysqlPool.getConnection();
      const [tables] = await connection.query(`SHOW TABLES LIKE 'players'`);
      connection.release();
      return tables.length > 0;
    } catch (error) {
      logger.error(`[${this.name}] Error checking for 'players' table: ${error.message}`);
      return false;
    }
  }

  async migrateSchema() {
    try {
      const connection = await process.mysqlPool.getConnection();

      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'players'
      `);

      const columnNames = columns.map(col => col.COLUMN_NAME);
      const alterQueries = [];

      if (!columnNames.includes('profileName')) {
        alterQueries.push('ADD COLUMN profileName VARCHAR(255) NULL');
      }

      if (!columnNames.includes('platform')) {
        alterQueries.push('ADD COLUMN platform VARCHAR(100) NULL');
      }

      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE players ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);
        logger.info(`[${this.name}] Migrated players table with new columns: ${alterQueries.join(', ')}`);
      } else {
        logger.verbose(`[${this.name}] Players table already has WCS columns.`);
      }

      connection.release();
    } catch (error) {
      logger.error(`[${this.name}] Error migrating schema: ${error.message}`);
      throw error;
    }
  }

  setupEventListeners() {
    this.serverInstance.on('playerConnectedEvent', this.handlePlayerConnected.bind(this));
  }

  async handlePlayerConnected(data) {
    if (!data || !data.playerGUID || !data.playerName) {
      logger.warn(`[${this.name}] Received incomplete playerConnectedEvent data on Server ${this.serverId}`);
      return;
    }

    // This event comes from a custom log parser which should have added the serverId.
    // But we will trust our instance's serverId more.
    const currentServerId = this.serverId;

    try {
      const playerUID = data.playerGUID;
      const playerName = data.playerName;
      const profileName = data.profileName || null;
      const platform = data.platform || null;

      const cacheKey = `${playerUID}_${profileName}_${platform}_${currentServerId}`;
      if (this.playerCache.has(cacheKey)) {
        logger.verbose(`[${this.name}] Player ${playerName} WCS data already cached, skipping update on Server ${currentServerId}`);
        return;
      }

      // Query using both playerUID AND serverId
      const [rows] = await process.mysqlPool.query(
        "SELECT * FROM players WHERE playerUID = ? AND server_id = ?",
        [playerUID, currentServerId]
      );

      if (rows.length > 0) {
        const dbPlayer = rows[0];
        let needsUpdate = false;
        const updateFields = {};

        if (dbPlayer.profileName !== profileName) {
          updateFields.profileName = profileName;
          needsUpdate = true;
        }

        if (dbPlayer.platform !== platform) {
          updateFields.platform = platform;
          needsUpdate = true;
        }

        if (dbPlayer.playerName !== playerName) {
          updateFields.playerName = playerName;
          needsUpdate = true;
        }

        if (needsUpdate) {
          const setClause = Object.keys(updateFields)
            .map(field => `${field} = ?`)
            .join(', ');
          const values = Object.values(updateFields);
          values.push(playerUID);
          values.push(currentServerId); // Add serverId to the WHERE clause

          const updateQuery = `UPDATE players SET ${setClause} WHERE playerUID = ? AND server_id = ?`;
          await process.mysqlPool.query(updateQuery, values);

          logger.info(`[${this.name}] Updated WCS data for player ${playerName} (${playerUID}) on Server ${currentServerId}`);
        } else {
          logger.verbose(`[${this.name}] No WCS data update needed for player ${playerName} on Server ${currentServerId}`);
        }
      } else {
        // This player doesn't have a record in the 'players' table *for this server* yet.
        // This can happen if the WCS event fires before the DBLog plugin has run.
        // We will insert a new record.
        const insertQuery = `
          INSERT INTO players (playerName, playerUID, profileName, platform, server_id)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
          playerName=VALUES(playerName), profileName=VALUES(profileName), platform=VALUES(platform)
        `;
        await process.mysqlPool.query(insertQuery, [
          playerName,
          playerUID,
          profileName,
          platform,
          currentServerId
        ]);

        logger.info(`[${this.name}] Created new player record for ${playerName} (${playerUID}) on Server ${currentServerId} with WCS data`);
      }

      this.playerCache.set(cacheKey, true);
      setTimeout(() => {
        this.playerCache.delete(cacheKey);
      }, this.cacheTTL);

    } catch (error) {
      logger.error(`[${this.name}] Error handling playerConnectedEvent for ${data.playerName} on Server ${currentServerId}: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeAllListeners('playerConnectedEvent');
      this.serverInstance = null;
    }
    this.playerCache.clear();
    this.isInitialized = false;
    logger.verbose(`[${this.name}] Cleanup completed for Server ${this.serverId || '?'}.`);
  }
}

module.exports = WCS_DBLog;
