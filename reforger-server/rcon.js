// reforger-server/commandFunctions/rcon.js
const { EmbedBuilder } = require("discord.js");

module.exports = async (
  interaction,
  serverInstances, // <-- This is now an array
  discordClient,
  extraData = {}
) => {
  // Get the server number from the command options
  const requestedServerNumber = interaction.options.getInteger("server");

  // Find the correct server instance from the array
  const targetInstance = serverInstances.find(
    (s) => s.config.server.id === requestedServerNumber
  );

  if (!targetInstance) {
    logger.warn(`[RCON Command] User ${interaction.user.username} requested server ${requestedServerNumber}, but it's not managed by this instance.`);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    return interaction.editReply({
      content: `Error: Server with ID ${requestedServerNumber} was not found or is not online.`,
      ephemeral: true,
    });
  }

  // Get the subcommand and options
  const subcommand = interaction.options.getSubcommand();
  // Get the config from the TARGET instance
  const config = targetInstance.config; 
  const rconConfig = config.commands.find((cmd) => cmd.command === "rcon");

  if (!rconConfig) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    return interaction.editReply({
      content: "RCON command configuration is missing.",
      ephemeral: true,
    });
  }

  // Get user roles
  const userRoles = interaction.member.roles.cache.map((role) => role.id);

  // Function to get the user's maximum role level (from the target config)
  function getUserMaxRoleLevel(userRoles) {
    let maxLevel = 0;
    // Use targetInstance's config
    for (const [levelKey, roleNameArray] of Object.entries(config.roleLevels)) { 
      const numericLevel = parseInt(levelKey, 10);
      if (isNaN(numericLevel)) continue;

      for (const roleName of roleNameArray) {
        const discordRoleID = config.roles[roleName];
        if (discordRoleID && userRoles.includes(discordRoleID)) {
          // This logic assumes higher number = lower privilege
          if (numericLevel > maxLevel) {
            maxLevel = numericLevel;
          }
        }
      }
    }
    return maxLevel;
  }
  
  // This logic seems to be: "user's level (e.g. 3) must be >= required level (e.g. 3)"
  // The original logic in commandHandler was (userLevel <= commandLevel)
  // Let's stick to the logic from the rcon command file, assuming 1 > 2 > 3
  
  // Re-reading roleLevels: "Level 1 has full access... Level 3 can only access level 3"
  // This means lower number is higher privilege.
  // A level 1 user should be able to run a level 3 command.
  // A level 3 user should NOT run a level 1 command.
  // Check should be: user_level <= required_level
  
  // Let's find the user's BEST (lowest) level
  function getUserBestRoleLevel(userRoles) {
    let bestLevel = Infinity; // Start with worst permission
    for (const [levelKey, roleNameArray] of Object.entries(config.roleLevels)) {
      const numericLevel = parseInt(levelKey, 10);
      if (isNaN(numericLevel)) continue;

      for (const roleName of roleNameArray) {
        const discordRoleID = config.roles[roleName];
        if (discordRoleID && userRoles.includes(discordRoleID)) {
          if (numericLevel < bestLevel) {
            bestLevel = numericLevel; // Found a better (lower) level
          }
        }
      }
    }
    return bestLevel;
  }


  // Function to check if user has permission for a specific subcommand
  function hasPermissionForSubcommand(subcommandName) {
    const requiredLevel = rconConfig[subcommandName];
    if (requiredLevel === undefined) { // Check for 0 or undefined
      return false; // Not configured
    }
    const userLevel = getUserBestRoleLevel(userRoles);
    return userLevel <= requiredLevel; // User level 1 can run command level 3
  }

  // Handle the interaction state
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  try {
    // Check if RCON is available on the TARGET instance
    if (!targetInstance.rcon || !targetInstance.rcon.isConnected) {
      return interaction.editReply({
        content: `RCON for server ${requestedServerNumber} is not connected.`,
        ephemeral: true,
      });
    }

    // Handle restart subcommand
    if (subcommand === "restart") {
      const confirm = interaction.options.getString("confirm");

      if (!hasPermissionForSubcommand("restart")) {
        return interaction.editReply({
          content: "You do not have permission to restart the server.",
          ephemeral: true,
        });
      }

      if (confirm !== "CONFIRM") {
        return interaction.editReply({
          content: "Type CONFIRM to proceed with a restart.",
          ephemeral: true,
        });
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued server restart command for Server ${requestedServerNumber}`
      );

      // Send the RCON command TO THE TARGET INSTANCE
      targetInstance.rcon.sendCustomCommand("restart");

      return interaction.editReply({
        content:
          `Server restart command sent to Server ${requestedServerNumber}. The server will restart shortly.`,
        ephemeral: true,
      });
    }

    // Handle shutdown subcommand
    if (subcommand === "shutdown") {
      const confirm = interaction.options.getString("confirm");

      if (!hasPermissionForSubcommand("shutdown")) {
        return interaction.editReply({
          content: "You do not have permission to shut down the server.",
          ephemeral: true,
        });
      }

      if (confirm !== "CONFIRM") {
        return interaction.editReply({
          content: "Type CONFIRM to proceed with a shutdown.",
          ephemeral: true,
        });
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued server shutdown command for Server ${requestedServerNumber}`
      );

      // Send the RCON command TO THE TARGET INSTANCE
      targetInstance.rcon.sendCustomCommand("#shutdown");

      return interaction.editReply({
        content:
          `Server shutdown command sent to Server ${requestedServerNumber}. The server will shut down shortly.`,
        ephemeral: true,
      });
    }

    // Handle kick subcommand
    if (subcommand === "kick") {
      const playerId = interaction.options.getString("id");

      if (!hasPermissionForSubcommand("kick")) {
        return interaction.editReply({
          content: "You do not have permission to kick a player.",
          ephemeral: true,
        });
      }

      if (!playerId) {
        return interaction.editReply({
          content: "Player ID is required.",
          ephemeral: true,
        });
      }

      // Create the kick command
      const rconCommand = `#kick ${playerId}`;

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued kick command for Server ${requestedServerNumber}: ${rconCommand}`
      );

      // Send the RCON command TO THE TARGET INSTANCE
      targetInstance.rcon.sendCustomCommand(rconCommand);

      return interaction.editReply({
        content: `Player with ID ${playerId} has been kicked from Server ${requestedServerNumber}.`,
        ephemeral: true,
      });
    }

    // Handle ban subcommand
    if (subcommand === "ban") {
      const action = interaction.options.getString("action");
      const playerId = interaction.options.getString("id");
      const duration = interaction.options.getInteger("duration");
      const reason = interaction.options.getString("reason");

      if (!hasPermissionForSubcommand("ban")) {
        return interaction.editReply({
          content: "You do not have permission to ban players.",
          ephemeral: true,
        });
      }

      if (!playerId) {
        return interaction.editReply({
          content: "Player ID is required.",
          ephemeral: true,
        });
      }

      let rconCommand = "";
      if (action === "remove") {
        rconCommand = `ban remove ${playerId}`;
      } else if (action === "create") {
        if (!duration) {
          return interaction.editReply({
            content: "Ban creation requires a duration (in seconds).",
            ephemeral: true,
          });
        }

        // ban create <id> <duration> [reason]
        if (reason) {
          rconCommand = `#ban create ${playerId} ${duration} ${reason}`;
        } else {
          rconCommand = `#ban create ${playerId} ${duration}`;
        }
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued ban command for Server ${requestedServerNumber}: ${rconCommand}`
      );

      // Send the RCON command TO THE TARGET INSTANCE
      targetInstance.rcon.sendCustomCommand(rconCommand);

      return interaction.editReply({
        content: `RCON command sent to Server ${requestedServerNumber}: \`${rconCommand}\``,
        ephemeral: true,
      });
    }

    // If we get here, it's an unhandled subcommand
    return interaction.editReply({
      content: `Unknown subcommand: ${subcommand}`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error(`[RCON Command] Error: ${error.message}`);
    return interaction.editReply({
      content: "An error occurred while executing the RCON command.",
      ephemeral: true,
    });
  }
};
