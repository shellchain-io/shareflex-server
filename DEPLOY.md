# ShareFlex cloud API — deploy (GCE + R2)

Friends keep using the **Mac** server (`Code/server`). This package (`server-cloud`) is the cloud copy.

## Architecture

- **Mac:** encode HLS at 1080p / 720p / 480p → `npm run publish-r2 -- movies/<id>`
- **Cloudflare R2:** public media bytes
- **GCE VM (`shareflex-api`):** Node API + SQLite only

## Mac setup (encode + upload)

```bash
cd Code
cp server-cloud/.env.example server-cloud/.env
# Fill JWT/SEED from server/.env; fill R2 + MEDIA_PUBLIC_BASE_URL from credentials.md
npm install
npm run server-cloud:generate
npm run server-cloud:db:migrate
npm run server-cloud:db:seed
```

Encode (same as before, but against cloud media root):

```bash
npm run add-movie -w @shareflex/server-cloud -- /path/to/file.mkv
```

Auto-upload to R2 runs after encode when R2 keys are in `.env`.

**Prefer the admin UI:** Library → open movie/show → **Reupload CDN** (or **Reupload season to CDN**). Progress shows under **Jobs**. Manual CLI is only a fallback:

```bash
npm run server-cloud:publish-r2 -- movies/<id>
```

## Private GitHub → GCE

1. Create a **private** repo; push only `server-cloud` (or the whole Code tree **without** `.env` / `credentials.md` / `media*`).
2. On the VM (browser SSH):

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# clone with deploy key or PAT
git clone git@github.com:YOU/shareflex-cloud.git
cd shareflex-cloud/Code/server-cloud   # adjust path to where package lives
cp .env.example .env
nano .env   # paste secrets; HOST=0.0.0.0; MEDIA_PUBLIC_BASE_URL=https://pub-….r2.dev
npm install
npx prisma generate
npx prisma migrate deploy
npm run db:seed
npm run build
```

3. **systemd** (best — survives SSH close + VM reboot). On the VM:

```bash
# stop any manual npm start first (Ctrl+C)
which node   # note path, usually /usr/bin/node

sudo tee /etc/systemd/system/shareflex.service >/dev/null <<'EOF'
[Unit]
Description=ShareFlex cloud API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bjbjpedradduxanea
WorkingDirectory=/home/bjbjpedradduxanea/shareflex-server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now shareflex
sudo systemctl status shareflex --no-pager
curl -sS http://127.0.0.1:8787/health
```

Useful later:
```bash
sudo systemctl restart shareflex   # after git pull + npm run build
sudo journalctl -u shareflex -f    # logs
```

**Note:** If you **Suspend** the VM in Google Cloud, nothing runs until you **Start** it again. systemd starts ShareFlex automatically on boot after Start/reboot — not while suspended.

4. Firewall: allow **tcp:8787** (already done if you created `allow-shareflex-8787`).
5. Health: `curl http://34.47.238.195:8787/health`
6. iPhone **Account → Server:** `http://34.47.238.195:8787`

## Quality (mobile)

Player defaults to **Auto** (ABR from master.m3u8). User can lock **480p / 720p / 1080p** in the player UI.
