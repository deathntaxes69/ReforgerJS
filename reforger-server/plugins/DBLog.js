// ReforgerJS/reforger-server/plugins/DBLog.js
const mysql = require("mysql2/promise");

class DBLog {
  constructor(config) {
    this.config = config;
    this.name = "DBLog Plugin";
    this.interval = null;
    this.logIntervalMinutes = 5;
    this.isInitialized = false;
    this.serverInstance = null;
    this.playerCache = new Map();
    this.cacheTTL = 10 * 60 * 1000;
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
        (plugin) => plugin.plugin === "DBLog"
      );
      if (
        pluginConfig &&
        typeof pluginConfig.interval === "number" &&
        pluginConfig.interval > 0
      ) {
        this.logIntervalMinutes = pluginConfig.interval;
      }

      await this.setupSchema();
      await this.migrateSchema();
      this.startLogging();
      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized for Server ${this.serverId}. Logging every ${this.logIntervalMinutes} min.`);
    } catch (error) {
      logger.error(`[${this.name}] Error initializing DBLog for Server ${this.serverId}: ${error.message}`);
    }
  }

  async setupSchema() {
    // Updated schema:
    // 1. playerUID is NO LONGER unique by itself
    // 2. Added server_id
    // 3. Added a composite unique key for (playerUID, server_id)
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS players (
      id INT AUTO_INCREMENT PRIMARY KEY,
      playerName VARCHAR(255) NULL,
      playerIP VARCHAR(255) NULL,
      playerUID VARCHAR(255) NOT NULL,
      beGUID VARCHAR(255) NULL,
      steamID VARCHAR(255) NULL,
      device VARCHAR(50) NULL,
      server_id VARCHAR(255) NULL,
      created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY player_server_unique (playerUID, server_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
    } catch (error) {
      throw error;
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

      const columnNames = columns.map((col) => col.COLUMN_NAME);
      const alterQueries = [];

      if (!columnNames.includes("steamID")) {
        alterQueries.push("ADD COLUMN steamID VARCHAR(255) NULL");
      }

      if (!columnNames.includes("device")) {
        alterQueries.push("ADD COLUMN device VARCHAR(50) NULL");
      }
      
      if (!columnNames.includes("server_id")) {
        alterQueries.push("ADD COLUMN server_id VARCHAR(255) NULL");
      }

      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE players ${alterQueries.join(", ")}`;
        await connection.query(alterQuery);
        logger.info(
          `[${this.name}] Migrated players table with new columns: ${alterQueries.join(
            ", "
          )}`
        );
      }

      // Check for and fix the old unique index
      const [indexes] = await connection.query(`
        SELECT INDEX_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players' AND NON_UNIQUE = 0
      `);

      const oldUidIndex = indexes.find(i => i.COLUMN_NAME === 'playerUID' && i.INDEX_NAME.toLowerCase() !== 'player_server_unique');
      const compositeIndex = indexes.find(i => i.INDEX_NAME === 'player_server_unique');

      if (oldUidIndex) {
        logger.info(`[${this.name}] Found old unique index '${oldUidIndex.INDEX_NAME}'. Dropping...`);
        await connection.query(`ALTER TABLE players DROP INDEX \`${oldUidIndex.INDEX_NAME}\``);
        logger.info(`[${this.name}] Creating new composite unique index 'player_server_unique'`);
        await connection.query(`ALTER TABLE players ADD UNIQUE KEY player_server_unique (playerUID, server_id)`);
      } else if (!compositeIndex) {
        logger.info(`[${this.name}] No unique index found. Creating new composite unique index 'player_server_unique'`);
        await connection.query(`ALTER TABLE players ADD UNIQUE KEY player_server_unique (playerUID, server_id)`);
      }
      // End of index fix

      const [tableResult] = await connection.query(`
      SELECT TABLE_COLLATION 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
    `);

      if (
        tableResult.length > 0 &&
        !tableResult[0].TABLE_COLLATION.startsWith("utf8mb4")
      ) {
        logger.info(`[${this.name}] Migrating players table to utf8mb4...`);
        await connection.query(`
        ALTER TABLE players CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      }

      connection.release();
    } catch (error) {
      logger.error(`[${this.name}] Error migrating schema: ${error.message}`);
      throw error;
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    this.logPlayers();
    this.interval = setInterval(() => this.logPlayers(), intervalMs);
  }

  async logPlayers() {
    const players = this.serverInstance.players;

    if (!Array.isArray(players) || players.length === 0) {
      return;
    }

    for (const player of players) {
      await this.processPlayer(player);
    }
  }

  async processPlayer(player) {
    if (!player.uid) {
      return;
    }

    try {
      if (player.device === "Console" && player.steamID) {
        logger.warn(
          `[${this.name}] Unexpected: Console player ${player.name} has a steamID: ${player.steamID}. This shouldn't happen.`
        );
      }

      const cacheKey = `${player.uid}-${this.serverId}`;
      if (this.playerCache.has(cacheKey)) {
        const cachedPlayer = this.playerCache.get(cacheKey);

        if (
          cachedPlayer.name === player.name &&
          cachedPlayer.ip === player.ip &&
          cachedPlayer.beGUID === player.beGUID &&
          cachedPlayer.steamID === player.steamID &&
          cachedPlayer.device === player.device
        ) {
          return;
        }
      }

      // Query using both playerUID AND serverId
      const [rows] = await process.mysqlPool.query(
        "SELECT * FROM players WHERE playerUID = ? AND server_id = ?",
        [player.uid, this.serverId]
      );

      if (rows.length > 0) {
        const dbPlayer = rows[0];
        let needsUpdate = false;
        const updateFields = {};

        if (dbPlayer.playerName !== player.name) {
          updateFields.playerName = player.name || null;
          needsUpdate = true;
        }
        if (player.ip && dbPlayer.playerIP !== player.ip) {
          updateFields.playerIP = player.ip;
          needsUpdate = true;
        }
        if (player.beGUID && dbPlayer.beGUID !== player.beGUID) {
          updateFields.beGUID = player.beGUID;
          needsUpdate = true;
        }
        if (
          player.steamID !== undefined &&
          dbPlayer.steamID !== player.steamID
        ) {
          updateFields.steamID = player.steamID;
          needsUpdate = true;
        }
        if (player.device !== undefined && dbPlayer.device !== player.device) {
          updateFields.device = player.device;
          needsUpdate = true;
        }

        if (needsUpdate) {
          const setClause = Object.keys(updateFields)
            .map((field) => `${field} = ?`)
            .join(", ");
          const values = Object.values(updateFields);
          values.push(player.uid);
          values.push(this.serverId); // Add serverId to the WHERE clause

          const updateQuery = `UPDATE players SET ${setClause} WHERE playerUID = ? AND server_id = ?`;
          await process.mysqlPool.query(updateQuery, values);
        }
      } else {
        // Insert new record with serverId
        const insertQuery = `
          INSERT INTO players (playerName, playerIP, playerUID, beGUID, steamID, device, server_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        await process.mysqlPool.query(insertQuery, [
          player.name || null,
          player.ip || null,
          player.uid,
          player.beGUID || null,
          player.steamID !== undefined ? player.steamID : null,
          player.device || null,
          this.serverId, // Add the serverId
        ]);
      }

      // Update the cache
      this.playerCache.set(cacheKey, {
        name: player.name,
        ip: player.ip,
        beGUID: player.beGUID,
        steamID: player.steamID,
        device: player.device,
      });

      setTimeout(() => {
        this.playerCache.delete(cacheKey);
      }, this.cacheTTL);
    } catch (error) {
      logger.error(`[${this.name}] Error processing player ${player.name} on Server ${this.serverId}: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.playerCache.clear();
  }
}

module.exports = DBLog;
