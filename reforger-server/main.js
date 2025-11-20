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

      // Standard instantiation
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
      logger.error(`[Server ${this.config.server.id}] RCON is not initialized.`);
      return;
    }
    this.rcon.start();
  }

  restartRCON() {
    if (!this.rcon) return;
    logger.warn(`[Server ${this.config.server.id}] Restarting RCON...`);
    this.rcon.restart();
  }

  startSendingPlayersCommand(interval = 30000) {
    if (!this.rcon) return;
    this.rcon.startSendingPlayersCommand(interval);
  }

  setupLogParser() {
    try {
      if (this.logParser) {
        this.logParser.removeAllListeners();
        this.logParser.unwatch();
      }

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
    this.logParser.on("event", (eventData) => this.emit("logEvent", eventData));
    this.setupVoteKickEventHandlers();
    this.setupPlayerEventHandlers();
    
    this.logParser.on("serverHealth", (data) => {
      this.fps = data.fps;
      this.memoryUsage = data.memory;
      this.playerCount = data.player;
      this.emit("serverHealth", { fps: this.fps, memory: this.memoryUsage, player: this.playerCount });
    });

    this.setupGameStateEventHandlers();
    this.setupSATEventHandlers();
    this.setupGMToolsEventHandlers();
    this.setupFlabbyChatEventHandlers();
  }

  async setupCustomLogParsers() {
    try {
      if (!this.config.customParsers) return;
      this.customParsers = this.customParsers || {};

      for (const [parserName, parserConfig] of Object.entries(this.config.customParsers)) {
        try {
          if (parserConfig.enabled === false) continue;
          const parserPath = path.join(__dirname, "log-parser", parserName, "index.js");
          if (!fs.existsSync(parserPath)) continue;

          const CustomParserClass = require(parserPath);
          const customParserOptions = {
            ...parserConfig,
            ...this.config.server, 
            mode: parserConfig.logReaderMode || this.config.server.logReaderMode || "tail",
          };

          const customParser = new CustomParserClass(parserConfig.fileName || null, customParserOptions);
          
          (CustomParserClass.eventNames || []).forEach(eventName => {
            customParser.on(eventName, (data) => {
              data.serverId = this.config.server.id;
              this.emit(eventName, data);
            });
          });

          await customParser.watch();
          this.customParsers[parserName] = customParser;
          logger.info(`[Server ${this.config.server.id}] Custom parser ${parserName} initialized`);
        } catch (error) {
          logger.error(`[Server ${this.config.server.id}] Error initializing custom parser ${parserName}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Error in setupCustomLogParsers: ${error.message}`);
    }
  }

  setupVoteKickEventHandlers() {
    this.logParser.on("voteKickStart", (data) => {
      data.serverId = this.config.server.id;
      this.emit("voteKickStart", data);
    });
    this.logParser.on("voteKickVictim", (data) => {
      data.serverId = this.config.server.id;
      this.emit("voteKickVictim", data);
    });
  }

  setupPlayerEventHandlers() {
    this.logParser.on("playerJoined", (data) => {
      data.serverId = this.config.server.id;
      this.emit("playerJoined", data);
    });
    this.logParser.on("playerUpdate", (data) => {
      data.serverId = this.config.server.id;
      this.emit("playerUpdate", data);
    });
  }

  setupSATEventHandlers() {
    this.logParser.on("baseCapture", (data) => {
      data.serverId = this.config.server.id;
      this.emit("baseCapture", data);
    });
    this.logParser.on("playerKilled", (data) => {
      const payload = { ...data, serverId: this.config.server.id };
      this.emit("satPlayerKilled", payload);
      if (data.friendlyFire) this.emit("satFriendlyFire", payload);
    });
    this.logParser.on("adminAction", (data) => {
      data.serverId = this.config.server.id;
      this.emit("adminAction", data);
    });
    this.logParser.on("gameEnd", (data) => {
      data.serverId = this.config.server.id;
      this.emit("satGameEnd", data);
    });
  }

  setupGMToolsEventHandlers() {
    this.logParser.on("gmToolsStatus", (data) => {
      data.serverId = this.config.server.id;
      this.emit("gmToolsStatus", data);
    });
    this.logParser.on("gmToolsTime", (data) => {
      data.serverId = this.config.server.id;
      this.emit("gmToolsTime", data);
    });
  }

  setupFlabbyChatEventHandlers() {
    this.logParser.on("chatMessage", (data) => {
      const channelType = this.getChatChannelType(data.channelId);
      this.emit("chatMessage", { ...data, channelType, serverId: this.config.server.id });
    });
  }

  getChatChannelType(channelId) {
    switch (channelId) {
      case "0": return "Global";
      case "1": return "Faction";
      case "2": return "Group";
      case "3": return "Vehicle";
      case "4": return "Local";
      default: return "Unknown";
    }
  }

  setupGameStateEventHandlers() {
    this.logParser.on("gameStart", (data) => { data.serverId = this.config.server.id; this.emit("gameStart", data); });
    this.logParser.on("gameEnd", (data) => { data.serverId = this.config.server.id; this.emit("gameEnd", data); });
    this.logParser.on("applicationHang", (data) => { data.serverId = this.config.server.id; this.emit("applicationHang", data); });
  }

  handleRconDisconnection() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    this.currentReconnectDelay = this.initialReconnectDelay;
    this.attemptReconnection();
  }

  async attemptReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`[Server ${this.config.server.id}] Max RCON reconnection attempts reached.`);
      this.isReconnecting = false;
      return;
    }
    
    this.reconnectAttempts++;
    logger.warn(`[Server ${this.config.server.id}] Attempting to reconnect to RCON. Attempt ${this.reconnectAttempts}...`);
    
    try {
      if (this.rcon) this.rcon.removeAllListeners("connect");
      else this.setupRCON();
      
      this.rcon.once("connect", () => {
        logger.info(`[Server ${this.config.server.id}] RCON reconnected successfully.`);
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.currentReconnectDelay = this.initialReconnectDelay;
        if (this.rcon.playersIntervalTime) this.rcon.startSendingPlayersCommand(this.rcon.playersIntervalTime);
      });
      this.rcon.connect(); 
    } catch (error) {
      logger.error(`[Server ${this.config.server.id}] Reconnection attempt failed: ${error.message}`);
    }

    if (this.isReconnecting) {
      this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, this.maxReconnectDelay);
      setTimeout(() => this.attemptReconnection(), this.currentReconnectDelay);
    }
  }

  async initialize() {
    this.setupRCON();
    this.connectRCON();
    this.setupLogParser();
    await this.setupCustomLogParsers();
    logger.info(`[Server ${this.config.server.id}] ReforgerServer initialized successfully.`);
  }

  async cleanup() {
    if (this.rcon) { 
        this.rcon.close(); 
        this.rcon = null; 
    }
    if (this.logParser) { 
        await this.logParser.unwatch(); 
        this.logParser = null; 
    }
    if (this.customParsers) {
      for (const parserName in this.customParsers) await this.customParsers[parserName].unwatch();
      this.customParsers = {};
    }
    this.removeAllListeners();
    logger.info(`[Server ${this.config.server.id}] Cleanup complete.`);
  }
}

module.exports = ReforgerServer;
