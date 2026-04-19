# 🔗 Nerimity ↔ Discord Bridge

> Bot passerelle bidirectionnel entre **[Nerimity](https://nerimity.com)** et **Discord** — messages texte en temps réel, synchronisation de la structure des salons et bridge vocal.

![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--3.0-green)

---

## 📋 Fonctionnalités

| Feature | État |
|---|:---:|
| Messages texte **Nerimity → Discord** | ✅ |
| Messages texte **Discord → Nerimity** | ✅ |
| Affichage avec pseudo + avatar de l'expéditeur | ✅ |
| Système anti-boucle (pas de doublons) | ✅ |
| Sync **création** de salons (les deux sens) | ✅ |
| Sync **renommage** de salons (les deux sens) | ✅ |
| Sync **suppression** de salons (les deux sens) | ✅ |
| Persistance de la map salons (redémarrage safe) | ✅ |
| Bridge vocal — côté **Discord** (réception PCM) | ✅ |
| Bridge vocal — côté **Nerimity** (API non encore publique) | 🔜 |

---

## ⚡ Installation en une commande

```bash
git clone https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git && sudo bash Bot-Bridge-Discord-Nerimity/install.sh
```

Le script installe tout automatiquement : Node.js 20, dépendances système, build TypeScript, service PM2 avec démarrage au boot, et la commande `bbdn-maj`.

> **Distributions supportées :** Ubuntu, Debian, Fedora, CentOS/RHEL, Arch, Alpine

---

## 🔄 Mettre à jour le bot

Une seule commande depuis n'importe où sur la machine :

```bash
sudo bbdn-maj
```

Cette commande :
1. Récupère les dernières modifications depuis GitHub
2. Affiche le changelog (commits depuis ta version)
3. Réinstalle les dépendances npm si `package.json` a changé
4. Recompile le TypeScript
5. Redémarre le service PM2 automatiquement

---

## 🏗️ Architecture

```
src/
├── index.ts                    Point d'entrée, bootstrap, arrêt propre
├── config/
│   └── index.ts                Chargement et validation du fichier .env
├── utils/
│   ├── logger.ts               Logger Winston (couleurs + timestamps)
│   └── channelStore.ts         Persistance JSON de la map Nerimity ID ↔ Discord ID
├── nerimity/
│   ├── api.ts                  Client REST Nerimity (messages, channels)
│   └── client.ts               Client Socket.IO Nerimity (événements temps réel)
├── discord/
│   └── client.ts               Bot Discord.js + gestion des webhooks par salon
├── bridge/
│   ├── textBridge.ts           Routage bidirectionnel des messages texte
│   └── syncBridge.ts           Sync création / renommage / suppression de salons
└── voice/
    └── voiceBridge.ts          Bridge audio PCM Discord ↔ Nerimity
```

### Flux de données

```
 Nerimity                          Bot Bridge                         Discord
    │                                  │                                 │
    │── Socket.IO MESSAGE_CREATED ──►  │                                 │
    │                                  │──── Webhook (pseudo + avatar) ──►│
    │                                  │                                 │
    │◄── REST POST /messages ──────── │◄─── messageCreate event ────────│
    │                                  │                                 │
    │── CHANNEL_CREATED ────────────►  │──── guild.channels.create() ───►│
    │◄── POST /channels ────────────  │◄─── ChannelCreate event ────────│
```

---

## 🛠️ Installation manuelle (sans le script)

### Option A — Docker / Docker Compose *(Proxmox)*

```bash
git clone https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git
cd Bot-Bridge-Discord-Nerimity
cp .env.example .env
nano .env                  # remplis les 4 valeurs obligatoires
docker-compose up -d
docker-compose logs -f
```

### Option B — LXC Proxmox (PM2)

```bash
# Dépendances système
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg libopus-dev python3 make g++

# Clone et config
cd /opt
git clone https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git bbdn
cd bbdn
cp .env.example .env && nano .env

# Build et démarrage
npm install && npm run build
npm install -g pm2
pm2 start dist/index.js --name bbdn
pm2 save && pm2 startup
```

### Option C — Développement local

```bash
git clone https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git
cd Bot-Bridge-Discord-Nerimity
cp .env.example .env && nano .env
npm install
npm run dev:watch    # redémarre automatiquement à chaque modification
```

---

## ⚙️ Configuration

Copie `.env.example` en `.env` et remplis les valeurs :

```env
# ── Discord ─────────────────────────────────────────────────
# Token du bot (discord.com/developers/applications → Bot → Token)
DISCORD_TOKEN=ton_token_discord_ici

# ID du serveur Discord (clic droit sur le serveur → Copier l'identifiant)
DISCORD_GUILD_ID=123456789012345678

# ── Nerimity ────────────────────────────────────────────────
# Token du bot Nerimity (nerimity.com → Paramètres → Bot → Créer un bot)
NERIMITY_TOKEN=ton_token_nerimity_ici

# ID du serveur Nerimity (paramètres du serveur ou URL)
NERIMITY_SERVER_ID=123456789012345678

# ── Bridge ──────────────────────────────────────────────────
BRIDGE_PREFIX_DISCORD=[Discord]
BRIDGE_PREFIX_NERIMITY=[Nerimity]
VOICE_BRIDGE_ENABLED=true

# ── Logs ────────────────────────────────────────────────────
LOG_LEVEL=info
```

---

## 🤖 Créer le bot Discord

1. Va sur [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → donne un nom (ex: `Nerimity Bridge`)
3. Onglet **Bot** → **Reset Token** → copie le token dans `.env`
4. Active les **Privileged Gateway Intents** :
   - ✅ `SERVER MEMBERS INTENT`
   - ✅ `MESSAGE CONTENT INTENT`
5. Onglet **OAuth2 → URL Generator** :
   - **Scopes** : `bot`
   - **Permissions** : `Read Messages`, `Send Messages`, `Manage Channels`, `Manage Webhooks`, `Read Message History`, `Connect`, `Speak`
6. Copie l'URL et invite le bot sur ton serveur Discord

---

## 🟣 Créer le bot Nerimity

1. Connecte-toi sur [nerimity.com](https://nerimity.com)
2. Clique sur ton avatar → **Paramètres** → **Bot**
3. **Créer un bot** → copie le token dans `.env`
4. Invite le bot sur ton serveur Nerimity via son profil

---

## 🔊 Bridge vocal — état actuel

**Discord ✅** — le bot rejoint automatiquement les vocaux, reçoit le PCM de chaque utilisateur (décodage Opus), mixe les flux, reconnexion automatique.

**Nerimity 🔜** — l'API vocale Nerimity n'est pas encore publique. Des hooks `TODO` sont prêts dans `voiceBridge.ts` pour brancher le flux dès qu'elle sera disponible.

---

## 🛟 Commandes utiles

```bash
sudo bbdn-maj               # mettre à jour le bot
pm2 logs bbdn               # voir les logs en direct
pm2 status                  # état du service
pm2 restart bbdn            # redémarrer manuellement
pm2 stop bbdn               # arrêter
nano /opt/bbdn/.env         # modifier la config
```

---

## 🛠️ Dépannage

**Le bot ne reçoit pas les messages Discord**
→ Vérifie que l'intent `MESSAGE CONTENT` est activé dans le portail développeur Discord.

**Les salons ne se synchronisent pas**
→ Le bot Discord doit avoir la permission `Manage Channels`.

**Les messages se doublent**
→ Vérifie que le bot Discord ignore bien `msg.author.bot` (c'est le cas par défaut).

**Erreur `sodium-native` ou `@discordjs/opus`**
→ `sudo apt install -y python3 make g++ libopus-dev` puis `npm install`.

**Erreur TypeScript à la compilation**
→ Le projet épingle `discord-api-types@0.37.83` via `overrides` dans `package.json` pour éviter le conflit de versions entre `discord.js` et `@discordjs/voice`. Supprime `node_modules/` et relance `npm install`.

**`channel-map.json` vide après redémarrage (Docker)**
→ Vérifie que le volume `./data:/app/data` est monté dans `docker-compose.yml`.

---

## 📦 Stack technique

| Lib | Version | Rôle |
|---|---|---|
| `discord.js` | 14 | Bot Discord (texte, channels, webhooks) |
| `@discordjs/voice` | 0.17 | Connexion et réception audio Discord |
| `@discordjs/opus` | 0.9 | Encodage / décodage Opus |
| `socket.io-client` | 4.7 | WebSocket temps réel Nerimity |
| `axios` | 1.6 | REST API Nerimity |
| `winston` | 3.11 | Logger structuré |
| `dotenv` | 16 | Chargement `.env` |
| `sodium-native` | 4 | Chiffrement audio Discord |
| `prism-media` | 1.3 | Transcodage PCM |
| `typescript` | 5.3 | Typage statique |

---

## 📄 Licence

GPL-3.0 — voir [LICENSE](LICENSE).
