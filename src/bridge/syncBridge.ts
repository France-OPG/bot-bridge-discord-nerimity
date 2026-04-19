import { ChannelType, Events, GuildChannel, NonThreadGuildBasedChannel } from 'discord.js';
import { discordBot } from '../discord/client';
import { nerimityApi, NerChannel, NER_CHANNEL_TYPE } from '../nerimity/api';
import {
  nerimityClient,
  NerChannelCreated,
  NerChannelUpdated,
  NerChannelDeleted,
} from '../nerimity/client';
import { channelStore, ChannelPair } from '../utils/channelStore';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * SyncBridge — synchronise la structure des salons entre les deux plateformes
 *
 * Au démarrage :
 *   1. Charge tous les channels Nerimity
 *   2. Pour chaque channel, cherche l'équivalent Discord (même nom)
 *   3. Si pas trouvé → le crée côté Discord
 *   4. Sauvegarde la map Nerimity ID ↔ Discord ID
 *
 * En temps réel :
 *   - Nerimity: CHANNEL_CREATED  → crée côté Discord
 *   - Nerimity: CHANNEL_UPDATED  → renomme côté Discord
 *   - Nerimity: CHANNEL_DELETED  → supprime côté Discord
 *   - Discord:  channelCreate    → crée côté Nerimity
 *   - Discord:  channelUpdate    → renomme côté Nerimity
 *   - Discord:  channelDelete    → supprime côté Nerimity
 */
class SyncBridge {
  // Verrous pour éviter les boucles de sync
  private pendingNerimityCreates = new Set<string>(); // noms en cours de création côté Nerimity
  private pendingDiscordCreates = new Set<string>();  // noms en cours de création côté Discord

  async init(): Promise<void> {
    logger.info('SyncBridge: synchronisation initiale des channels...');
    await this.initialSync();
    this.listenNerimity();
    this.listenDiscord();
    logger.info('SyncBridge initialisé');
  }

  // ─────────────────────────────────────────────
  //  SYNC INITIALE AU DÉMARRAGE
  // ─────────────────────────────────────────────

  private async initialSync(): Promise<void> {
    let nerChannels: NerChannel[];
    try {
      nerChannels = await nerimityApi.getChannels();
    } catch (err) {
      logger.error('SyncBridge: impossible de récupérer les channels Nerimity', { err });
      return;
    }

    for (const nerCh of nerChannels) {
      // On ignore les catégories
      if (nerCh.type === NER_CHANNEL_TYPE.CATEGORY) continue;

      const isVoice = nerCh.type === NER_CHANNEL_TYPE.VOICE;
      const type: ChannelPair['type'] = isVoice ? 'voice' : 'text';

      // Vérifie si la paire existe déjà dans le store
      const existing = channelStore.getByNerimity(nerCh.id);
      if (existing) {
        logger.debug(`SyncBridge: paire déjà connue — #${nerCh.name}`);
        continue;
      }

      // Cherche un channel Discord du même nom
      let discordId: string;
      if (isVoice) {
        const found = await discordBot.findVoiceChannelByName(nerCh.name);
        if (found) {
          discordId = found.id;
        } else {
          const created = await discordBot.createVoiceChannel(nerCh.name);
          discordId = created.id;
        }
      } else {
        const found = await discordBot.findTextChannelByName(nerCh.name);
        if (found) {
          discordId = found.id;
        } else {
          const created = await discordBot.createTextChannel(nerCh.name);
          discordId = created.id;
        }
      }

      channelStore.addPair({
        nerimityChannelId: nerCh.id,
        discordChannelId: discordId,
        name: nerCh.name,
        type,
      });

      logger.info(`SyncBridge: paire créée — #${nerCh.name} (NER:${nerCh.id} ↔ DSC:${discordId})`);
    }
  }

  // ─────────────────────────────────────────────
  //  NERIMITY → DISCORD (événements temps réel)
  // ─────────────────────────────────────────────

  private listenNerimity(): void {
    // --- Création d'un channel côté Nerimity ---
    nerimityClient.on('channelCreated', async (data: NerChannelCreated) => {
      if (data.serverId !== config.nerimity.serverId) return;
      if (data.type === NER_CHANNEL_TYPE.CATEGORY) return;

      // Évite la boucle si c'est nous qui avons créé ce channel
      if (this.pendingNerimityCreates.has(data.name)) {
        this.pendingNerimityCreates.delete(data.name);
        return;
      }

      const isVoice = data.type === NER_CHANNEL_TYPE.VOICE;
      logger.info(`SyncBridge: Nerimity→Discord CREATE #${data.name}`);

      try {
        let discordId: string;
        if (isVoice) {
          const ch = await discordBot.createVoiceChannel(data.name);
          discordId = ch.id;
        } else {
          const ch = await discordBot.createTextChannel(data.name);
          discordId = ch.id;
        }

        channelStore.addPair({
          nerimityChannelId: data.id,
          discordChannelId: discordId,
          name: data.name,
          type: isVoice ? 'voice' : 'text',
        });
      } catch (err) {
        logger.error(`SyncBridge: erreur création Discord pour #${data.name}`, { err });
      }
    });

    // --- Renommage d'un channel côté Nerimity ---
    nerimityClient.on('channelUpdated', async (data: NerChannelUpdated) => {
      const newName = data.updated?.name;
      if (!newName) return;

      const pair = channelStore.getByNerimity(data.channelId);
      if (!pair) return;

      logger.info(`SyncBridge: Nerimity→Discord RENAME #${pair.name} → #${newName}`);
      pair.name = newName;
      channelStore.addPair(pair);

      await discordBot.renameChannel(pair.discordChannelId, newName);
    });

    // --- Suppression d'un channel côté Nerimity ---
    nerimityClient.on('channelDeleted', async (data: NerChannelDeleted) => {
      if (data.serverId !== config.nerimity.serverId) return;

      const pair = channelStore.getByNerimity(data.channelId);
      if (!pair) return;

      logger.info(`SyncBridge: Nerimity→Discord DELETE #${pair.name}`);
      await discordBot.deleteChannel(pair.discordChannelId);
      channelStore.removePairByNerimity(data.channelId);
    });
  }

  // ─────────────────────────────────────────────
  //  DISCORD → NERIMITY (événements temps réel)
  // ─────────────────────────────────────────────

  private listenDiscord(): void {
    // --- Création d'un channel côté Discord ---
    discordBot.on(Events.ChannelCreate, async (channel: NonThreadGuildBasedChannel) => {
      if (channel.guildId !== config.discord.guildId) return;
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildVoice
      ) return;

      // Évite la boucle si on a initié cette création
      if (this.pendingDiscordCreates.has(channel.name)) {
        this.pendingDiscordCreates.delete(channel.name);
        return;
      }

      // Déjà dans le store ?
      if (channelStore.getByDiscord(channel.id)) return;

      const isVoice = channel.type === ChannelType.GuildVoice;
      logger.info(`SyncBridge: Discord→Nerimity CREATE #${channel.name}`);

      try {
        this.pendingNerimityCreates.add(channel.name);
        let nerCh: NerChannel;
        if (isVoice) {
          nerCh = await nerimityApi.createVoiceChannel(channel.name);
        } else {
          nerCh = await nerimityApi.createTextChannel(channel.name);
        }

        channelStore.addPair({
          nerimityChannelId: nerCh.id,
          discordChannelId: channel.id,
          name: channel.name,
          type: isVoice ? 'voice' : 'text',
        });
      } catch (err) {
        this.pendingNerimityCreates.delete(channel.name);
        logger.error(`SyncBridge: erreur création Nerimity pour #${channel.name}`, { err });
      }
    });

    // --- Renommage d'un channel côté Discord ---
    discordBot.on(
      Events.ChannelUpdate,
      async (oldCh, newCh) => {
        if (!('guildId' in newCh) || newCh.guildId !== config.discord.guildId) return;
        if (!('name' in oldCh) || !('name' in newCh)) return;
        if (oldCh.name === newCh.name) return;

        const pair = channelStore.getByDiscord(newCh.id);
        if (!pair) return;

        logger.info(`SyncBridge: Discord→Nerimity RENAME #${oldCh.name} → #${newCh.name}`);
        pair.name = newCh.name;
        channelStore.addPair(pair);

        await nerimityApi.updateChannel(pair.nerimityChannelId, newCh.name);
      }
    );

    // --- Suppression d'un channel côté Discord ---
    discordBot.on(
      Events.ChannelDelete,
      async (channel) => {
        if (!('guildId' in channel) || channel.guildId !== config.discord.guildId) return;

        const pair = channelStore.getByDiscord(channel.id);
        if (!pair) return;

        logger.info(`SyncBridge: Discord→Nerimity DELETE #${pair.name}`);
        await nerimityApi.deleteChannel(pair.nerimityChannelId);
        channelStore.removePairByDiscord(channel.id);
      }
    );
  }
}

export const syncBridge = new SyncBridge();
