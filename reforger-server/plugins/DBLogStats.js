const mysql = require("mysql2/promise");
const fs = require("fs").promises;
const pathModule = require("path");
const SftpClient = require('ssh2-sftp-client');
const logger = global.logger || console;

class DBLogStats {
  constructor(config) {
    this.config = config;
    this.name = "DBLogStats Plugin";
    this.interval = null;
    this.logIntervalMinutes = 15; 
    this.serverInstance = null;
    this.folderPath = null;
    this.tableName = null;
    this.serverId = null;
    this.isRemote = false;
  }

  async prepareToMount(serverInstance) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.serverId = this.serverInstance.config.server.id || null;

    try {
      if (!this.config.connectors?.mysql?.enabled || !process.mysqlPool) {
        logger.warn(`[${this.name}] MySQL is not enabled. Plugin disabled.`);
        return;
      }

      if (!this.serverId) {
        logger.error(`[${this.name}] Server ID missing. Plugin disabled.`);
        return;
      }

      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "DBLogStats");
      if (!pluginConfig || !pluginConfig.enabled) {
        return;
      }

      if (typeof pluginConfig.interval === "number" && pluginConfig.interval > 0) {
        this.logIntervalMinutes = pluginConfig.interval;
      }

      if (!pluginConfig.path) {
        logger.warn(`[${this.name}] 'path' not specified. Plugin disabled.`);
        return;
      }
      
      this.folderPath = pluginConfig.path;
      this.tableName = pluginConfig.tableName || "player_stats";

      // Check if we should use SFTP based on server config
      const serverConfig = this.serverInstance.config.server;
      if (serverConfig.logReaderMode === 'sftp' || serverConfig.sftp) {
          this.isRemote = true;
          logger.info(`[${this.name}] Mode: SFTP Remote Access (Path: ${this.folderPath})`);
      } else {
          // Local mode check
          try {
            await fs.access(this.folderPath);
            logger.info(`[${this.name}] Mode: Local File Access (Path: ${this.folderPath})`);
          } catch (err) {
            logger.error(`[${this.name}] Local path '${this.folderPath}' not found. Plugin disabled.`);
            return;
          }
      }

      await this.setupSchema();
      await this.migrateSchema();

      this.startLogging();
      logger.info(`[${this.name}] Initialized for Server ${this.serverId}. Logging every ${this.logIntervalMinutes} min.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async setupSchema() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playerUID VARCHAR(255) NOT NULL,
        server_id VARCHAR(255) NULL,
        level FLOAT DEFAULT 0,
        level_experience FLOAT DEFAULT 0,
        session_duration FLOAT DEFAULT 0,
        sppointss0 FLOAT DEFAULT 0,
        sppointss1 FLOAT DEFAULT 0,
        sppointss2 FLOAT DEFAULT 0,
        warcrimes FLOAT DEFAULT 0,
        distance_walked FLOAT DEFAULT 0,
        kills FLOAT DEFAULT 0,
        ai_kills FLOAT DEFAULT 0,
        shots FLOAT DEFAULT 0,
        grenades_thrown FLOAT DEFAULT 0,
        friendly_kills FLOAT DEFAULT 0,
        friendly_ai_kills FLOAT DEFAULT 0,
        deaths FLOAT DEFAULT 0,
        distance_driven FLOAT DEFAULT 0,
        points_as_driver_of_players FLOAT DEFAULT 0,
        players_died_in_vehicle FLOAT DEFAULT 0,
        roadkills FLOAT DEFAULT 0,
        friendly_roadkills FLOAT DEFAULT 0,
        ai_roadkills FLOAT DEFAULT 0,
        friendly_ai_roadkills FLOAT DEFAULT 0,
        distance_as_occupant FLOAT DEFAULT 0,
        bandage_self FLOAT DEFAULT 0,
        bandage_friendlies FLOAT DEFAULT 0,
        tourniquet_self FLOAT DEFAULT 0,
        tourniquet_friendlies FLOAT DEFAULT 0,
        saline_self FLOAT DEFAULT 0,
        saline_friendlies FLOAT DEFAULT 0,
        morphine_self FLOAT DEFAULT 0,
        morphine_friendlies FLOAT DEFAULT 0,
        warcrime_harming_friendlies FLOAT DEFAULT 0,
        crime_acceleration FLOAT DEFAULT 0,
        kick_session_duration FLOAT DEFAULT 0,
        kick_streak FLOAT DEFAULT 0,
        lightban_session_duration FLOAT DEFAULT 0,
        lightban_streak FLOAT DEFAULT 0,
        heavyban_kick_session_duration FLOAT DEFAULT 0,
        heavyban_streak FLOAT DEFAULT 0,
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
      const alterQueries = [];
      const connection = await process.mysqlPool.getConnection();
      
      const [columns] = await connection.query(`DESCRIBE \`${this.tableName}\``);
      const columnNames = columns.map(col => col.Field);
      
      if (!columnNames.includes('server_id')) {
        alterQueries.push('ADD COLUMN server_id VARCHAR(255) NULL AFTER playerUID');
      }
      // Add other columns if missing...
      const optionalCols = ['lightban_session_duration', 'lightban_streak', 'heavyban_kick_session_duration', 'heavyban_streak'];
      optionalCols.forEach(col => {
          if (!columnNames.includes(col)) alterQueries.push(`ADD COLUMN ${col} FLOAT DEFAULT 0`);
      });

      // Check index
      const [indexes] = await connection.query(`SHOW INDEX FROM \`${this.tableName}\``);
      const uidIndex = indexes.find(i => i.Column_name === 'playerUID' && i.Key_name !== 'player_server_unique');
      const compositeIndex = indexes.find(i => i.Key_name === 'player_server_unique');

      if (uidIndex) {
        alterQueries.push(`DROP INDEX \`${uidIndex.Key_name}\``);
        if (!compositeIndex) alterQueries.push('ADD UNIQUE INDEX player_server_unique (playerUID, server_id)');
      } else if (!compositeIndex) {
        alterQueries.push('ADD UNIQUE INDEX player_server_unique (playerUID, server_id)');
      }
      
      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE ${this.tableName} ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);
        logger.info(`[${this.name}] Migrated schema for ${this.tableName}`);
      }
      
      connection.release();
    } catch (error) {
      logger.error(`Error migrating schema: ${error.message}`);
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    this.logStats();
    this.interval = setInterval(() => this.logStats(), intervalMs);
  }

  async getRemoteFiles() {
    const sftp = new SftpClient();
    const playerStatData = {};
    
    try {
        const sftpConfig = this.serverInstance.config.server.sftp;
        await sftp.connect(sftpConfig);
        
        const fileList = await sftp.list(this.folderPath);
        const statFiles = fileList.filter(f => f.type === '-' && /^PlayerData\..+\.json$/.test(f.name));

        if (statFiles.length === 0) {
             logger.verbose(`[${this.name}] No stat files found in remote ${this.folderPath}`);
             await sftp.end();
             return null;
        }

        logger.info(`[${this.name}] Downloading ${statFiles.length} stat files via SFTP...`);

        for (const file of statFiles) {
            const match = /^PlayerData\.(.+)\.json$/.exec(file.name);
            if (!match) continue;
            const playerUID = match[1];
            
            try {
                const buffer = await sftp.get(this.folderPath + '/' + file.name);
                const jsonData = JSON.parse(buffer.toString());
                
                if (jsonData.m_aStats && Array.isArray(jsonData.m_aStats)) {
                    playerStatData[playerUID] = jsonData.m_aStats;
                }
            } catch (err) {
                logger.warn(`[${this.name}] Failed to process remote file ${file.name}: ${err.message}`);
            }
        }
        
        await sftp.end();
        return playerStatData;

    } catch (err) {
        logger.error(`[${this.name}] SFTP Error: ${err.message}`);
        if (sftp) sftp.end(); 
        return null;
    }
  }

  async getLocalFiles() {
      const playerStatData = {};
      const files = await fs.readdir(this.folderPath);
      const statFiles = files.filter(file => /^PlayerData\..+\.json$/.test(file));

      for (const file of statFiles) {
        const match = /^PlayerData\.(.+)\.json$/.exec(file);
        if (!match) continue;
        const playerUID = match[1];
        
        try {
            const content = await fs.readFile(pathModule.join(this.folderPath, file), "utf8");
            const jsonData = JSON.parse(content);
            if (jsonData.m_aStats && Array.isArray(jsonData.m_aStats)) {
                playerStatData[playerUID] = jsonData.m_aStats;
            }
        } catch (err) { /* ignore read errors */ }
      }
      return playerStatData;
  }

  async collectStats() {
    logger.verbose(`[${this.name}] Collecting stats...`);
    
    let rawStats = {};
    if (this.isRemote) {
        rawStats = await this.getRemoteFiles();
    } else {
        rawStats = await this.getLocalFiles();
    }

    if (!rawStats) return null;

    const processedStats = {};
    for (const [uid, statsArray] of Object.entries(rawStats)) {
        if (statsArray.length < 35) continue;
        
        processedStats[uid] = {
          level: statsArray[0],
          level_experience: statsArray[1],
          session_duration: statsArray[2],
          sppointss0: statsArray[3],
          sppointss1: statsArray[4],
          sppointss2: statsArray[5],
          warcrimes: statsArray[6],
          distance_walked: statsArray[7],
          kills: statsArray[8],
          ai_kills: statsArray[9],
          shots: statsArray[10],
          grenades_thrown: statsArray[11],
          friendly_kills: statsArray[12],
          friendly_ai_kills: statsArray[13],
          deaths: statsArray[14],
          distance_driven: statsArray[15],
          points_as_driver_of_players: statsArray[16],
          players_died_in_vehicle: statsArray[17],
          roadkills: statsArray[18],
          friendly_roadkills: statsArray[19],
          ai_roadkills: statsArray[20],
          friendly_ai_roadkills: statsArray[21],
          distance_as_occupant: statsArray[22],
          bandage_self: statsArray[23],
          bandage_friendlies: statsArray[24],
          tourniquet_self: statsArray[25],
          tourniquet_friendlies: statsArray[26],
          saline_self: statsArray[27],
          saline_friendlies: statsArray[28],
          morphine_self: statsArray[29],
          morphine_friendlies: statsArray[30],
          warcrime_harming_friendlies: statsArray[31],
          crime_acceleration: statsArray[32],
          kick_session_duration: statsArray[33],
          kick_streak: statsArray[34],
          lightban_session_duration: statsArray[35] || 0,
          lightban_streak: statsArray[36] || 0,
          heavyban_kick_session_duration: statsArray[37] || 0,
          heavyban_streak: statsArray[38] || 0
        };
    }
    return processedStats;
  }

  async logStats() {
    const playerStatsHash = await this.collectStats();
    if (!playerStatsHash || Object.keys(playerStatsHash).length === 0) {
      return;
    }

    const columns = [
      'playerUID', 'server_id', 'level', 'level_experience', 'session_duration', 
      'sppointss0', 'sppointss1', 'sppointss2', 'warcrimes', 'distance_walked', 
      'kills', 'ai_kills', 'shots', 'grenades_thrown', 'friendly_kills', 
      'friendly_ai_kills', 'deaths', 'distance_driven', 'points_as_driver_of_players', 
      'players_died_in_vehicle', 'roadkills', 'friendly_roadkills', 'ai_roadkills', 
      'friendly_ai_roadkills', 'distance_as_occupant', 'bandage_self', 
      'bandage_friendlies', 'tourniquet_self', 'tourniquet_friendlies', 
      'saline_self', 'saline_friendlies', 'morphine_self', 'morphine_friendlies', 
      'warcrime_harming_friendlies', 'crime_acceleration', 'kick_session_duration', 
      'kick_streak', 'lightban_session_duration', 'lightban_streak', 
      'heavyban_kick_session_duration', 'heavyban_streak'
    ];

    const updateStatements = columns
      .filter(col => col !== 'playerUID' && col !== 'server_id')
      .map(col => `${col} = VALUES(${col})`)
      .join(', ');

    const BATCH_SIZE = 100; 
    const playerEntries = Object.entries(playerStatsHash);
    
    try {
        const connection = await process.mysqlPool.getConnection();
        
        for (let i = 0; i < playerEntries.length; i += BATCH_SIZE) {
          const batch = playerEntries.slice(i, i + BATCH_SIZE);
          const values = [];
          const placeholders = [];
          
          for (const [playerUID, stats] of batch) {
            placeholders.push(`(${Array(columns.length).fill('?').join(', ')})`);
            values.push(
              playerUID,
              this.serverId, // USE THE SERVER ID HERE
              stats.level, stats.level_experience, stats.session_duration,
              stats.sppointss0, stats.sppointss1, stats.sppointss2,
              stats.warcrimes, stats.distance_walked, stats.kills, stats.ai_kills,
              stats.shots, stats.grenades_thrown, stats.friendly_kills, stats.friendly_ai_kills,
              stats.deaths, stats.distance_driven, stats.points_as_driver_of_players,
              stats.players_died_in_vehicle, stats.roadkills, stats.friendly_roadkills,
              stats.ai_roadkills, stats.friendly_ai_roadkills, stats.distance_as_occupant,
              stats.bandage_self, stats.bandage_friendlies, stats.tourniquet_self,
              stats.tourniquet_friendlies, stats.saline_self, stats.saline_friendlies,
              stats.morphine_self, stats.morphine_friendlies, stats.warcrime_harming_friendlies,
              stats.crime_acceleration, stats.kick_session_duration, stats.kick_streak,
              stats.lightban_session_duration, stats.lightban_streak,
              stats.heavyban_kick_session_duration, stats.heavyban_streak
            );
          }
          
          if (values.length > 0) {
              const query = `
                INSERT INTO ${this.tableName} (${columns.join(', ')})
                VALUES ${placeholders.join(', ')}
                ON DUPLICATE KEY UPDATE ${updateStatements}
              `;
              await connection.execute(query, values);
          }
        }
        connection.release();
        logger.info(`[${this.name}] Successfully synced stats for ${playerEntries.length} players on Server ${this.serverId}.`);
    } catch (err) {
        logger.error(`[${this.name}] Database sync error: ${err.message}`);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = DBLogStats;
