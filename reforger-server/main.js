// reforger-server/main.js
const { EventEmitter } = require("events");
const Rcon = require("./rcon");
const LogParser = require("./log-parser/index");
const fs = require("fs");
const path = require("path");

class ReforgerServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.players = [];
    this.rcon = null;
    this.logParser = null;
    this.voteKickStartBuffer = [];
    this.bufferTimeout = 3000;
    this.isReconnecting = false;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
    this.initialReconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.currentReconnectDelay = this.initialReconnectDelay;

    // Stats are now instance properties, not global
    this.playerCount = 0;
    this.fps = 0;
    this.memoryUsage = 0;
  }

  setupRCON() {
    try {
      if (this.rcon) {
        this.rcon.removeAllListeners();
      }

      this.rcon = new Rcon(this.config);

      this.rcon.on("connect", () => {
        logger.info(`[Server ${this.config.server.id}] RCON connected successfully.`);
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.currentReconnectDelay = this.initialReconnectDelay;
      });

      this.rcon.on("error", (err) => {
        logger.error(`[Server ${this.config.server.id}] RCON error: ${err.message}`);
      });

      this.rcon.on("close", () => {
        logger.warn(`[Server ${this.config.server.id}] RCON connection closed.`);
        this.handleRconDisconnection();
      });

      this.rcon.on("players", (updatedPlayers) => {
        this.players = updatedPlayers;
        this.emit("players", this.players);
      });

      logger.info(`[Server ${this.config.server.id}] RCON setup complete.`);
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Failed to set up RCON: ${error.message}`);
      this.handleRconDisconnection();
    }
  }

  connectRCON() {
    if (!this.rcon) {
      logger.error(`[Server ${this.config.server.id}] RCON is not initialized. Call setupRCON() first.`);
      return;
    }
    this.rcon.start();
  }

  restartRCON() {
    if (!this.rcon) {
      logger.error(`[Server ${this.config.server.id}] RCON is not initialized. Call setupRCON() first.`);
      return;
    }
    logger.warn(`[Server ${this.config.server.id}] Restarting RCON...`);
    this.rcon.restart();
  }

  startSendingPlayersCommand(interval = 30000) {
    if (!this.rcon) {
      logger.error(`[Server ${this.config.server.id}] RCON is not initialized. Call setupRCON() first.`);
      return;
    }
    this.rcon.startSendingPlayersCommand(interval);
  }

  setupLogParser() {
    try {
      if (this.logParser) {
        this.logParser.removeAllListeners();
        this.logParser.unwatch();
      }

      // Pass the server-specific config to the LogParser
      this.logParser = new LogParser("console.log", this.config.server);
      if (!this.logParser) {
        logger.error(`[Server ${this.config.server.id}] LogParser creation failed.`);
        return;
      }

      this.setupLogParserEventHandlers();
      this.logParser.watch();
      logger.info(`[Server ${this.config.server.id}] Log Parser setup complete.`);
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Failed to set up Log Parser: ${error.message}`);
    }
  }

  setupLogParserEventHandlers() {
    this.logParser.on("event", (eventData) => {
      this.emit("logEvent", eventData);
    });

    this.setupVoteKickEventHandlers();
    this.setupPlayerEventHandlers();
    
    // Use 'this.' instead of 'global.'
    this.logParser.on("serverHealth", (data) => {
      this.fps = data.fps;
      this.memoryUsage = data.memory;
      this.playerCount = data.player;
      const memoryMB = (this.memoryUsage / 1024).toFixed(2);
      //logger.verbose(`[Server ${this.config.server.id}] Server Health updated: FPS: ${this.fps}, Memory: ${this.memoryUsage} kB (${memoryMB} MB), Player Count: ${this.playerCount}`);
      
      // Emit the serverHealth event so plugins like ServerStatus can use it
      this.emit("serverHealth", {
        fps: this.fps,
        memory: this.memoryUsage,
        player: this.playerCount
      });
    });

    this.setupGameStateEventHandlers();
    this.setupSATEventHandlers();
    this.setupGMToolsEventHandlers();
    this.setupFlabbyChatEventHandlers();
  }

  async setupCustomLogParsers() {
    try {
      if (!this.config.customParsers) {
        logger.verbose("No custom parsers defined in config");
        return;
      }

      this.customParsers = this.customParsers || {};

      for (const [parserName, parserConfig] of Object.entries(
        this.config.customParsers
      )) {
        try {
          if (
            parserConfig.enabled === "false" ||
            parserConfig.enabled === false
          ) {
            logger.verbose(`[Server ${this.config.server.id}] Custom parser ${parserName} is disabled, skipping`);
            continue;
          }

          if (!parserConfig.logDir) {
            logger.error(
              `[Server ${this.config.server.id}] Custom parser ${parserName} is missing required configuration (logDir)`
            );
            continue;
          }

          const parserPath = path.join(
            __dirname,
            "log-parser",
            parserName,
            "index.js"
          );

          if (!fs.existsSync(parserPath)) {
            logger.error(
              `[Server ${this.config.server.id}] Custom parser ${parserName} enabled in config but not found at ${parserPath}`
            );
            continue;
          }

          logger.info(`[Server ${this.config.server.id}] Loading custom parser: ${parserName}`);

          let CustomParserClass;
          try {
            CustomParserClass = require(parserPath);
          } catch (requireError) {
            logger.error(
              `[Server ${this.config.server.id}] Failed to require custom parser ${parserName}: ${requireError.message}`
            );
            continue;
          }

          const customParserOptions = {
            ...parserConfig,
            ...this.config.server, // Pass server config (e.g., sftp/ftp credentials)
            mode: parserConfig.logReaderMode || this.config.server.logReaderMode || "tail",
          };

          let customParser;
          try {
            const fileName = parserConfig.fileName || null;
            customParser = new CustomParserClass(
              fileName,
              customParserOptions
            );
          } catch (instantiationError) {
            logger.error(
              `[Server ${this.config.server.id}] Failed to instantiate custom parser ${parserName}: ${instantiationError.message}`
            );
            continue;
          }

          const eventNames = CustomParserClass.eventNames || [];

          if (eventNames.length === 0) {
            logger.warn(
              `[Server ${this.config.server.id}] Custom parser ${parserName} does not specify any events to forward`
            );
          }

          for (const eventName of eventNames) {
            customParser.on(eventName, (data) => {
              logger.verbose(
                `[Server ${this.config.server.id}] Custom parser ${parserName} emitted event: ${eventName}`
              );
              // Add server ID to the data
              data.serverId = this.config.server.id;
              this.emit(eventName, data);
            });
          }

          try {
            await customParser.watch().catch((error) => {
              logger.error(
                `[Server ${this.config.server.id}] Error watching logs for custom parser ${parserName}: ${error.message}`
              );
            });
          } catch (watchError) {
            logger.error(
              `[Server ${this.config.server.id}] Failed to start watching logs for custom parser ${parserName}: ${watchError.message}`
            );
            continue;
          }

          this.customParsers[parserName] = customParser;

          logger.info(
            `[Server ${this.config.server.id}] Custom parser ${parserName} initialized and watching logs`
          );
        } catch (error) {
          logger.error(
            `[Server ${this.config.server.id}] Error initializing custom parser ${parserName}: ${error.stack}`
          );
        }
      }
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Error in setupCustomLogParsers: ${error.message}`);
    }
  }

  setupVoteKickEventHandlers() {
    this.logParser.on("voteKickStart", (data) => {
      logger.info(
        `[Server ${this.config.server.id}] Votekick Started by ${data.voteOffenderName} (ID: ${data.voteOffenderId}) against ${data.voteVictimName} (ID: ${data.voteVictimId})`
      );
      data.serverId = this.config.server.id;
      this.emit("voteKickStart", data);
    });

    this.logParser.on("voteKickVictim", (data) => {
      logger.info(
        `[Server ${this.config.server.id}] Vote kick succeeded against player '${data.voteVictimName}' (ID: ${data.voteVictimId})`
      );
      data.serverId = this.config.server.id;
      this.emit("voteKickVictim", data);
    });
  }

  setupPlayerEventHandlers() {
    this.logParser.on("playerJoined", (data) => {
      const { playerName, playerIP, playerNumber, beGUID, steamID, device } =
        data;
      if (this.rcon) {
        const existing = this.rcon.players.find((p) => p.name === playerName);
        if (existing) {
          existing.ip = playerIP;
          if (beGUID) existing.beGUID = beGUID;
          if (steamID !== undefined) existing.steamID = steamID;
          if (device !== undefined) existing.device = device;
        } else {
          const newPlayer = {
            name: playerName,
            number: playerNumber,
            ip: playerIP,
          };
          if (beGUID) newPlayer.beGUID = beGUID;
          if (steamID !== undefined) newPlayer.steamID = steamID;
          if (device !== undefined) newPlayer.device = device;
          this.rcon.players.push(newPlayer);
        }
      }
      logger.verbose(
        `[Server ${this.config.server.id}] Player joined: ${playerName} (#${playerNumber}) from ${playerIP} - Device: ${
          device || "Unknown"
        }, SteamID: ${steamID || "None"}, BE GUID: ${beGUID || "Unknown"}`
      );
      data.serverId = this.config.server.id;
      this.emit("playerJoined", data);
    });

    this.logParser.on("playerUpdate", (data) => {
      if (this.rcon) {
        const existing = this.rcon.players.find(
          (p) => p.name === data.playerName
        );
        if (existing) {
          let updated = false;
          if (!existing.id && data.playerId) {
            existing.id = parseInt(data.playerId, 10);
            updated = true;
          }
          if (!existing.uid && data.playerUid) {
            existing.uid = data.playerUid;
            updated = true;
          }
        } else {
          if (data.playerName && data.playerId && data.playerUid) {
            this.rcon.players.push({
              name: data.playerName,
              id: parseInt(data.playerId, 10),
              uid: data.playerUid,
              ip: null,
            });
          } else {
            logger.warn(
              `[Server ${this.config.server.id}] Incomplete playerUpdate data. Skipping. Data: ${JSON.stringify(
                data
              )}`
            );
          }
        }
      }
      data.serverId = this.config.server.id;
      this.emit("playerUpdate", data);
    });
  }

  setupSATEventHandlers() {
    this.logParser.on("baseCapture", (data) => {
      logger.info(`[Server ${this.config.server.id}] Base captured: ${data.base} by faction ${data.faction}`);
      data.serverId = this.config.server.id;
      this.emit("baseCapture", data);
    });

    this.logParser.on("playerKilled", (data) => {
      logger.verbose(
        `[Server ${this.config.server.id}] ServerAdminTools Player killed: ${data.playerName} by ${data.instigatorName}, friendly fire: ${data.friendlyFire}`
      );

      const payload = {
        ...data,
        serverId: this.config.server.id,
      };

      this.emit("satPlayerKilled", payload);

      if (data.friendlyFire) {
        logger.info(
          `[Server ${this.config.server.id}] ServerAdminTools Friendly fire: ${data.instigatorName} killed ${data.playerName}`
        );
        this.emit("satFriendlyFire", payload);
      }
    });

    this.logParser.on("adminAction", (data) => {
      logger.info(
        `[Server ${this.config.server.id}] Admin action: ${data.action} by ${data.adminName} on player ${data.targetPlayer}`
      );
      data.serverId = this.config.server.id;
      this.emit("adminAction", data);
    });

    this.logParser.on("gameEnd", (data) => {
      if (data.reason && data.winner) {
        logger.info(
          `[Server ${this.config.server.id}] ServerAdminTools Game ended: Reason: ${data.reason}, Winner: ${data.winner}`
        );
        data.serverId = this.config.server.id;
        this.emit("satGameEnd", data);
      }
    });
  }

  setupGMToolsEventHandlers() {
    this.logParser.on("gmToolsStatus", (data) => {
      logger.info(
        `[Server ${this.config.server.id}] GM Tools: Player ${data.playerName} (ID: ${data.playerId}) ${
          data.status === "Enter" ? "entered" : "exited"
        } Game Master mode`
      );
      data.serverId = this.config.server.id;
      this.emit("gmToolsStatus", data);
    });

    this.logParser.on("gmToolsTime", (data) => {
      logger.verbose(
        `[Server ${this.config.server.id}] GM Tools: Session duration for ${data.playerName} (ID: ${data.playerId}): ${data.duration} seconds`
      );
      data.serverId = this.config.server.id;
      this.emit("gmToolsTime", data);
    });
  }

  setupFlabbyChatEventHandlers() {
    this.logParser.on("chatMessage", (data) => {
      const channelType = this.getChatChannelType(data.channelId);
      logger.verbose(
        `[Server ${this.config.server.id}] Chat: [${channelType}] ${data.playerName}: ${data.message}`
      );

      this.emit("chatMessage", {
        ...data,
        channelType: channelType,
        serverId: this.config.server.id,
      });
    });
  }

  getChatChannelType(channelId) {
    switch (channelId) {
      case "0":
        return "Global";
      case "1":
        return "Faction";
      case "2":
        return "Group";
      case "3":
        return "Vehicle";
      case "4":
        return "Local";
      default:
        return "Unknown";
    }
  }

  setupGameStateEventHandlers() {
    // Game Start event
    this.logParser.on("gameStart", (data) => {
      logger.info(`[Server ${this.config.server.id}] Game started at ${data.time}`);
      data.serverId = this.config.server.id;
      this.emit("gameStart", data);
    });

    // Game End event
    this.logParser.on("gameEnd", (data) => {
      logger.info(`[Server ${this.config.server.id}] Game ended at ${data.time}`);
      data.serverId = this.config.server.id;
      this.emit("gameEnd", data);
    });

    // Application Hang event
    this.logParser.on("applicationHang", (data) => {
      logger.info(`[Server ${this.config.server.id}] Aplication Hang at ${data.time}`);
      data.serverId = this.config.server.id;
      this.emit("applicationHang", data);
    });
  }

  handleRconDisconnection() {
    if (this.isReconnecting) {
      return;
    }
    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    this.currentReconnectDelay = this.initialReconnectDelay;
    this.attemptReconnection();
  }

  processVoteKickStartBuffer() {
    // This function's logic seems flawed as it buffers but doesn't seem to use the buffer effectively
    // We'll leave it, but add serverId to any emitted events
    const currentTime = Date.now();

    this.voteKickStartBuffer = this.voteKickStartBuffer.filter((event) => {
      return currentTime - event.timestamp < 1800000;
    });

    logger.verbose(
      `[Server ${this.config.server.id}] Processing ${this.voteKickStartBuffer.length} buffered voteKick events.`
    );

    const bufferCopy = [...this.voteKickStartBuffer];
    this.voteKickStartBuffer = [];

    bufferCopy.forEach((data) => {
      if (this.rcon) {
        const playerId = parseInt(data.playerId, 10);
        const player = this.rcon.players.find((p) => p.id === playerId);

        if (player) {
          logger.info(
            `[Server ${this.config.server.id}] Votekick Started by ${
              player.name || player.uid
            } (buffered) [ID=${playerId}]`
          );
        } else {
          logger.warn(
            `[Server ${this.config.server.id}] Still no matching player for ID ${playerId} (buffered event).`
          );
        }
      }
      data.serverId = this.config.server.id;
      this.emit("voteKickStart", data);
    });
  }

  async attemptReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`[Server ${this.config.server.id}] Max RCON reconnection attempts reached. Giving up.`);
      this.isReconnecting = false; // Stop reconnecting
      return;
    }
  
    if (!this.isReconnecting) {
      logger.info(`[Server ${this.config.server.id}] Reconnection logic triggered but not in reconnecting state. Aborting.`);
      return;
    }
  
    this.reconnectAttempts += 1;
    logger.warn(
      `[Server ${this.config.server.id}] Attempting to reconnect to RCON. Attempt ${this.reconnectAttempts}...`
    );
  
    try {
      if (this.rcon) {
        this.rcon.removeAllListeners("connect"); // Clear old listeners
      } else {
        this.setupRCON(); // Re-initialize if client is gone
      }
  
      this.rcon.once("connect", () => {
        logger.info(`[Server ${this.config.server.id}] RCON reconnected successfully in ReforgerServer.`);
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.currentReconnectDelay = this.initialReconnectDelay;
  
        if (this.rcon.playersIntervalTime && !this.rcon.playersInterval) {
          logger.info(
            `[Server ${this.config.server.id}] Ensuring players command is restarted from ReforgerServer`
          );
          this.rcon.startSendingPlayersCommand(this.rcon.playersIntervalTime);
        }
      });
  
      // Use connect() which handles socket creation and login
      this.rcon.connect(); 
  
    } catch (error) {
      logger.error(
        `[Server ${this.config.server.id}] Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`
      );
    }
  
    if (this.isReconnecting) {
      this.currentReconnectDelay = Math.min(
        this.currentReconnectDelay * 2,
        this.maxReconnectDelay
      );
      logger.info(`[Server ${this.config.server.id}] Scheduling next reconnect attempt in ${this.currentReconnectDelay / 1000}s`);
      setTimeout(() => {
        this.attemptReconnection();
      }, this.currentReconnectDelay);
    }
  }

  async initialize() {
    try {
      this.setupRCON();
      this.connectRCON();
      this.setupLogParser();
      await this.setupCustomLogParsers();
      logger.info(`[Server ${this.config.server.id}] ReforgerServer initialized successfully.`);
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Failed to initialize ReforgerServer: ${error.message}`);
      throw error;
    }
  }

  async cleanup() {
    logger.info(`[Server ${this.config.server.id}] Cleaning up...`);
    if (this.rcon) {
      this.rcon.close();
      this.rcon = null;
    }
    if (this.logParser) {
      await this.logParser.unwatch();
      this.logParser = null;
    }
    if (this.customParsers) {
      for (const parserName in this.customParsers) {
        await this.customParsers[parserName].unwatch();
      }
      this.customParsers = {};
    }
    this.removeAllListeners();
    logger.info(`[Server ${this.config.server.id}] Cleanup complete.`);
  }
}

module.exports = ReforgerServer;
