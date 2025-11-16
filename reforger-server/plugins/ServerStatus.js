// ReforgerJS/reforger-server/plugins/ServerStatus.js
const { EmbedBuilder, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');

class ServerStatus {
  constructor(config) {
    this.config = config;
    this.name = "ServerStatus Plugin";
    this.interval = null;
    this.isInitialized = false;
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
  }

  async prepareToMount(serverInstance, discordClient) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      // We use the scoped config from the server instance
      const pluginConfig = this.serverInstance.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      if (!pluginConfig?.enabled || !pluginConfig?.channel) {
        logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] plugin is disabled or missing channel configuration`);
        return;
      }

      this.channelId = pluginConfig.channel;
      logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] Initializing with channel ID: ${this.channelId}`);
      
      const guild = await this.discordClient.guilds.fetch(this.serverInstance.config.connectors.discord.guildId, { cache: true, force: true });
      this.channel = await guild.channels.fetch(this.channelId);

      if (!this.channel?.isTextBased()) {
        logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Channel ${this.channelId} is not a text channel`);
        return;
      }

      const permissions = this.channel.permissionsFor(this.discordClient.user);
      if (!permissions?.has(["ViewChannel", "SendMessages", "EmbedLinks"])) {
        logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Missing required permissions in channel ${this.channelId}`);
        return;
      }

      if (pluginConfig.messageID) {
        try {
          logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Attempting to fetch existing message ${pluginConfig.messageID}`);
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        } catch (error) {
          logger.info(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Could not fetch existing message, creating a new one`);
          this.message = await this.postInitialEmbed();
        }
      } else {
        logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: No message ID configured, creating initial embed`);
        this.message = await this.postInitialEmbed();
      }

      // Start the update timer for this specific server instance
      const updateInterval = (pluginConfig.interval || 1) * 60 * 1000;
      this.interval = setInterval(() => this.updateEmbed(), updateInterval);
      
      logger.info(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Initialized with update interval of ${pluginConfig.interval || 1} minutes`);
      this.isInitialized = true;
      
      // Run first update immediately
      this.updateEmbed(); 

    } catch (error) {
      logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Error during initialization: ${error.message}`);
    }
  }

  async postInitialEmbed() {
    try {
      const pluginConfig = this.serverInstance.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.serverInstance.config.server?.name || "Unknown";

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        .setDescription(serverName)
        .setTimestamp()
        .addFields(
          { name: "Player Count", value: "Loading...", inline: true },
          { name: "FPS", value: "Loading...", inline: true },
          { name: "Memory Usage", value: "Loading...", inline: true }
        );

      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      
      if (embedConfig.thumbnail !== false && embedConfig.thumbnailURL?.trim()) {
        logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Setting thumbnail to ${embedConfig.thumbnailURL}`);
        embed.setThumbnail(embedConfig.thumbnailURL);
      } else {
        logger.verbose(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Thumbnail is disabled or URL not provided`);
      }

      const message = await this.channel.send({ embeds: [embed] });
      
      // IMPORTANT: We cannot save the config here.
      // Saving the config would cause a race condition with other servers.
      // The user must manually paste this ID into their config.json.
      logger.warn(`[ServerStatus ${this.serverInstance.config.server.id}] Initial embed posted. PLEASE MANUALLY ADD THIS ID TO YOUR config.json for the ServerStatus plugin: "messageID": "${message.id}"`);

      return message;
    } catch (error) {
      logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Error posting initial embed: ${error.message}`);
      throw error;
    }
  }

  async saveConfig() {
    // This function is now disabled to prevent multi-server race conditions.
    // The main 'config.json' is now shared and should not be programmatically written to.
    logger.warn(`[ServerStatus ${this.serverInstance.config.server.id}] saveConfig() is disabled in multi-server mode. Please update config.json manually.`);
  }

  async updateEmbed() {
    if (!this.serverInstance || !this.message) {
      logger.verbose(`[ServerStatus] updateEmbed called but instance or message is missing.`);
      return;
    }

    try {
      const pluginConfig = this.serverInstance.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.serverInstance.config.server?.name || "Unknown";
      const serverId = this.serverInstance.config.server?.id || "?";

      // --- MAIN FIX ---
      // Read from the serverInstance, NOT global
      const playerCount = this.serverInstance.playerCount || 0;
      const fps = this.serverInstance.fps || 0;
      const memoryUsageMB = ((this.serverInstance.memoryUsage || 0) / 1024).toFixed(2);
      // --- END FIX ---

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        .setDescription(serverName)
        .setTimestamp()
        .addFields(
          { name: "Player Count", value: `${playerCount}`, inline: true },
          { name: "FPS", value: `${fps}`, inline: true },
          { name: "Memory Usage", value: `${memoryUsageMB} MB`, inline: true }
        );

      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      
      if (embedConfig.thumbnail !== false && embedConfig.thumbnailURL?.trim()) {
        logger.verbose(`[ServerStatus ${serverId}] plugin: Setting thumbnail to ${embedConfig.thumbnailURL}`);
        embed.setThumbnail(embedConfig.thumbnailURL);
      }

      await this.message.edit({ embeds: [embed] });
      logger.verbose(`[ServerStatus ${serverId}] plugin: Embed updated with ${playerCount} players, ${fps} FPS, ${memoryUsageMB} MB memory usage`);

      if (pluginConfig.discordBotStatus && this.discordClient?.user) {
        // This will make the bot's status rotate between servers, which is the desired multi-server behavior.
        const statusText = `Srv ${serverId}: ${playerCount}P | ${fps}FPS`;
        this.discordClient.user.setActivity({
          type: ActivityType.Custom,
          name: statusText,
          state: statusText,
        });
        logger.verbose(`[ServerStatus ${serverId}] plugin: Discord bot status updated`);
      }
    } catch (error) {
      logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] plugin: Error updating embed: ${error.message}`);
      if (error.code === 10008) { // Unknown Message
        logger.error(`[ServerStatus ${this.serverInstance.config.server.id}] The message ID in your config is invalid or was deleted. Please remove it from config.json to generate a new one.`);
        // Stop trying to update a message that doesn't exist
        if (this.interval) clearInterval(this.interval);
      }
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.verbose(`[ServerStatus ${this.serverInstance?.config?.server?.id || '?'}] plugin: Cleanup - interval cleared`);
    }
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
    logger.verbose(`[ServerStatus] Cleanup complete`);
  }
}

module.exports = ServerStatus;
