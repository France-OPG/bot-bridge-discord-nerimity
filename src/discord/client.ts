import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  VoiceChannel,
  ChannelType,
  WebhookClient,
  Guild,
  GuildChannel,
  NonThreadGuildBasedChannel,
  Collection,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

class DiscordBot extends Client {
  private webhookCache = new Map<string, WebhookClient>();

  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async getGuild(): Promise<Guild> {
    const guild = await this.guilds.fetch(config.discord.guildId);
    return guild;
  }

  async getTextChannels(): Promise<Collection<string, NonThreadGuildBasedChannel>> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    return channels.filter(
      (ch): ch is NonThreadGuildBasedChannel =>
        ch !== null && ch.type === ChannelType.GuildText
    ) as Collection<string, NonThreadGuildBasedChannel>;
  }

  async getVoiceChannels(): Promise<Collection<string, NonThreadGuildBasedChannel>> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    return channels.filter(
      (ch): ch is NonThreadGuildBasedChannel =>
        ch !== null && ch.type === ChannelType.GuildVoice
    ) as Collection<string, NonThreadGuildBasedChannel>;
  }

  /** Trouve un channel texte Discord par son nom exact */
  async findTextChannelByName(name: string): Promise<TextChannel | null> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    const ch = channels.find(
      c => c?.type === ChannelType.GuildText && c.name === name.toLowerCase().replace(/ /g, '-')
    );
    return (ch as TextChannel) ?? null;
  }

  /** Trouve un channel vocal Discord par son nom */
  async findVoiceChannelByName(name: string): Promise<VoiceChannel | null> {
    const guild = await this.getGuild();
    const channels = await guild.channels.fetch();
    const ch = channels.find(
      c => c?.type === ChannelType.GuildVoice && c.name.toLowerCase() === name.toLowerCase()
    );
    return (ch as VoiceChannel) ?? null;
  }

  /** Crée un channel texte sur Discord */
  async createTextChannel(name: string): Promise<TextChannel> {
    const guild = await this.getGuild();
    const ch = await guild.channels.create({
      name: name.toLowerCase().replace(/ /g, '-'),
      type: ChannelType.GuildText,
      topic: `🔗 Bridgé depuis Nerimity — #${name}`,
    });
    logger.info(`Discord: channel texte créé → #${ch.name} (${ch.id})`);
    return ch;
  }

  /** Crée un channel vocal sur Discord */
  async createVoiceChannel(name: string): Promise<VoiceChannel> {
    const guild = await this.getGuild();
    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
    });
    logger.info(`Discord: channel vocal créé → ${ch.name} (${ch.id})`);
    return ch;
  }

  /** Renomme un channel Discord */
  async renameChannel(channelId: string, newName: string): Promise<void> {
    const guild = await this.getGuild();
    const ch = await guild.channels.fetch(channelId);
    if (ch && 'setName' in ch) {
      await ch.setName(newName.toLowerCase().replace(/ /g, '-'));
      logger.info(`Discord: channel renommé → ${newName}`);
    }
  }

  /** Supprime un channel Discord */
  async deleteChannel(channelId: string): Promise<void> {
    try {
      const guild = await this.getGuild();
      const ch = await guild.channels.fetch(channelId);
      if (ch) {
        await ch.delete('Supprimé via bridge Nerimity');
        logger.info(`Discord: channel supprimé (${channelId})`);
      }
    } catch (err) {
      logger.warn(`Discord: impossible de supprimer le channel ${channelId}`, { err });
    }
  }

  /**
   * Récupère ou crée un webhook pour un channel texte Discord.
   * Les webhooks permettent d'envoyer des messages avec un nom et avatar personnalisés.
   */
  async getOrCreateWebhook(channelId: string): Promise<WebhookClient> {
    if (this.webhookCache.has(channelId)) {
      return this.webhookCache.get(channelId)!;
    }

    const guild = await this.getGuild();
    const channel = await guild.channels.fetch(channelId) as TextChannel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Channel ${channelId} introuvable ou pas un channel texte`);
    }

    // Cherche un webhook existant créé par le bot
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner?.id === this.user?.id);

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Nerimity Bridge',
        avatar: 'https://nerimity.com/favicon.ico',
        reason: 'Webhook pour le bridge Nerimity↔Discord',
      });
      logger.info(`Discord: webhook créé pour #${channel.name}`);
    }

    const client = new WebhookClient({ url: webhook.url });
    this.webhookCache.set(channelId, client);
    return client;
  }

  /**
   * Envoie un message dans un channel Discord via webhook
   * (apparaît avec le nom + avatar de l'utilisateur Nerimity)
   */
  async sendViaWebhook(
    channelId: string,
    content: string,
    username: string,
    avatarURL?: string
  ): Promise<void> {
    try {
      const webhook = await this.getOrCreateWebhook(channelId);
      await webhook.send({
        content,
        username: `${username} ${config.bridge.prefixNerimity}`,
        avatarURL,
        allowedMentions: { parse: [] }, // sécurité : pas de @everyone depuis Nerimity
      });
    } catch (err) {
      logger.error(`Discord: erreur envoi webhook dans ${channelId}`, { err });
    }
  }

  /** Envoie un message simple dans un channel Discord (sans webhook) */
  async sendMessage(channelId: string, content: string): Promise<void> {
    try {
      const channel = await this.channels.fetch(channelId) as TextChannel;
      await channel.send(content);
    } catch (err) {
      logger.error(`Discord: erreur envoi message dans ${channelId}`, { err });
    }
  }
}

export const discordBot = new DiscordBot();
