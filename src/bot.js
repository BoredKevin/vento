const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const db = require('./db');

let client = null;
let io = null; // Socket.IO instance - set externally
let guildId = null;
let categoryId = null;
let notifyChannelId = null;
let ownerId = null;

const channelToCallsign = new Map();
const callsignToChannel = new Map();

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

  client.on('messageCreate', handleDiscordMessage);

  client.on('interactionCreate', handleInteraction);

  await client.login(process.env.DISCORD_TOKEN);
  return client;
}

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

async function handleDiscordMessage(message) {
  if (message.author.bot) return;

  const callsign = channelToCallsign.get(message.channel.id);
  if (!callsign) return;

  if (message.author.id !== ownerId) return;

  if (io) {
    io.to(`session:${callsign}`).emit('message', {
      sender: 'kevin',
      content: message.content,
      timestamp: new Date().toISOString(),
    });
  }

  const session = db.getActiveSession(callsign);
  if (session) {
    db.addMessage({
      sessionId: session.id,
      sender: 'kevin',
      content: message.content,
    });
  }
}

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

    if (io) {
      io.to(`session:${callsign}`).emit('session-closed', { reason: 'Kevin closed the session.' });
    }

    db.closeSession(callsign);
    channelToCallsign.delete(interaction.channel.id);
    callsignToChannel.delete(callsign);

    await interaction.reply({ content: `✅ Session **${callsign}** closed.` });

    try {
      await interaction.channel.edit({ name: `closed-${callsign.toLowerCase()}` });
    } catch (e) {  }
  }

  else if (commandName === 'status') {
    const state = interaction.options.getString('state');
    db.setOwnerStatus(state);

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

async function createVentChannel(callsign, metadata) {
  if (!client || !guildId) return null;

  try {
    const guild = await client.guilds.fetch(guildId);

    const channel = await guild.channels.create({
      name: `vent-${callsign.toLowerCase()}`,
      type: ChannelType.GuildText,
      ...(categoryId && /^\d+$/.test(categoryId) ? { parent: categoryId } : {}),
    });

    channelToCallsign.set(channel.id, callsign);
    callsignToChannel.set(callsign, channel.id);

    const infoEmbed = new EmbedBuilder()
      .setTitle(`🌬️ New Vent Session - ${callsign}`)
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

    const messages = await channel.messages.fetch({ limit: 1 });
    const pinMsg = messages.first();
    if (pinMsg) await pinMsg.pin().catch(() => {});

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

async function sendTypingToChannel(callsign) {
  const channelId = callsignToChannel.get(callsign);
  if (!channelId || !client) return;

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.sendTyping();
  } catch (err) {  }
}

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

