const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const db = require('./db');

let client = null;
let io = null; // Socket.IO instance — set externally
let guildId = null;
let categoryId = null;
let notifyChannelId = null;
let ownerId = null;

// Map: discord channel ID -> callsign (for routing Discord replies back)
const channelToCallsign = new Map();
// Map: callsign -> discord channel ID
const callsignToChannel = new Map();

/**
 * Initialize the Discord bot
 */
async function initBot(socketIo) {
  io = socketIo;
  guildId = process.env.DISCORD_GUILD_ID;
  categoryId = process.env.DISCORD_CATEGORY_ID;
  notifyChannelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;
  ownerId = process.env.DISCORD_OWNER_ID;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', async () => {
    console.log(`[Discord] Bot logged in as ${client.user.tag}`);
    await registerSlashCommands();
  });

  // Handle messages from Discord (Kevin's replies)
  client.on('messageCreate', handleDiscordMessage);

  // Handle slash commands
  client.on('interactionCreate', handleInteraction);

  await client.login(process.env.DISCORD_TOKEN);
  return client;
}

/**
 * Register slash commands
 */
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Shadow-ban a user by their fingerprint')
      .addStringOption(opt =>
        opt.setName('fingerprint').setDescription('The fingerprint hash to ban').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('reason').setDescription('Reason for the ban').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Remove a shadow-ban by fingerprint')
      .addStringOption(opt =>
        opt.setName('fingerprint').setDescription('The fingerprint hash to unban').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close the current vent session (use in a vent channel)'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Set your online/offline status for anonymous users')
      .addStringOption(opt =>
        opt.setName('state').setDescription('online or offline').setRequired(true)
          .addChoices(
            { name: 'Online', value: 'online' },
            { name: 'Offline', value: 'offline' },
          )
      ),
    new SlashCommandBuilder()
      .setName('bans')
      .setDescription('List all active shadow-bans'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('[Discord] Slash commands registered');
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err);
  }
}

/**
 * Handle messages sent in Discord channels (Kevin's replies)
 */
async function handleDiscordMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if this is a vent channel
  const callsign = channelToCallsign.get(message.channel.id);
  if (!callsign) return;

  // Only allow the owner to reply
  if (message.author.id !== ownerId) return;

  // Relay to anonymous user via Socket.IO
  if (io) {
    io.to(`session:${callsign}`).emit('message', {
      sender: 'kevin',
      content: message.content,
      timestamp: new Date().toISOString(),
    });
  }

  // Save to DB
  const session = db.getActiveSession(callsign);
  if (session) {
    db.addMessage({
      sessionId: session.id,
      sender: 'kevin',
      content: message.content,
    });
  }
}

/**
 * Handle slash command interactions
 */
async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'ban') {
    const fingerprint = interaction.options.getString('fingerprint');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    db.addBan(fingerprint, reason);
    await interaction.reply({ content: `🔨 Shadow-banned fingerprint \`${fingerprint.slice(0, 12)}...\`\nReason: ${reason}`, ephemeral: true });
  }

  else if (commandName === 'unban') {
    const fingerprint = interaction.options.getString('fingerprint');
    db.removeBan(fingerprint);
    await interaction.reply({ content: `✅ Removed shadow-ban for fingerprint \`${fingerprint.slice(0, 12)}...\``, ephemeral: true });
  }

  else if (commandName === 'close') {
    const callsign = channelToCallsign.get(interaction.channel.id);
    if (!callsign) {
      await interaction.reply({ content: '❌ This is not a vent channel.', ephemeral: true });
      return;
    }

    // Notify the anonymous user
    if (io) {
      io.to(`session:${callsign}`).emit('session-closed', { reason: 'Kevin closed the session.' });
    }

    // Close in DB
    db.closeSession(callsign);
    channelToCallsign.delete(interaction.channel.id);
    callsignToChannel.delete(callsign);

    await interaction.reply({ content: `✅ Session **${callsign}** closed.` });

    // Archive the channel (rename with closed- prefix)
    try {
      await interaction.channel.edit({ name: `closed-${callsign.toLowerCase()}` });
    } catch (e) { /* ignore permission errors */ }
  }

  else if (commandName === 'status') {
    const state = interaction.options.getString('state');
    db.setOwnerStatus(state);

    // Broadcast to all connected users
    if (io) {
      io.emit('owner-status', { status: state });
    }

    await interaction.reply({ content: `✅ Status set to **${state}**. All users have been notified.`, ephemeral: true });
  }

  else if (commandName === 'bans') {
    const bans = db.getAllBans();
    if (bans.length === 0) {
      await interaction.reply({ content: 'No active bans.', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔨 Active Shadow-Bans')
      .setColor(0xff4444)
      .setDescription(bans.map((b, i) =>
        `**${i + 1}.** \`${b.fingerprint.slice(0, 16)}...\`\n   Reason: ${b.reason || 'N/A'}\n   Since: ${b.created_at}`
      ).join('\n\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

/**
 * Create a Discord channel for a new vent session
 */
async function createVentChannel(callsign, metadata) {
  if (!client || !guildId) return null;

  try {
    const guild = await client.guilds.fetch(guildId);

    // Create the channel (made public / inherits category permissions)
    const channel = await guild.channels.create({
      name: `vent-${callsign.toLowerCase()}`,
      type: ChannelType.GuildText,
      ...(categoryId && /^\d+$/.test(categoryId) ? { parent: categoryId } : {}),
    });

    // Track the mapping
    channelToCallsign.set(channel.id, callsign);
    callsignToChannel.set(callsign, channel.id);

    // Send info embed
    const infoEmbed = new EmbedBuilder()
      .setTitle(`🌬️ New Vent Session — ${callsign}`)
      .setColor(0x7c3aed)
      .addFields(
        { name: '📍 Location', value: metadata.location || 'Unknown', inline: true },
        { name: '🖥️ Device', value: metadata.device || 'Unknown', inline: true },
        { name: '🔑 Fingerprint', value: `\`${metadata.fingerprint || 'Unknown'}\``, inline: false },
        { name: '🌐 IP', value: `\`${metadata.ip || 'Unknown'}\``, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'Reply in this channel to chat with this user' });

    await channel.send({ embeds: [infoEmbed] });

    // Pin the info message
    const messages = await channel.messages.fetch({ limit: 1 });
    const pinMsg = messages.first();
    if (pinMsg) await pinMsg.pin().catch(() => {});

    // Notify in the notification channel
    if (notifyChannelId && /^\d+$/.test(notifyChannelId)) {
      try {
        const notifChannel = await guild.channels.fetch(notifyChannelId);
        const pingTarget = ownerId ? `<@${ownerId}>` : '@here';
        await notifChannel.send({
          content: `${pingTarget} 🌬️ New vent session started: **${callsign}**`,
          embeds: [
            new EmbedBuilder()
              .setColor(0x7c3aed)
              .setDescription(`A new anonymous user wants to chat.\nChannel: <#${channel.id}>`)
              .addFields(
                { name: 'Location', value: metadata.location || 'Unknown', inline: true },
                { name: 'Device', value: metadata.device || 'Unknown', inline: true },
              )
              .setTimestamp(),
          ],
        });
      } catch (e) {
        console.error('[Discord] Failed to send notification:', e.message);
      }
    }

    return channel.id;
  } catch (err) {
    console.error('[Discord] Failed to create vent channel:', err);
    return null;
  }
}

/**
 * Send a message to the vent channel from the anonymous user
 */
async function sendToChannel(callsign, content) {
  const channelId = callsignToChannel.get(callsign);
  if (!channelId || !client) return;

  try {
    const channel = await client.channels.fetch(channelId);
    const session = db.getActiveSession(callsign);

    const embed = new EmbedBuilder()
      .setDescription(content)
      .setColor(0x2dd4bf)
      .setAuthor({ name: callsign })
      .setTimestamp();

    if (session && session.fingerprint) {
      embed.setFooter({ text: `Fingerprint: ${session.fingerprint}` });
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Discord] Failed to send to channel:', err.message);
  }
}

/**
 * Send a system notification to the vent channel
 */
async function sendSystemMessage(callsign, text) {
  const channelId = callsignToChannel.get(callsign);
  if (!channelId || !client) return;

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(text)
          .setColor(0x6b7280)
          .setTimestamp(),
      ],
    });
  } catch (err) {
    console.error('[Discord] Failed to send system message:', err.message);
  }
}

/**
 * Notify typing in the vent channel
 */
async function sendTypingToChannel(callsign) {
  const channelId = callsignToChannel.get(callsign);
  if (!channelId || !client) return;

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.sendTyping();
  } catch (err) { /* ignore */ }
}

/**
 * Clean up a channel mapping
 */
function removeChannelMapping(callsign) {
  const channelId = callsignToChannel.get(callsign);
  if (channelId) {
    channelToCallsign.delete(channelId);
  }
  callsignToChannel.delete(callsign);
}

module.exports = {
  initBot,
  createVentChannel,
  sendToChannel,
  sendSystemMessage,
  sendTypingToChannel,
  removeChannelMapping,
  channelToCallsign,
  callsignToChannel,
};
