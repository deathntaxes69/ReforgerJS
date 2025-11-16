// ReforgerJS/reforger-server/plugins/SeedTrackerBasic.js
const mysql = require("mysql2/promise");

class SeedTrackerBasic {
  constructor(config) {
    this.config = config;
    this.name = "SeedTrackerBasic Plugin";
    this.interval = null;
    this.intervalMinutes = 5;
    this.seedStart = 5;
    this.seedEnd = 40;
    this.serverInstance = null;
    this.serverId = null; // To store the server ID
  }

async prepareToMount(serverInstance) {
  await this.cleanup();
  this.serverInstance = serverInstance;
  // Get the server ID from the instance's scoped config
  this.serverId = this.serverInstance.config.server.id || null;

  try {
    if (!this.config?.connectors?.mysql?.enabled || !process.mysqlPool) {
      logger.warn(`[${this.name}] MySQL is not enabled. Plugin will be disabled for Server ${this.serverId || '?'}.`);
      return;
    }

    if (!this.serverId) {
      logger.error(`[${this.name}] Server ID is missing. Plugin will be disabled.`);
      return;
    }

    const pluginConfig = this.config.plugins.find(
      (plugin) => plugin.plugin === "SeedTrackerBasic"
    );
    if (!pluginConfig || !pluginConfig.enabled) {
      logger.verbose(`[${this.name}] Plugin is disabled in config for Server ${this.serverId}.`);
      return;
    }

    this.intervalMinutes =
      typeof pluginConfig.interval === "number" && pluginConfig.interval > 0
        ? pluginConfig.interval
        : this.intervalMinutes;
    this.seedStart =
      typeof pluginConfig.seedStart === "number" ? pluginConfig.seedStart : this.seedStart;
    this.seedEnd =
      typeof pluginConfig.seedEnd === "number" ? pluginConfig.seedEnd : this.seedEnd;

    await this.setupSchema();
    await this.migrateSchema();
    this.startTracking();
    logger.info(`[${this.name}] Initialized successfully for Server ${this.serverId}. Tracking between ${this.seedStart} and ${this.seedEnd} players.`);
  } catch (error) {
    logger.error(`[${this.name}] Error during initialization for Server ${this.serverId}: ${error.message}`);
  }
}

  async setupSchema() {
  // Updated schema:
  // 1. Added server_id
  // 2. Replaced playerUID UNIQUE with a composite unique key (playerUID, server_id)
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS seed_tracker (
      id INT AUTO_INCREMENT PRIMARY KEY,
      playerName VARCHAR(255) NULL,
      playerUID VARCHAR(255) NOT NULL,
      server_id VARCHAR(255) NULL,
      seedValue INT DEFAULT 0,
      created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY player_server_unique (playerUID, server_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `;

  try {
    const connection = await process.mysqlPool.getConnection();
    await connection.query(createTableQuery);
    connection.release();
    logger.verbose(`[${this.name}] Database schema setup complete for Server ${this.serverId}`);
  } catch (error) {
    logger.error(`[${this.name}] Error setting up schema for Server ${this.serverId}: ${error.message}`);
  }
}

async migrateSchema() {
  try {
    logger.verbose(`[${this.name}] Checking if schema migration is needed for Server ${this.serverId}...`);
    const connection = await process.mysqlPool.getConnection();
    
    // Check for server_id column
    const [columns] = await connection.query(`DESCRIBE seed_tracker`);
    if (!columns.find(c => c.Field === 'server_id')) {
        logger.info(`[${this.name}] Migrating seed_tracker table to add server_id...`);
        await connection.query(`ALTER TABLE seed_tracker ADD COLUMN server_id VARCHAR(255) NULL AFTER playerUID`);
    }

    // Check for and fix the old unique index
    const [indexes] = await connection.query(`
      SELECT INDEX_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seed_tracker' AND NON_UNIQUE = 0
    `);

    const oldUidIndex = indexes.find(i => i.COLUMN_NAME === 'playerUID' && i.INDEX_NAME.toLowerCase() !== 'player_server_unique');
    const compositeIndex = indexes.find(i => i.INDEX_NAME === 'player_server_unique');

    if (oldUidIndex) {
      logger.info(`[${this.name}] Found old unique index '${oldUidIndex.INDEX_NAME}'. Dropping...`);
      await connection.query(`ALTER TABLE seed_tracker DROP INDEX \`${oldUidIndex.INDEX_NAME}\``);
      logger.info(`[${this.name}] Creating new composite unique index 'player_server_unique'`);
      await connection.query(`ALTER TABLE seed_tracker ADD UNIQUE KEY player_server_unique (playerUID, server_id)`);
    } else if (!compositeIndex) {
      logger.info(`[${this.name}] No unique index found. Creating new composite unique index 'player_server_unique'`);
      await connection.query(`ALTER TABLE seed_tracker ADD UNIQUE KEY player_server_unique (playerUID, server_id)`);
    }
    // End of index fix

    // Check charset
    const [tableResult] = await connection.query(`
      SELECT TABLE_COLLATION 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seed_tracker'
    `);
    
    if (tableResult.length > 0 && !tableResult[0].TABLE_COLLATION.startsWith("utf8mb4")) {
      logger.info(`[${this.name}] Migrating seed_tracker table to utf8mb4...`);
      await connection.query(`
        ALTER TABLE seed_tracker CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
    }
    
    connection.release();
    logger.verbose(`[${this.name}] Schema migration check completed for Server ${this.serverId}`);
  } catch (error) {
    logger.error(`[${this.name}] Error during schema migration for Server ${this.serverId}: ${error.message}`);
  }
}

  startTracking() {
    const intervalMs = this.intervalMinutes * 60 * 1000;
    this.trackSeedPlayers();
    this.interval = setInterval(() => this.trackSeedPlayers(), intervalMs);
  }

  async trackSeedPlayers() {
    if (!this.serverInstance) return;
    
    const players = this.serverInstance.players;
    if (!Array.isArray(players) || players.length === 0) {
      return;
    }

    if (players.length < this.seedStart || players.length > this.seedEnd) {
      return; // Not in seeding range
    }

    for (const player of players) {
      if (player?.uid && player?.name) {
        await this.processPlayer(player);
      }
    }
  }

  async processPlayer(player) {
    try {
      // Query using both playerUID AND serverId
      const [rows] = await process.mysqlPool.query(
        "SELECT playerUID FROM seed_tracker WHERE playerUID = ? AND server_id = ?",
        [player.uid, this.serverId]
      );

      if (rows.length > 0) {
        // Update existing record for this server
        await process.mysqlPool.query(
          "UPDATE seed_tracker SET seedValue = seedValue + 1, playerName = ? WHERE playerUID = ? AND server_id = ?",
          [player.name, player.uid, this.serverId]
        );
      } else {
        // Insert new record for this server
        await process.mysqlPool.query(
          "INSERT INTO seed_tracker (playerName, playerUID, server_id, seedValue) VALUES (?, ?, ?, 1)",
          [player.name, player.uid, this.serverId]
        );
      }
    } catch (error) {
        logger.error(`[${this.name}] Error processing player ${player.name} on Server ${this.serverId}: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.serverInstance = null;
  }
}

module.exports = SeedTrackerBasic;
