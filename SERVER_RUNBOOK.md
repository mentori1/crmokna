# Production server runbook

CRM is fully hosted on the VPS and does not use Supabase or GitHub at runtime.

## Current endpoint

- URL: `http://212.8.226.97`
- SSH: `root@212.8.226.97`
- SSH key: `~/.ssh/beget_ovsyannikov_crm`
- Login email: `admin@crm.local`

## Server paths

- Frontend and API code: `/opt/ovsyannikov-crm`
- SQLite database: `/var/lib/ovsyannikov-crm/crm.db`
- Backups: `/var/backups/ovsyannikov-crm/crm-*.sqlite.gz`
- API service: `ovsyannikov-crm.service`
- Private service settings: `/etc/ovsyannikov-crm.env` (mode `600`)
- Nginx config: `/etc/nginx/sites-available/ovsyannikov-crm`
- Daily backup cron: `/etc/cron.d/ovsyannikov-crm-backup` (03:17 server time)

## Health checks

```bash
curl http://127.0.0.1:8765/api/health
systemctl status ovsyannikov-crm nginx
sqlite3 /var/lib/ovsyannikov-crm/crm.db 'pragma integrity_check;'
```

Address suggestions use the authenticated `/api/address-suggest` endpoint. The
DaData token is stored only on the VPS:

```bash
sudo install -m 600 /dev/null /etc/ovsyannikov-crm.env
sudoedit /etc/ovsyannikov-crm.env
# DADATA_TOKEN=replace-with-current-token
sudo systemctl restart ovsyannikov-crm
```

## Manual backup and restore verification

```bash
/opt/ovsyannikov-crm/deploy/backup.sh
LATEST=$(ls -1t /var/backups/ovsyannikov-crm/crm-*.sqlite.gz | head -1)
gzip -t "$LATEST"
zcat "$LATEST" >/tmp/crm-restore-test.sqlite
sqlite3 /tmp/crm-restore-test.sqlite 'pragma integrity_check;'
rm /tmp/crm-restore-test.sqlite
```

## Deploy an update from the local workspace

```bash
rsync -az --delete \
  --exclude .git --exclude integration --exclude data --exclude import --exclude '*.command' \
  -e 'ssh -i ~/.ssh/beget_ovsyannikov_crm' \
  ./ root@212.8.226.97:/opt/ovsyannikov-crm/
ssh -i ~/.ssh/beget_ovsyannikov_crm root@212.8.226.97 \
  'python3 /opt/ovsyannikov-crm/deploy/migrate_app_settings.py && \
   python3 /opt/ovsyannikov-crm/deploy/migrate_salary_payments.py && \
   python3 /opt/ovsyannikov-crm/deploy/migrate_order_managers.py && \
   systemctl restart ovsyannikov-crm && nginx -t && systemctl reload nginx'
```

## Domain and HTTPS

1. Create an `A` record for the domain pointing to `212.8.226.97`.
2. Put the domain in `server_name` in the Nginx config.
3. Install Certbot and issue a Let's Encrypt certificate.
4. Set `Environment=CRM_SECURE_COOKIE=1` in the systemd service and restart it.
5. Allow `Nginx Full` in UFW and remove the HTTP-only rule after HTTPS is verified.
