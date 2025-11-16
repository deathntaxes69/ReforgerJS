// reforger-server/factory.js
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const mysql = require("mysql2/promise");
const fetch = require("node-fetch");
const BattleMetricsAPI = require("./utils/battlemetricsAPI");

/**
 * Load and parse the config file.
 * Exits the process if the file is empty or contains invalid JSON.
 */
function loadConfig(filePath) {
  try {
    const rawData = fs.readFileSync(filePath, "utf8");
    if (!rawData || rawData.trim() === "") {
      logger.error("Config file is empty.");
      process.exit(1);
    }
    return JSON.parse(rawData);
  } catch (error) {
    logger.error(`Error parsing config.json: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Validate the config object (new multi-server version).
 * Return `true` if valid, `false` if not.
 */
function validateConfig(config) {
  try {
    if (typeof config !== "object" || config === null) {
      logger.error("Invalid configuration: Config is not a valid JSON object.");
      return false;
    }
  } catch (error) {
    logger.error("Invalid configuration: Error parsing config.json.");
    return false;
  }

  // Validate the SERVERS array
  if (!config.servers || !Array.isArray(config.servers) || config.servers.length === 0) {
    logger.error("Invalid configuration: Missing or empty 'servers' array. Please check your config.json.");
    return false;
  }

  const serverIds = new Set();
  // Validate EACH server in the array
  for (const serverConfig of config.servers) {
    if (!serverConfig || typeof serverConfig !== "object") {
      logger.error("Invalid configuration: A server object in the 'servers' array is invalid.");
      return false;
    }
    if (!serverConfig.id || typeof serverConfig.id !== 'number') {
        logger.error(`Invalid configuration for server ${serverConfig.name || 'Unknown'}: Missing or invalid 'id' (must be a unique number).`);
        return false;
    }
    if (serverIds.has(serverConfig.id)) {
      logger.error(`Invalid configuration: Duplicate server 'id' found: ${serverConfig.id}. Each server must have a unique 'id'.`);
      return false;
    }
    serverIds.add(serverConfig.id);

    if (!serverConfig.logDir || typeof serverConfig.logDir !== "string") {
      logger.error(`Invalid configuration for server ${serverConfig.name} (ID: ${serverConfig.id}): Missing or invalid log directory.`);
      return false;
    }
  }

  // Validate the connectors configuration
  if (!config.connectors || typeof config.connectors !== "object") {
    logger.error(
      "Invalid configuration: Missing or invalid connectors settings."
    );
    return false;
  }

  // Validate Discord configuration
  const discordConfig = config.connectors.discord;
  if (
    !discordConfig ||
    !discordConfig.token ||
    !discordConfig.clientId ||
    !discordConfig.guildId
  ) {
    logger.error(
      "Invalid configuration: Discord settings must include token, clientId, and guildId."
    );
    return false;
  }

  // Validate MySQL configuration
  if (config.connectors.mysql && config.connectors.mysql.enabled) {
    const mysqlConfig = config.connectors.mysql;
    if (
      !mysqlConfig.host ||
      !mysqlConfig.username ||
      !mysqlConfig.password ||
      !mysqlConfig.database
    ) {
      logger.error("Invalid configuration: Missing MySQL connection settings.");
      return false;
    }
  }

  // Validate plugins configuration
  if (!Array.isArray(config.plugins)) {
    logger.error("Invalid configuration: Plugins must be an array.");
    return false;
  }

  return true;
}

/**
 * Perform GLOBAL startup checks (Discord, DB, BattleMetrics).
 * These are run only ONCE.
 */
async function performGlobalStartupChecks(config) {
  let discordClient = null; // Initialize to null

  // 1) Connect to Discord (if token is present)
  const discordConfig = config.connectors.discord;
  if (discordConfig && discordConfig.token) {
    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    discordClient.on("ready", async () => {
      logger.info(`Logged in as ${discordClient.user.tag}`);
      discordClient.user.setActivity({
        type: ActivityType.Custom,
        name: "Custom Status",
        state: "📢ReforgerJS",
      });

      logger.verbose(
        `Attempting to fetch guild with ID: ${discordConfig.guildId}`
      );

      try {
        const guild = await discordClient.guilds.fetch(discordConfig.guildId, {
          cache: true,
          force: true,
        });
        const guildName = guild.name || "Unknown Name";
        logger.info(`Connected to guild: ${guildName} (${guild.id})`);
      } catch (error) {
        logger.error(
          `Failed to fetch guild with ID ${discordConfig.guildId}: ${error.message}`
        );
        logger.debug(error.stack);
      }

      try {
        const guilds = await discordClient.guilds.fetch();
        logger.verbose(
          `Bot is currently in the following guilds: ${guilds
            .map((g) => `${g.name} (${g.id})`)
            .join(", ")}`
        );
      } catch (guildListError) {
        logger.error(`Failed to fetch guild list: ${guildListError.message}`);
        logger.debug(guildListError.stack);
      }
    });

    discordClient.on("error", (error) => {
      logger.error(`Discord client error: ${error.message}`);
      logger.debug(error.stack);
    });

    try {
      await discordClient.login(discordConfig.token);
      logger.info("Discord bot connected successfully.");
    } catch (loginError) {
      logger.error(`Failed to connect to Discord: ${loginError.message}`);
      logger.debug(loginError.stack);
      process.exit(1);
    }
  }

  // 2) Connect to MySQL if enabled with reconnection logic
  if (config.connectors.mysql && config.connectors.mysql.enabled) {
    const mysqlConfig = config.connectors.mysql;
    const maxRetries = Infinity;
    const initialRetryDelay = 5000;
    let retryDelay = initialRetryDelay;

    const createMySQLPool = async () => {
      try {
        const pool = mysql.createPool({
          host: mysqlConfig.host,
          port: mysqlConfig.port || 3306,
          user: mysqlConfig.username,
          password: mysqlConfig.password,
          database: mysqlConfig.database,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          connectTimeout: 10000,
        });

        await pool.query("SELECT 1");
        logger.info("MySQL connected successfully.");
        retryDelay = initialRetryDelay;
        return pool;
      } catch (error) {
        logger.error(`MySQL connection failed: ${error.message}`);
        throw error;
      }
    };

    const connectWithRetry = async () => {
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          const pool = await createMySQLPool();
          return pool;
        } catch (error) {
          attempt += 1;
          logger.warn(
            `MySQL reconnection attempt ${attempt} failed. Retrying in ${
              retryDelay / 1000
            } seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 60000);
        }
      }
      throw new Error("Max MySQL reconnection attempts reached.");
    };

    const mysqlPool = await connectWithRetry();
    process.mysqlPool = mysqlPool;

    mysqlPool.on("error", async (err) => {
      logger.error(`MySQL Pool Error: ${err.message}`);
      if (err.code === "PROTOCOL_CONNECTION_LOST" || err.fatal) {
        logger.warn("MySQL connection lost. Attempting to reconnect...");
        try {
          const newPool = await connectWithRetry();
          process.mysqlPool = newPool;
          logger.info("MySQL reconnected successfully.");
        } catch (error) {
          logger.error(`Failed to reconnect to MySQL: ${error.message}`);
        }
      } else {
        logger.error(`Unhandled MySQL Pool Error: ${err.message}`);
      }
    });
  }

  // 3) Battlemetrics API initialization
  if (
    config.connectors.battlemetrics &&
    config.connectors.battlemetrics.enabled
  ) {
    try {
      logger.info("Initializing BattleMetrics API client...");
      const battlemetricsAPI = new BattleMetricsAPI(config);

      await battlemetricsAPI.validateCredentials();

      process.battlemetricsAPI = battlemetricsAPI;
      logger.info(
        "BattleMetrics API client initialized and validated successfully."
      );
    } catch (error) {
      logger.error(
        `Failed to initialize BattleMetrics API client: ${error.message}`
      );
      logger.error("BattleMetrics functionality will be disabled.");
    }
  } else {
    logger.verbose("BattleMetrics API client not configured or disabled.");
  }

  return discordClient;
}

/**
 * Perform PER-SERVER startup checks.
 * This is run for EACH server in the config.
 * @param {object} scopedConfig - A config object where `config.server` is the specific server.
 */
async function performServerStartupChecks(scopedConfig) {
  const serverConfig = scopedConfig.server;
  
  // 1) Ensure the log directory exists
  if (serverConfig.logReaderMode === "tail") {
    if (!fs.existsSync(serverConfig.logDir)) {
      logger.error(`[Server ${serverConfig.id}] Log directory not found: ${serverConfig.logDir}`);
      throw new Error(`[Server ${serverConfig.id}] Log directory not found: ${serverConfig.logDir}`);
    } else {
      logger.info(`[Server ${serverConfig.id}] Log directory verified: ${serverConfig.logDir}`);
    }
  } else {
    logger.info(
      `[Server ${serverConfig.id}] Skipping local log directory check for mode: ${serverConfig.logReaderMode}`
    );
  }
}

module.exports = {
  loadConfig,
  validateConfig,
  performGlobalStartupChecks,
  performServerStartupChecks,
};
