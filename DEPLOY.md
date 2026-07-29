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

3. systemd unit (example):

```ini
[Unit]
Description=ShareFlex cloud API
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/YOU/shareflex-cloud/Code/server-cloud
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

4. Firewall: allow **tcp:8787** (already done if you created `allow-shareflex-8787`).
5. Health: `curl http://34.47.238.195:8787/health`
6. iPhone **Account → Server:** `http://34.47.238.195:8787`

## Quality (mobile)

Player defaults to **Auto** (ABR from master.m3u8). User can lock **480p / 720p / 1080p** in the player UI.
