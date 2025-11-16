// ReforgerJS/reforger-server/plugins/VoteLogs.js
const mysql = require("mysql2/promise");

class VoteLogs {
  constructor(config) {
    this.config = config;
    this.name = "VoteLogs Plugin";
    this.isInitialized = false;
    this.serverInstance = null;
    this.serverId = null; // To store the server ID
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
        return;
      }

      if (!process.mysqlPool) {
        return;
      }
      
      if (!this.serverId) {
        logger.error(`[${this.name}] Server ID is missing. Plugin will be disabled.`);
        return;
      }

      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "VoteLogs"
      );
      if (!pluginConfig || !pluginConfig.enabled) {
        return;
      }

      await this.setupSchema();
      await this.migrateSchema();

      this.serverInstance.on(
        "voteKickStart",
        this.handleVoteKickStart.bind(this)
      );
      this.serverInstance.on(
        "voteKickVictim",
        this.handleVoteKickVictim.bind(this)
      );

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized successfully for Server ${this.serverId}`);
    } catch (error) {
      logger.error(
        `[${this.name}] Error during initialization for Server ${this.serverId}: ${error.message}`
      );
    }
  }

  async setupSchema() {
    const createVoteOffendersTable = `
    CREATE TABLE IF NOT EXISTS VoteOffenders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      server_id VARCHAR(255) NULL,
      offenderName VARCHAR(255) NULL,
      offenderUID VARCHAR(255) NULL,
      victimName VARCHAR(255) NULL,
      victimUID VARCHAR(255) NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_server_offender (server_id, offenderUID),
      INDEX idx_server_victim (server_id, victimUID)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `;

    const createVoteVictimsTable = `
    CREATE TABLE IF NOT EXISTS VoteVictims (
      id INT AUTO_INCREMENT PRIMARY KEY,
      server_id VARCHAR(255) NULL,
      victimName VARCHAR(255) NULL,
      victimUID VARCHAR(255) NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_server_victim (server_id, victimUID)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createVoteOffendersTable);
      await connection.query(createVoteVictimsTable);
      connection.release();
      logger.verbose(`[${this.name}] Database schema setup complete`);
    } catch (error) {
      logger.error(`[${this.name}] Error setting up schema: ${error.message}`);
      throw error;
    }
  }

  async migrateSchema() {
    try {
      logger.verbose(
        `[${this.name}] Checking if schema migration is needed...`
      );
      const connection = await process.mysqlPool.getConnection();

      // Check VoteOffenders table
      const [offendersCols] = await connection.query(`DESCRIBE VoteOffenders`);
      if (!offendersCols.find(c => c.Field === 'server_id')) {
        logger.info(`[${this.name}] Migrating VoteOffenders table to add server_id...`);
        await connection.query(`ALTER TABLE VoteOffenders ADD COLUMN server_id VARCHAR(255) NULL AFTER id, ADD INDEX idx_server_offender (server_id, offenderUID), ADD INDEX idx_server_victim (server_id, victimUID)`);
      }

      // Check VoteVictims table
      const [victimsCols] = await connection.query(`DESCRIBE VoteVictims`);
      if (!victimsCols.find(c => c.Field === 'server_id')) {
        logger.info(`[${this.name}] Migrating VoteVictims table to add server_id...`);
        await connection.query(`ALTER TABLE VoteVictims ADD COLUMN server_id VARCHAR(255) NULL AFTER id, ADD INDEX idx_server_victim (server_id, victimUID)`);
      }

      // Check charsets
      const [offendersResult] = await connection.query(`SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'VoteOffenders'`);
      const [victimsResult] = await connection.query(`SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'VoteVictims'`);

      if (offendersResult.length > 0 && !offendersResult[0].TABLE_COLLATION.startsWith("utf8mb4")) {
        logger.info(`[${this.name}] Migrating VoteOffenders table to utf8mb4...`);
        await connection.query(`ALTER TABLE VoteOffenders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      }

      if (victimsResult.length > 0 && !victimsResult[0].TABLE_COLLATION.startsWith("utf8mb4")) {
        logger.info(`[${this.name}] Migrating VoteVictims table to utf8mb4...`);
        await connection.query(`ALTER TABLE VoteVictims CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      }

      connection.release();
      logger.verbose(`[${this.name}] Schema migration check completed.`);
    } catch (error) {
      logger.error(
        `[${this.name}] Error during schema migration: ${error.message}`
      );
    }
  }

  findPlayerUID(playerName, playerId) {
    if (
      !this.serverInstance ||
      !this.serverInstance.players ||
      !Array.isArray(this.serverInstance.players)
    ) {
      return null;
    }
    
    // Find player on THIS server instance
    const player = this.serverInstance.players.find(
      (p) => p.name === playerName && p.id?.toString() === playerId?.toString()
    );

    if (player && player.uid) {
      logger.verbose(
        `[${this.name}] Found player ${playerName} with exact match by name and ID on Server ${this.serverId}`
      );
      return player.uid;
    }

    // Fallback match by name only on this server
    const playerByName = this.serverInstance.players.find(
      (p) => p.name === playerName
    );
    if (playerByName && playerByName.uid) {
      logger.verbose(`[${this.name}] Found player ${playerName} by name only on Server ${this.serverId}`);
      return playerByName.uid;
    }

    // Fallback match by ID only on this server
    const playerById = this.serverInstance.players.find(
      (p) => p.id?.toString() === playerId?.toString()
    );
    if (playerById && playerById.uid) {
      logger.verbose(`[${this.name}] Found player with ID ${playerId} by ID only on Server ${this.serverId}`);
      return playerById.uid;
    }

    logger.warn(
      `[${this.name}] Could not find UID for player name: ${playerName}, ID: ${playerId} on Server ${this.serverId}`
    );
    return null;
  }

  async handleVoteKickStart(data) {
    if (!data || !data.voteOffenderName || !data.voteVictimName) {
      logger.warn(`[${this.name}] Insufficient data for vote kick start logging on Server ${this.serverId}`);
      return;
    }

    try {
      const offenderName = data.voteOffenderName || null;
      const offenderId = data.voteOffenderId || null;
      const victimName = data.voteVictimName || null;
      const victimId = data.voteVictimId || null;

      const offenderUID = this.findPlayerUID(offenderName, offenderId);
      const victimUID = this.findPlayerUID(victimName, victimId);

      const insertQuery = `
        INSERT INTO VoteOffenders 
        (server_id, offenderName, offenderUID, victimName, victimUID)
        VALUES (?, ?, ?, ?, ?);
      `;

      await process.mysqlPool.query(insertQuery, [
        this.serverId,
        offenderName,
        offenderUID,
        victimName,
        victimUID,
      ]);

      logger.info(
        `[${this.name}] Vote kick initiated by ${offenderName} against ${victimName} logged to database for Server ${this.serverId}`
      );
    } catch (error) {
      logger.error(`[${this.name}] Error logging vote kick start for Server ${this.serverId}: ${error}`);
    }
  }

  async handleVoteKickVictim(data) {
    if (!data || !data.voteVictimName) {
      logger.warn(`[${this.name}] Insufficient data for vote kick victim logging on Server ${this.serverId}`);
      return;
    }

    try {
      const victimName = data.voteVictimName || null;
      const victimId = data.voteVictimId || null;

      const victimUID = this.findPlayerUID(victimName, victimId);

      if (victimName) {
        const insertQuery = `
          INSERT INTO VoteVictims 
          (server_id, victimName, victimUID)
          VALUES (?, ?, ?);
        `;

        await process.mysqlPool.query(insertQuery, [
          this.serverId,
          victimName, 
          victimUID
        ]);

        logger.info(
          `[${this.name}] Vote kick succeeded against ${victimName} logged to database for Server ${this.serverId}`
        );
      }
    } catch (error) {
      logger.error(`[${this.name}] Error logging vote kick victim for Server ${this.serverId}: ${error}`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeAllListeners("voteKickStart");
      this.serverInstance.removeAllListeners("voteKickVictim");
      this.serverInstance = null;
    }
    this.isInitialized = false;
    logger.verbose(`[${this.name}] VoteLogs plugin cleanup complete for Server ${this.serverId || '?'}`);
  }
}

module.exports = VoteLogs;
