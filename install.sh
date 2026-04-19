#!/usr/bin/env bash
# ============================================================
#  BBDN — Nerimity ↔ Discord Bridge — Script d'installation
#  Usage : git clone https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git && bash Bot-Bridge-Discord-Nerimity/install.sh
# ============================================================

set -euo pipefail

REPO_URL="https://github.com/France-OPG/Bot-Bridge-Discord-Nerimity.git"
INSTALL_DIR="/opt/bbdn"
BIN_NAME="bbdn-maj"
SERVICE_NAME="bbdn"
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Couleurs ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[•]${RESET} $*"; }
success() { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
error()   { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }

# ── Détection OS ──────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_LIKE=${ID_LIKE:-""}
  elif command -v lsb_release &>/dev/null; then
    OS=$(lsb_release -si | tr '[:upper:]' '[:lower:]')
  else
    OS="unknown"
  fi
}

# ── Vérification root ─────────────────────────────────────
check_root() {
  if [ "$EUID" -ne 0 ]; then
    error "Ce script doit être exécuté en tant que root (sudo bash install.sh)"
  fi
}

# ── Installation Node.js 20 ───────────────────────────────
install_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [ "$NODE_VERSION" -ge 20 ]; then
      success "Node.js $(node -v) déjà installé"
      return
    fi
    warn "Node.js $(node -v) trop vieux, mise à jour vers v20..."
  fi

  info "Installation de Node.js 20..."
  case "$OS" in
    ubuntu|debian|linuxmint|pop)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
      ;;
    centos|rhel|fedora|rocky|almalinux)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      yum install -y nodejs || dnf install -y nodejs
      ;;
    arch|manjaro)
      pacman -Sy --noconfirm nodejs npm
      ;;
    alpine)
      apk add --no-cache nodejs npm
      ;;
    *)
      error "Distribution '$OS' non supportée. Installe Node.js 20+ manuellement puis relance le script."
      ;;
  esac
  success "Node.js $(node -v) installé"
}

# ── Dépendances système ────────────────────────────────────
install_system_deps() {
  info "Installation des dépendances système (opus, ffmpeg, build-tools)..."
  case "$OS" in
    ubuntu|debian|linuxmint|pop)
      apt-get install -y ffmpeg libopus-dev python3 make g++ git curl
      ;;
    centos|rhel|fedora|rocky|almalinux)
      yum install -y ffmpeg opus-devel python3 make gcc-c++ git curl 2>/dev/null || \
      dnf install -y ffmpeg opus-devel python3 make gcc-c++ git curl
      ;;
    arch|manjaro)
      pacman -Sy --noconfirm ffmpeg opus python3 make base-devel git curl
      ;;
    alpine)
      apk add --no-cache ffmpeg opus-dev python3 make g++ git curl
      ;;
  esac
  success "Dépendances système installées"
}

# ── Installation PM2 ──────────────────────────────────────
install_pm2() {
  if command -v pm2 &>/dev/null; then
    success "PM2 déjà installé ($(pm2 -v))"
    return
  fi
  info "Installation de PM2..."
  npm install -g pm2
  success "PM2 installé"
}

# ── Copie / clone du repo ─────────────────────────────────
setup_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    warn "$INSTALL_DIR existe déjà — on fait juste une mise à jour"
    cd "$INSTALL_DIR"
    git pull origin main
  elif [ -f "$CURRENT_DIR/package.json" ] && [ -f "$CURRENT_DIR/tsconfig.json" ]; then
    # Lancé depuis l'intérieur du repo cloné → on le copie en place
    info "Copie du repo vers $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    cp -r "$CURRENT_DIR/." "$INSTALL_DIR/"
    cd "$INSTALL_DIR"
  else
    info "Clone du repo depuis GitHub..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  success "Repo en place dans $INSTALL_DIR"
}

# ── Configuration .env ────────────────────────────────────
setup_env() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    warn ".env déjà présent — on ne l'écrase pas"
    return
  fi

  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

  echo ""
  echo -e "${BOLD}Configuration du bridge — remplis les 4 valeurs suivantes :${RESET}"
  echo ""

  read -rp "  DISCORD_TOKEN       : " DISCORD_TOKEN
  read -rp "  DISCORD_GUILD_ID    : " DISCORD_GUILD_ID
  read -rp "  NERIMITY_TOKEN      : " NERIMITY_TOKEN
  read -rp "  NERIMITY_SERVER_ID  : " NERIMITY_SERVER_ID

  sed -i "s|DISCORD_TOKEN=.*|DISCORD_TOKEN=$DISCORD_TOKEN|"           "$INSTALL_DIR/.env"
  sed -i "s|DISCORD_GUILD_ID=.*|DISCORD_GUILD_ID=$DISCORD_GUILD_ID|" "$INSTALL_DIR/.env"
  sed -i "s|NERIMITY_TOKEN=.*|NERIMITY_TOKEN=$NERIMITY_TOKEN|"       "$INSTALL_DIR/.env"
  sed -i "s|NERIMITY_SERVER_ID=.*|NERIMITY_SERVER_ID=$NERIMITY_SERVER_ID|" "$INSTALL_DIR/.env"

  success ".env configuré"
}

# ── Build ─────────────────────────────────────────────────
build_project() {
  info "Installation des dépendances npm..."
  cd "$INSTALL_DIR"
  npm install

  info "Compilation TypeScript..."
  npm run build
  success "Build terminé"
}

# ── Service PM2 ───────────────────────────────────────────
setup_pm2_service() {
  info "Démarrage du service PM2..."
  cd "$INSTALL_DIR"

  # Stop l'ancien process s'il tourne déjà
  pm2 stop "$SERVICE_NAME" 2>/dev/null || true
  pm2 delete "$SERVICE_NAME" 2>/dev/null || true

  pm2 start dist/index.js \
    --name "$SERVICE_NAME" \
    --restart-delay=5000 \
    --max-restarts=10 \
    --log "$INSTALL_DIR/logs/bridge.log" \
    --error "$INSTALL_DIR/logs/error.log"

  pm2 save

  # Activation au boot selon l'init system
  if command -v systemctl &>/dev/null; then
    pm2 startup systemd -u root --hp /root | tail -1 | bash 2>/dev/null || true
  elif command -v rc-update &>/dev/null; then
    pm2 startup openrc -u root --hp /root | tail -1 | bash 2>/dev/null || true
  fi

  mkdir -p "$INSTALL_DIR/logs"
  success "Service PM2 '$SERVICE_NAME' démarré et activé au boot"
}

# ── Commande bbdn-maj ─────────────────────────────────────
install_update_command() {
  info "Installation de la commande 'bbdn-maj'..."

  cat > "/usr/local/bin/$BIN_NAME" << UPDATESCRIPT
#!/usr/bin/env bash
# bbdn-maj — Met à jour le bot Nerimity ↔ Discord Bridge
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

INSTALL_DIR="$INSTALL_DIR"
SERVICE_NAME="$SERVICE_NAME"
REPO_URL="$REPO_URL"

info()    { echo -e "\${CYAN}[•]\${RESET} \$*"; }
success() { echo -e "\${GREEN}[✓]\${RESET} \$*"; }
warn()    { echo -e "\${YELLOW}[!]\${RESET} \$*"; }
error()   { echo -e "\${RED}[✗]\${RESET} \$*"; exit 1; }

if [ "\$EUID" -ne 0 ]; then
  error "Lance avec sudo : sudo bbdn-maj"
fi

echo -e "\n\${BOLD}\${CYAN}══ BBDN — Mise à jour ══\${RESET}\n"

# Vérifie que le répertoire existe
if [ ! -d "\$INSTALL_DIR/.git" ]; then
  error "Répertoire \$INSTALL_DIR introuvable ou pas un repo git. Relance install.sh."
fi

cd "\$INSTALL_DIR"

# Sauvegarde .env
info "Sauvegarde du .env..."
cp .env .env.backup

# Récupère les dernières modifications
info "Récupération des mises à jour depuis GitHub..."
BEFORE=\$(git rev-parse HEAD)
git fetch origin main
git reset --hard origin/main
AFTER=\$(git rev-parse HEAD)

if [ "\$BEFORE" = "\$AFTER" ]; then
  warn "Déjà à jour (\$AFTER) — rien à faire"
  # Restaure .env au cas où git reset l'aurait écrasé
  cp .env.backup .env
  exit 0
fi

# Restaure le .env (git reset --hard peut l'écraser si suivi)
cp .env.backup .env
success "Mis à jour : \$BEFORE → \$AFTER"

# Affiche le changelog depuis l'ancienne version
echo ""
echo -e "\${BOLD}Commits depuis la dernière version :\${RESET}"
git log --oneline "\$BEFORE...\$AFTER" || true
echo ""

# Réinstalle les dépendances si package.json a changé
if git diff --name-only "\$BEFORE" "\$AFTER" | grep -q "package.json"; then
  info "package.json modifié, réinstallation des dépendances..."
  npm install
else
  info "package.json inchangé, pas de réinstallation"
fi

# Recompile
info "Recompilation TypeScript..."
npm run build

# Redémarre le service
info "Redémarrage du service PM2 '\$SERVICE_NAME'..."
pm2 restart "\$SERVICE_NAME" || pm2 start dist/index.js --name "\$SERVICE_NAME"
pm2 save

echo ""
success "Mise à jour terminée ! Version : \$AFTER"
echo -e "  Logs : \${CYAN}pm2 logs \$SERVICE_NAME\${RESET}"
echo ""
UPDATESCRIPT

  chmod +x "/usr/local/bin/$BIN_NAME"
  success "Commande '$BIN_NAME' installée dans /usr/local/bin/"
}

# ── Résumé final ──────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗"
  echo -e "║     BBDN installé avec succès !              ║"
  echo -e "╚══════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${CYAN}Logs en direct   :${RESET}  pm2 logs $SERVICE_NAME"
  echo -e "  ${CYAN}Statut           :${RESET}  pm2 status"
  echo -e "  ${CYAN}Arrêter          :${RESET}  pm2 stop $SERVICE_NAME"
  echo -e "  ${CYAN}Mettre à jour    :${RESET}  sudo $BIN_NAME"
  echo -e "  ${CYAN}Config           :${RESET}  nano $INSTALL_DIR/.env"
  echo ""
  echo -e "  ${YELLOW}⚠  Pense à vérifier que le .env est bien configuré :${RESET}"
  echo -e "     nano $INSTALL_DIR/.env"
  echo ""
}

# ══════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════
check_root
detect_os

header "Détection OS"
success "OS détecté : $OS"

header "Dépendances système"
install_system_deps

header "Node.js"
install_node

header "PM2"
install_pm2

header "Repo"
setup_repo

header "Configuration"
setup_env

header "Build"
build_project

header "Service"
setup_pm2_service

header "Commande bbdn-maj"
install_update_command

print_summary
