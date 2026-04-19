import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { NerMessage, NerChannel } from './api';

// ---- Types d'événements Socket.IO Nerimity ----

export interface NerSocketMessage extends NerMessage {}

export interface NerChannelCreated {
  id: string;
  name: string;
  type: number;
  serverId: string;
}

export interface NerChannelUpdated {
  channelId: string;
  updated: { name?: string };
}

export interface NerChannelDeleted {
  channelId: string;
  serverId: string;
}

// Payload du event "ready" Nerimity (envoyé après connexion Socket.IO)
// Contient toute la structure : serveurs, channels, etc.
export interface NerReadyPayload {
  servers?: Array<{
    id: string;
    name: string;
    channels?: NerChannel[];
  }>;
  serverMembers?: unknown[];
  [key: string]: unknown;
}

export class NerimityClient extends EventEmitter {
  private socket!: Socket;
  // Cache des channels reçus via le ready event
  private _cachedChannels: NerChannel[] = [];

  connect(): void {
    logger.info('Connexion au WebSocket Nerimity...');

    this.socket = io(config.nerimity.socketUrl, {
      transports: ['websocket'],
      auth: { token: config.nerimity.token },
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      logger.info('✅ Nerimity WebSocket connecté (attente du ready event...)');
    });

    this.socket.on('disconnect', (reason: string) => {
      logger.warn(`⚠️  Nerimity WebSocket déconnecté : ${reason}`);
      this.emit('disconnect');
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.error('Erreur connexion Nerimity WebSocket', { message: err.message });
    });

    // --- Ready event : Nerimity envoie toute la structure au moment de la connexion ---
    // On capture les channels ici pour éviter d'avoir à faire un appel REST
    const handleReady = (data: NerReadyPayload) => {
      logger.info('✅ Nerimity ready event reçu');

      // Cherche notre serveur dans la liste des serveurs
      const server = data?.servers?.find(s => s.id === config.nerimity.serverId);
      if (server?.channels) {
        this._cachedChannels = server.channels;
        logger.info(`Nerimity: ${this._cachedChannels.length} channels chargés depuis le ready event`);
      } else {
        logger.warn('Nerimity ready: serveur non trouvé ou pas de channels dans le payload');
        logger.debug('Serveurs reçus:', data?.servers?.map(s => ({ id: s.id, name: s.name })));
      }

      this.emit('ready');
    };

    // Nerimity utilise "ready" comme nom d'event Socket.IO
    this.socket.on('ready', handleReady);
    // Fallback au cas où le nom est différent
    this.socket.on('READY', handleReady);

    // --- Réception de messages ---
    this.socket.on('MESSAGE_CREATED', (data: NerSocketMessage) => {
      logger.debug('Nerimity MESSAGE_CREATED', { channelId: data.channelId, user: data.createdBy?.username });
      this.emit('message', data);
    });

    // --- Gestion des channels ---
    this.socket.on('CHANNEL_CREATED', (data: NerChannelCreated) => {
      logger.info(`Nerimity: nouveau channel créé — ${data.name}`);
      this.emit('channelCreated', data);
    });

    this.socket.on('CHANNEL_UPDATED', (data: NerChannelUpdated) => {
      logger.info(`Nerimity: channel mis à jour — ${data.channelId}`);
      this.emit('channelUpdated', data);
    });

    this.socket.on('CHANNEL_DELETED', (data: NerChannelDeleted) => {
      logger.info(`Nerimity: channel supprimé — ${data.channelId}`);
      this.emit('channelDeleted', data);
    });

    // Debug : log tous les events inconnus (pour découvrir les vrais noms)
    const originalOnEvent = this.socket.onAny.bind(this.socket);
    originalOnEvent((eventName: string, ...args: unknown[]) => {
      const knownEvents = ['connect', 'disconnect', 'connect_error', 'ready', 'READY',
        'MESSAGE_CREATED', 'CHANNEL_CREATED', 'CHANNEL_UPDATED', 'CHANNEL_DELETED'];
      if (!knownEvents.includes(eventName)) {
        logger.debug(`Nerimity event inconnu reçu: "${eventName}"`, {
          preview: JSON.stringify(args[0])?.slice(0, 100)
        });
      }
    });
  }

  /** Retourne les channels du serveur (depuis le cache du ready event) */
  getCachedChannels(): NerChannel[] {
    return this._cachedChannels;
  }

  disconnect(): void {
    this.socket?.disconnect();
  }

  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

export const nerimityClient = new NerimityClient();
