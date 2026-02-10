#!/bin/bash
set -e

echo "═══════════════════════════════════════"
echo "  MTProxy Bot — Установка"
echo "═══════════════════════════════════════"

# ─── 1. Проверка Docker ───
if ! command -v docker &>/dev/null; then
  echo "📦 Установка Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "✅ Docker установлен. Перелогинься (exit + ssh) для применения группы."
fi

# ─── 2. Проверка Node.js ───
if ! command -v node &>/dev/null; then
  echo "📦 Установка Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node.js: $(node -v)"
echo "npm: $(npm -v)"
echo "Docker: $(docker -v)"

# ─── 3. Создание .env если нет ───
if [ ! -f .env ]; then
  echo ""
  echo "📝 Создаём .env файл..."
  cp .env.example .env
  echo "⚠️  ВАЖНО: Отредактируй .env файл!"
  echo "   nano .env"
  echo ""
  echo "Заполни:"
  echo "  BOT_TOKEN — от @BotFather"
  echo "  ADMIN_ID  — твой Telegram ID (узнать: @userinfobot)"
  echo "  SERVER_IP — IP этого сервера"
  echo ""
  exit 0
fi

# ─── 4. Установка зависимостей ───
echo "📦 Установка зависимостей..."
npm install

# ─── 5. Сборка TypeScript ───
echo "🔨 Сборка..."
npm run build

# ─── 6. Создание systemd сервиса ───
echo "🔧 Настройка systemd сервиса..."

WORK_DIR=$(pwd)

sudo tee /etc/systemd/system/mtproxy-bot.service > /dev/null <<EOF
[Unit]
Description=MTProxy Telegram Bot
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$WORK_DIR
ExecStart=/usr/bin/node $WORK_DIR/dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mtproxy-bot

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ Установка завершена!"
echo "═══════════════════════════════════════"
echo ""
echo "Следующие шаги:"
echo ""
echo "1. Отредактируй .env:"
echo "   nano .env"
echo ""
echo "2. Запусти бота:"
echo "   sudo systemctl start mtproxy-bot"
echo ""
echo "3. Проверь логи:"
echo "   sudo journalctl -u mtproxy-bot -f"
echo ""
echo "4. Управление:"
echo "   sudo systemctl stop mtproxy-bot    — остановить"
echo "   sudo systemctl restart mtproxy-bot — перезапуск"
echo "   sudo systemctl status mtproxy-bot  — статус"
echo ""
