import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioReceiveStream,
  VoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
  AudioPlayer,
  AudioPlayerStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { VoiceState, ChannelType } from 'discord.js';
import { discordBot } from '../discord/client';
import { channelStore } from '../utils/channelStore';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PassThrough, Readable } from 'stream';

/**
 * VoiceBridge — relaie l'audio entre les channels vocaux Discord et Nerimity
 *
 * Architecture :
 *   Discord Voice → PCM stream → MixingStream → Nerimity (UDP/WebSocket audio)
 *   Nerimity audio → PCM → Discord AudioPlayer
 *
 * NOTE : Nerimity ne dispose pas d'API vocale publique documentée à ce jour.
 * Ce module implémente le côté Discord (complet) et prépare les hooks pour
 * brancher Nerimity dès que son API vocale sera disponible.
 * Un commentaire TODO marque chaque point d'intégration Nerimity.
 */

interface VoiceSession {
  discordConnection: VoiceConnection;
  player: AudioPlayer;
  mixStream: PassThrough;
  nerimityChannelId: string;
  discordChannelId: string;
  // Streams par utilisateur Discord (pour pouvoir les fermer proprement)
  userStreams: Map<string, AudioReceiveStream>;
}

class VoiceBridge {
  private sessions = new Map<string, VoiceSession>(); // key = nerimityChannelId

  init(): void {
    if (!config.bridge.voiceEnabled) {
      logger.info('VoiceBridge: désactivé (VOICE_BRIDGE_ENABLED=false)');
      return;
    }

    this.listenDiscordVoiceState();
    logger.info('VoiceBridge initialisé');
  }

  // ─────────────────────────────────────────────
  //  GESTION DES VOICE STATES DISCORD
  //  Quand quelqu'un rejoint/quitte un vocal bridgé, on gère la session
  // ─────────────────────────────────────────────

  private listenDiscordVoiceState(): void {
    discordBot.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
      const joined = !oldState.channelId && newState.channelId;
      const left = oldState.channelId && !newState.channelId;
      const moved = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

      if (joined || moved) {
        const channelId = newState.channelId!;
        const pair = channelStore.getByDiscord(channelId);
        if (pair?.type !== 'voice') return;

        // Le bot ne doit pas se rejoindre lui-même
        if (newState.member?.user.bot) return;

        logger.info(`VoiceBridge: utilisateur rejoint le vocal Discord #${pair.name}`);
        await this.ensureSession(pair.nerimityChannelId, channelId);
      }

      if (left || moved) {
        const channelId = oldState.channelId!;
        const pair = channelStore.getByDiscord(channelId);
        if (!pair || pair.type !== 'voice') return;

        // Vérifie s'il reste des utilisateurs humains dans le channel
        const channel = discordBot.channels.cache.get(channelId);
        if (channel?.type === ChannelType.GuildVoice) {
          const members = channel.members.filter(m => !m.user.bot);
          if (members.size === 0) {
            logger.info(`VoiceBridge: plus d'utilisateurs dans #${pair.name}, fermeture de la session`);
            this.closeSession(pair.nerimityChannelId);
          }
        }
      }
    });
  }

  // ─────────────────────────────────────────────
  //  CRÉATION D'UNE SESSION VOICE
  // ─────────────────────────────────────────────

  private async ensureSession(
    nerimityChannelId: string,
    discordChannelId: string
  ): Promise<void> {
    if (this.sessions.has(nerimityChannelId)) return;

    const channel = discordBot.channels.cache.get(discordChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      logger.warn(`VoiceBridge: channel vocal Discord ${discordChannelId} introuvable`);
      return;
    }

    // Rejoindre le channel vocal Discord
    const connection = joinVoiceChannel({
      channelId: discordChannelId,
      guildId: config.discord.guildId,
      // Cast nécessaire : conflit de types discord-api-types entre discord.js et @discordjs/voice
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,   // doit écouter les autres
      selfMute: false,   // peut parler (pour relayer Nerimity)
    });

    // Attendre que la connexion soit établie
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      logger.info(`VoiceBridge: connecté au vocal Discord #${channel.name}`);
    } catch {
      connection.destroy();
      logger.error(`VoiceBridge: timeout connexion vocal Discord #${channel.name}`);
      return;
    }

    // Flux de mixage pour combiner tous les utilisateurs Discord → sortie unique vers Nerimity
    const mixStream = new PassThrough();

    // Player Discord (recevra l'audio de Nerimity)
    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      discordConnection: connection,
      player,
      mixStream,
      nerimityChannelId,
      discordChannelId,
      userStreams: new Map(),
    };
    this.sessions.set(nerimityChannelId, session);

    // Écouter les utilisateurs déjà présents
    this.attachDiscordReceiver(session);

    // Gérer les déconnexions propres
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        this.closeSession(nerimityChannelId);
      }
    });

    // TODO: connecter ici à Nerimity voice quand l'API sera disponible
    // this.connectNerimityVoice(session);

    logger.info(`VoiceBridge: session ouverte pour #${channel.name}`);
  }

  // ─────────────────────────────────────────────
  //  RÉCEPTION AUDIO DISCORD → (vers Nerimity)
  // ─────────────────────────────────────────────

  private attachDiscordReceiver(session: VoiceSession): void {
    const receiver = session.discordConnection.receiver;

    // Quand un utilisateur commence à parler
    receiver.speaking.on('start', (userId: string) => {
      if (session.userStreams.has(userId)) return;

      logger.debug(`VoiceBridge: utilisateur ${userId} parle`);

      // Stream audio PCM de cet utilisateur (Opus → PCM 48kHz 16bit stéréo)
      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 100,
        },
      });

      session.userStreams.set(userId, audioStream);

      // Pipe vers le stream de mixage
      audioStream.pipe(session.mixStream, { end: false });

      audioStream.on('end', () => {
        session.userStreams.delete(userId);
        logger.debug(`VoiceBridge: utilisateur ${userId} a arrêté de parler`);
      });

      // TODO: quand Nerimity aura une API vocale, envoyer session.mixStream
      // vers la connexion Nerimity ici :
      // nerimityVoice.send(session.mixStream);
    });
  }

  // ─────────────────────────────────────────────
  //  AUDIO NERIMITY → DISCORD
  //  (stub prêt à brancher dès que l'API Nerimity voice sera dispo)
  // ─────────────────────────────────────────────

  /**
   * Relaie un flux audio venant de Nerimity vers le channel vocal Discord.
   * À appeler quand Nerimity envoie du PCM.
   *
   * @param nerimityChannelId - ID du channel vocal Nerimity
   * @param audioStream - Stream PCM 48kHz stéréo depuis Nerimity
   */
  relayNerimityAudioToDiscord(nerimityChannelId: string, audioStream: Readable): void {
    const session = this.sessions.get(nerimityChannelId);
    if (!session) {
      logger.warn(`VoiceBridge: aucune session pour le canal Nerimity ${nerimityChannelId}`);
      return;
    }

    try {
      const resource = createAudioResource(audioStream);
      session.player.play(resource);

      session.player.on(AudioPlayerStatus.Idle, () => {
        logger.debug('VoiceBridge: player Discord inactif');
      });
    } catch (err) {
      logger.error('VoiceBridge: erreur relais Nerimity→Discord', { err });
    }
  }

  // ─────────────────────────────────────────────
  //  FERMETURE DE SESSION
  // ─────────────────────────────────────────────

  closeSession(nerimityChannelId: string): void {
    const session = this.sessions.get(nerimityChannelId);
    if (!session) return;

    // Ferme tous les streams utilisateur
    session.userStreams.forEach(stream => stream.destroy());
    session.userStreams.clear();

    // Ferme le mix stream
    session.mixStream.destroy();

    // Arrête le player
    session.player.stop();

    // Quitte le vocal Discord
    session.discordConnection.destroy();

    this.sessions.delete(nerimityChannelId);
    logger.info(`VoiceBridge: session fermée (${nerimityChannelId})`);
  }

  closeAllSessions(): void {
    for (const id of this.sessions.keys()) {
      this.closeSession(id);
    }
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }
}

export const voiceBridge = new VoiceBridge();
