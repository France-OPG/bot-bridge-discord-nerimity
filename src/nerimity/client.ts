import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { NerChannel } from './api';

// ─────────────────────────────────────────────────────────────
//  Noms des events — tirés directement du code source Nerimity
//  github.com/Nerimity/nerimity-server/blob/main/src/common/
// ─────────────────────────────────────────────────────────────

// Client → Serveur (on envoie ces events)
const EV_AUTHENTICATE = 'user:authenticate';

// Serveur → Client (on reçoit ces events)
const EV_AUTHENTICATED        = 'user:authenticated';
const EV_AUTHENTICATE_ERROR   = 'user:authenticate_error';
const EV_MESSAGE_CREATED      = 'message:created';
const EV_SERVER_CHANNEL_CREATED = 'server:channel_created';
const EV_SERVER_CHANNEL_UPDATED = 'server:channel_updated';
const EV_SERVER_CHANNEL_DELETED = 'server:channel_deleted';

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

export interface NerSocketMessage {
  id: string;
  content: string;
  channelId: string;
  createdBy: {
    id: string;
    username: string;
    tag: string;
    avatar?: string;
  };
}

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

// Payload du event user:authenticated
// Contient toutes les données : serveurs, channels, présence…
interface NerAuthenticatedPayload {
  servers?: Array<{
    id: string;
    name: string;
    channels?: NerChannel[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
//  Client
// ─────────────────────────────────────────────────────────────

export class NerimityClient extends EventEmitter {
  private socket!: Socket;
  private _cachedChannels: NerChannel[] = [];

  connect(): void {
    logger.info('Connexion au WebSocket Nerimity...');

    // Connexion SANS token dans le handshake — Nerimity utilise
    // un event dédié "user:authenticate" après connexion
    this.socket = io(config.nerimity.socketUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
    });

    // ── Connexion établie → on s'authentifie ──────────────────
    this.socket.on('connect', () => {
      logger.info('✅ Nerimity WebSocket connecté, envoi du token...');
      // Nerimity attend le token via cet event dans les 30s
      // sinon il déconnecte ("Authentication timed out")
      this.socket.emit(EV_AUTHENTICATE, { token: config.nerimity.token });
    });

    // ── Authentification réussie → on reçoit toutes les données ─
    this.socket.on(EV_AUTHENTICATED, (data: NerAuthenticatedPayload) => {
      logger.info('✅ Nerimity authentifié (user:authenticated reçu)');

      // Cherche notre serveur dans la liste et cache ses channels
      const server = data?.servers?.find(
        s => s.id === config.nerimity.serverId
      );
      if (server?.channels && server.channels.length > 0) {
        this._cachedChannels = server.channels;
        logger.info(`Nerimity: ${this._cachedChannels.length} channels chargés`);
      } else {
        logger.warn('Nerimity: serveur non trouvé ou pas de channels dans le payload authenticated');
        logger.debug('IDs serveurs reçus:', data?.servers?.map(s => s.id));
      }

      this.emit('ready');
    });

    // ── Erreur d'authentification ─────────────────────────────
    this.socket.on(EV_AUTHENTICATE_ERROR, (err: unknown) => {
      logger.error('❌ Nerimity: erreur authentification', { err });
    });

    // ── Déconnexion ───────────────────────────────────────────
    this.socket.on('disconnect', (reason: string) => {
      logger.warn(`⚠️  Nerimity WebSocket déconnecté : ${reason}`);
      this.emit('disconnect');
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.error('Erreur connexion Nerimity', { message: err.message });
    });

    // ── Messages texte ────────────────────────────────────────
    this.socket.on(EV_MESSAGE_CREATED, (data: NerSocketMessage) => {
      logger.debug('Nerimity message:created', {
        channelId: data.channelId,
        user: data.createdBy?.username,
      });
      this.emit('message', data);
    });

    // ── Gestion des channels (temps réel) ─────────────────────
    this.socket.on(EV_SERVER_CHANNEL_CREATED, (data: NerChannelCreated) => {
      logger.info(`Nerimity: channel créé — ${data.name}`);
      this.emit('channelCreated', data);
    });

    this.socket.on(EV_SERVER_CHANNEL_UPDATED, (data: NerChannelUpdated) => {
      logger.info(`Nerimity: channel mis à jour — ${data.channelId}`);
      this.emit('channelUpdated', data);
    });

    this.socket.on(EV_SERVER_CHANNEL_DELETED, (data: NerChannelDeleted) => {
      logger.info(`Nerimity: channel supprimé — ${data.channelId}`);
      this.emit('channelDeleted', data);
    });
  }

  /** Channels du serveur, disponibles après authentification */
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