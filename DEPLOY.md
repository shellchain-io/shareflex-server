# ShareFlex cloud API — deploy (GCE + R2)

Friends keep using the **Mac** server (`Code/server`). This package (`server-cloud`) is the cloud copy.

## Do this now (SSH works again after Reset)

Your VM filled with request logs until SSH died. You restarted — finish cleanup + quiet logging:

```bash
# 1) Free space from old journal spam
sudo journalctl --vacuum-size=80M
df -h /

# 2) Go to the app folder (adjust if your path differs)
cd ~/shareflex-server
# or: cd ~/shareflex-cloud/Code/server-cloud

# 3) Quiet logs in .env (required on GCE)
nano .env
# set / confirm these:
#   HOST="0.0.0.0"
#   LOG_LEVEL="warn"
#   ALLOW_LOCAL_ENCODE="false"
#   MEDIA_PUBLIC_BASE_URL="https://pub-….r2.dev"

# 4) Cap journald so this cannot fill the disk again
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=80M
RuntimeMaxUse=50M
EOF
sudo systemctl restart systemd-journald

# 5) Deploy latest server-cloud (no per-request logs), then restart
git pull
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
sudo systemctl restart shareflex
sudo systemctl status shareflex --no-pager
curl -sS http://127.0.0.1:8787/health
```

If `npm run build` errors about `cdnUploaded` / `cloudRegistered`, you skipped `npx prisma generate` — run that, then build again.

**Check it’s quiet:** `sudo journalctl -u shareflex -n 20 --no-pager` should show almost nothing during phone use (no `/health` spam).

---

## Architecture

1. **Mac** (`ALLOW_LOCAL_ENCODE=true` + `PUBLISH_TARGET_URL=http://GCE:8787`): encode HLS 1080/720/480 → upload to R2 → **register metadata on GCE**
2. **Cloudflare R2:** public media bytes (`MEDIA_PUBLIC_BASE_URL`)
3. **GCE VM** (`ALLOW_LOCAL_ENCODE=false`): Node API + SQLite **only** — no ffmpeg, no GB video uploads

Do **not** open GCE `/admin/` and upload episodes there. That fills the VM disk and fails without ffmpeg.

## Mac setup (encode + publish)

```bash
cd Code
cp server-cloud/.env.example server-cloud/.env
# Fill JWT/SEED; R2 + MEDIA_PUBLIC_BASE_URL; PUBLISH_TARGET_URL=http://34.14.223.130:8787
npm install
npm run server-cloud:generate
npm run server-cloud:db:migrate
npm run server-cloud:db:seed
npm run server-cloud:dev
```

Open **http://127.0.0.1:8787/admin/** on the Mac. Banner should say **Mac publisher → R2 → cloud**.

Pipeline per title (Jobs tab shows each stage):

| Stage | On failure |
|-------|------------|
| encoding | Nothing on R2/GCE; fix source / ffmpeg and re-upload |
| uploading_cdn | Encoded locally; use **Publish CDN+cloud** or **Retry CDN+register** |
| registering_cloud | Files on R2; use **Register cloud** / **Retry register** (no re-encode) |

Library actions: **Reupload CDN**, **Publish CDN+cloud**, **Register cloud**. Failed jobs keep the stage visible — nothing is silently “done”.

## GCE `.env` (required)

```bash
HOST="0.0.0.0"
PORT="8787"
LOG_LEVEL="warn"
ALLOW_LOCAL_ENCODE="false"
# leave PUBLISH_TARGET_URL empty
MEDIA_PUBLIC_BASE_URL="https://pub-….r2.dev"
# same JWT/SEED as you use for phones; R2 keys optional on GCE (delete uses them)
```

After changing `.env`: `sudo systemctl restart shareflex`

### Free disk after accidental uploads on the VM

**From admin (easiest):** GCE → Library → **Purge all local packages** (or SSH below).

```bash
# SSH into the VM, then:
cd ~/shareflex-server   # or your clone path
du -sh media* data 2>/dev/null; df -h .

# Wipe temp uploads + any local HLS folders (DB unchanged; R2 unchanged)
rm -rf media/temp/uploads media/movies media/episodes media/shows media/seasons
mkdir -p media/temp/uploads media/movies media/episodes media/shows media/seasons

# If MEDIA_ROOT points elsewhere, wipe that path instead — check .env
grep MEDIA_ROOT .env

df -h .
```

Or call the API as owner:

```bash
TOKEN=$(curl -sS -X POST http://127.0.0.1:8787/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@shareflex.local","password":"YOUR_PASSWORD"}' | jq -r .accessToken)

curl -sS -X POST http://127.0.0.1:8787/v1/admin/maintenance/cleanup-local-media \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"purgeTemp":true,"purgeNotReady":true,"purgeAllLocalPackages":true}'
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
nano .env   # HOST=0.0.0.0; LOG_LEVEL=warn; ALLOW_LOCAL_ENCODE=false; MEDIA_PUBLIC_BASE_URL=…
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
sudo journalctl -u shareflex -n 50 --no-pager
```

**Note:** If you **Suspend** the VM in Google Cloud, nothing runs until you **Start** it again. systemd starts ShareFlex automatically on boot after Start/reboot — not while suspended.

4. Firewall: allow **tcp:8787** (already done if you created `allow-shareflex-8787`).
5. Health: `curl http://34.14.223.130:8787/health`
6. iPhone **Account → Server:** `http://34.14.223.130:8787`

## Keep one sticky API address (important)

GCE **ephemeral** public IPs change when the VM is deleted/recreated or sometimes after stop/start. The app (and Mac `PUBLISH_TARGET_URL`) then point at a **dead IP** → splash hangs / videos crawl until you update the URL.

**Do this once on GCP so the IP never moves:**

1. VPC network → **IP addresses** → **Reserve external static address** (same region as the VM).
2. VM → **Edit** → Network interfaces → External IPv4 → choose that **static** address → Save.
3. Put that same IP in:
   - `mobile/src/lib/config.ts` (`PRODUCTION_API_BASE_URL`)
   - `mobile/.env` (`EXPO_PUBLIC_API_BASE_URL`)
   - Mac `PUBLISH_TARGET_URL`
   - each phone **Account → Server** (or clear override so the build default wins)

**Even better later:** point a DNS name (Cloud DNS / Cloudflare) at the static IP and use `http://api.yourdomain.com:8787` in the app — then you only change DNS if infra moves, not every phone.

The app now **fails boot after ~8s** if the API is unreachable and opens **Edit server** on login so you’re not stuck on splash again.

## Quality (mobile)

Player defaults to **Auto** (ABR from master.m3u8). User can lock **480p / 720p / 1080p** in the player UI.
