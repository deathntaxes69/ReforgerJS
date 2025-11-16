// ReforgerJS/reforger-server/plugins/WCS_DBEvents.js
const mysql = require("mysql2/promise");

class WCS_DBEvents {
  constructor(config) {
    this.config = config;
    this.name = "WCS_DBEvents Plugin";
    this.isInitialized = false;
    this.serverInstance = null;
    this.serverId = null; 
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

      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "WCS_DBEvents");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.verbose(`[${this.name}] Plugin is disabled in configuration for Server ${this.serverId}.`);
        return;
      }

      await this.setupSchema();
      await this.migrateSchema(); // Add migration step

      this.setupEventListeners();

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized successfully for Server ${this.serverId} and listening for WCS events.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization for Server ${this.serverId}: ${error.message}`);
    }
  }

  async setupSchema() {
    try {
      const connection = await process.mysqlPool.getConnection();

      // Note: Original file used 'wcs_chat', 'wcs_gm', 'wcs_playerkills'
      // The command files 'messagehistory' and 'killhistory' use 'rjs_chat' and 'rjs_playerkills'
      // This is a major discrepancy in the original code.
      // We will assume the command files are correct and use 'rjs_chat' and 'rjs_playerkills'.
      // We will also create 'rjs_gm' for consistency.

      const createChatTable = `
        CREATE TABLE IF NOT EXISTS rjs_chat (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_id VARCHAR(255) NULL,
          timestamp BIGINT NOT NULL,
          playerId INT NOT NULL,
          playerName VARCHAR(255) NULL,
          playerBiId VARCHAR(255) NULL,
          channelId INT NOT NULL,
          channelType VARCHAR(50) NULL,
          message TEXT NULL,
          created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_timestamp (timestamp),
          INDEX idx_server_player (server_id, playerBiId),
          INDEX idx_channel (channelId)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      `;

      const createGMTable = `
        CREATE TABLE IF NOT EXISTS rjs_gm (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_id VARCHAR(255) NULL,
          timestamp BIGINT NOT NULL,
          playerId INT NOT NULL,
          playerName VARCHAR(255) NULL,
          playerGUID VARCHAR(255) NULL,
          action VARCHAR(255) NULL,
          actionType VARCHAR(255) NULL,
          hoveredEntityComponentName TEXT NULL,
          hoveredEntityComponentOwnerId INT NULL,
          selectedEntityNames TEXT NULL,
          selectedEntityOwnerIds TEXT NULL,
          selectedEntityComponentsNames TEXT NULL,
          selectedEntityComponentsOwnersIds TEXT NULL,
          created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_timestamp (timestamp),
          INDEX idx_server_player (server_id, playerGUID),
          INDEX idx_action (action)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      `;

      const createKillsTable = `
        CREATE TABLE IF NOT EXISTS rjs_playerkills (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_id VARCHAR(255) NULL,
          timestamp BIGINT NOT NULL,
          killerId INT NOT NULL,
          killerName VARCHAR(255) NULL,
          killerBiId VARCHAR(255) NULL,
          killerControl VARCHAR(100) NULL,
          killerControlType VARCHAR(100) NULL,
          killerDisguise VARCHAR(100) NULL,
          victimId INT NOT NULL,
          victimName VARCHAR(255) NULL,
          victimBiId VARCHAR(255) NULL,
          victimControl VARCHAR(100) NULL,
          victimControlType VARCHAR(100) NULL,
          victimDisguise VARCHAR(100) NULL,
          friendlyFire BOOLEAN DEFAULT FALSE,
          teamKill BOOLEAN DEFAULT FALSE,
          weapon VARCHAR(255) NULL,
          weaponSource VARCHAR(100) NULL,
          weaponSourceType VARCHAR(100) NULL,
          distance FLOAT DEFAULT 0,
          killType VARCHAR(100) NULL,
          instigatorType VARCHAR(100) NULL,
          created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_timestamp (timestamp),
          INDEX idx_server_killer (server_id, killerBiId),
          INDEX idx_server_victim (server_id, victimBiId),
          INDEX idx_kill_type (killType),
          INDEX idx_friendly_fire (friendlyFire)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      `;

      await connection.query(createChatTable);
      await connection.query(createGMTable);
      await connection.query(createKillsTable);

      connection.release();
      logger.info(`[${this.name}] Database schema setup complete - ensured rjs_chat, rjs_gm, and rjs_playerkills tables.`);
    } catch (error) {
      logger.error(`[${this.name}] Error setting up database schema: ${error.message}`);
      throw error;
    }
  }
  
  async migrateSchema() {
    // This function checks and adds server_id if it's missing from old tables
    try {
      const connection = await process.mysqlPool.getConnection();
      const tables = ['rjs_chat', 'rjs_gm', 'rjs_playerkills'];
      
      for (const table of tables) {
        try {
          const [columns] = await connection.query(`DESCRIBE ${table}`);
          if (!columns.find(c => c.Field === 'server_id')) {
            logger.info(`[${this.name}] Migrating ${table} table to add server_id...`);
            await connection.query(`ALTER TABLE ${table} ADD COLUMN server_id VARCHAR(255) NULL FIRST`);
          }
          
          // Check charset
          const [tableResult] = await connection.query(`SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
          if (tableResult.length > 0 && !tableResult[0].TABLE_COLLATION.startsWith("utf8mb4")) {
            logger.info(`[${this.name}] Migrating ${table} table to utf8mb4...`);
            await connection.query(`ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          }
        } catch (tableError) {
          if (tableError.code === 'ER_NO_SUCH_TABLE') {
             // This is fine, setupSchema will create it
             logger.verbose(`[${this.name}] Table ${table} does not exist, will be created.`);
          } else {
             logger.error(`[${this.name}] Error migrating ${table}: ${tableError.message}`);
          }
        }
      }
      
      connection.release();
      logger.verbose(`[${this.name}] Schema migration check completed for Server ${this.serverId}`);
    } catch (error) {
      logger.error(`[${this.name}] Error during schema migration: ${error.message}`);
    }
  }

  setupEventListeners() {
    this.serverInstance.on('chatMessageEvent', this.handleChatMessage.bind(this));
    this.serverInstance.on('editorActionEvent', this.handleEditorAction.bind(this));
    this.serverInstance.on('playerKilledEvent', this.handlePlayerKilled.bind(this));
  }

  async handleChatMessage(data) {
    if (!data || !data.timestamp) {
      logger.warn(`[${this.name}] Received incomplete chatMessageEvent data on Server ${this.serverId}`);
      return;
    }
    
    // Ensure data.serverId from the event matches this instance's serverId
    if (data.serverId !== this.serverId) {
      logger.warn(`[${this.name}] Mismatched serverId in chatMessageEvent. Instance: ${this.serverId}, Event: ${data.serverId}. Ignoring.`);
      return;
    }

    try {
      const insertQuery = `
        INSERT INTO rjs_chat (
          server_id, timestamp, playerId, playerName, playerBiId, channelId, channelType, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await process.mysqlPool.query(insertQuery, [
        this.serverId,
        data.timestamp,
        data.playerId || 0,
        data.playerName || null,
        data.playerGUID || null, // Renaming playerGUID from event to playerBiId in DB
        data.channelId || 0,
        data.channelType || null,
        data.message || null
      ]);

      logger.verbose(`[${this.name}] Stored chat message from ${data.playerName} in channel ${data.channelType} (Server: ${this.serverId})`);
    } catch (error) {
      logger.error(`[${this.name}] Error storing chat message: ${error.message}`);
    }
  }

  async handleEditorAction(data) {
    if (!data || !data.timestamp) {
      logger.warn(`[${this.name}] Received incomplete editorActionEvent data on Server ${this.serverId}`);
      return;
    }

    if (data.serverId !== this.serverId) {
      logger.warn(`[${this.name}] Mismatched serverId in editorActionEvent. Instance: ${this.serverId}, Event: ${data.serverId}. Ignoring.`);
      return;
    }

    try {
      const insertQuery = `
        INSERT INTO rjs_gm (
          server_id, timestamp, playerId, playerName, playerGUID, action, actionType,
          hoveredEntityComponentName, hoveredEntityComponentOwnerId,
          selectedEntityNames, selectedEntityOwnerIds,
          selectedEntityComponentsNames, selectedEntityComponentsOwnersIds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await process.mysqlPool.query(insertQuery, [
        this.serverId,
        data.timestamp,
        data.playerId || 0,
        data.playerName || null,
        data.playerGUID || null,
        data.action || null,
        data.actionType || null,
        data.hoveredEntityComponentName || null,
        data.hoveredEntityComponentOwnerId || null,
        data.selectedEntityNames ? JSON.stringify(data.selectedEntityNames) : null,
        data.selectedEntityOwnerIds ? JSON.stringify(data.selectedEntityOwnerIds) : null,
        data.raw?.selectedEntityComponentsNames || null,
        data.raw?.selectedEntityComponentsOwnersIds || null
      ]);

      logger.verbose(`[${this.name}] Stored GM action: ${data.playerName} performed ${data.actionType} (Server: ${this.serverId})`);
    } catch (error) {
      logger.error(`[${this.name}] Error storing editor action: ${error.message}`);
    }
  }

  async handlePlayerKilled(data) {
    if (!data || !data.timestamp) {
      logger.warn(`[${this.name}] Received incomplete playerKilledEvent data on Server ${this.serverId}`);
      return;
    }
    
    if (data.serverId !== this.serverId) {
      logger.warn(`[${this.name}] Mismatched serverId in playerKilledEvent. Instance: ${this.serverId}, Event: ${data.serverId}. Ignoring.`);
      return;
    }

    try {
      const insertQuery = `
        INSERT INTO rjs_playerkills (
          server_id, timestamp, killerId, killerName, killerBiId, killerControl, killerControlType, killerDisguise,
          victimId, victimName, victimBiId, victimControl, victimControlType, victimDisguise,
          friendlyFire, teamKill, weapon, weaponSource, weaponSourceType, distance, killType, instigatorType
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await process.mysqlPool.query(insertQuery, [
        this.serverId,
        data.timestamp,
        data.killer?.id || -1,
        data.killer?.name || null,
        data.killer?.guid || null, // Renaming guid to killerBiId
        data.killer?.control || null,
        data.killer?.controlType || null,
        data.killer?.disguise || null,
        data.victim?.id || -1,
        data.victim?.name || null,
        data.victim?.guid || null, // Renaming guid to victimBiId
        data.victim?.control || null,
        data.victim?.controlType || null,
        data.victim?.disguise || null,
        data.kill?.friendlyFire || false,
        data.kill?.teamKill || false,
        data.kill?.weapon || null,
        data.kill?.weaponSource || null,
        data.kill?.weaponSourceType || null,
        data.kill?.distance || 0,
        data.kill?.type || null,
        data.kill?.instigatorType || null
      ]);

      logger.verbose(`[${this.name}] Stored kill: ${data.killer?.name} killed ${data.victim?.name} (${data.kill?.type}) (Server: ${this.serverId})`);
    } catch (error) {
      logger.error(`[${this.name}] Error storing player kill: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeAllListeners('chatMessageEvent');
      this.serverInstance.removeAllListeners('editorActionEvent');
      this.serverInstance.removeAllListeners('playerKilledEvent');
      this.serverInstance = null;
    }
    this.isInitialized = false;
    this.serverId = null;
    logger.verbose(`[${this.name}] Cleanup completed for Server ${this.serverId || '?'}.`);
  }
}

module.exports = WCS_DBEvents;
