#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Kör skriptet som din vanliga serveranvändare, inte med sudo." >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_user="$(id -un)"
service_group="$(id -gn)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"; unset client_id client_secret' EXIT
chmod 700 "$temporary_dir"

echo "Konfigurerar automatisk Lantmäteriet-anslutning för OMapMaker."
echo "Nycklarna ska komma från en separat applikation med åtkomst till STAC-hojd och STAC-vektor."
read -r -p "Consumer Key: " client_id
read -r -s -p "Consumer Secret (visas inte): " client_secret
echo
if [[ -z "$client_id" || -z "$client_secret" ]]; then
  echo "Både Consumer Key och Consumer Secret krävs." >&2
  exit 1
fi

printf '%s' "$client_id" >"$temporary_dir/client-id"
printf '%s' "$client_secret" >"$temporary_dir/client-secret"
chmod 600 "$temporary_dir/client-id" "$temporary_dir/client-secret"
unset client_id client_secret

echo "Skapar värddatorns krypteringsnyckel om den saknas…"
sudo systemd-creds setup
sudo systemd-creds encrypt --with-key=host --name=lantmateriet_oauth_client_id \
  "$temporary_dir/client-id" "$temporary_dir/client-id.cred"
sudo systemd-creds encrypt --with-key=host --name=lantmateriet_oauth_client_secret \
  "$temporary_dir/client-secret" "$temporary_dir/client-secret.cred"
sudo install -d -m 700 /etc/credstore.encrypted/omapmaker
sudo install -m 600 "$temporary_dir/client-id.cred" \
  /etc/credstore.encrypted/omapmaker/lantmateriet_oauth_client_id.cred
sudo install -m 600 "$temporary_dir/client-secret.cred" \
  /etc/credstore.encrypted/omapmaker/lantmateriet_oauth_client_secret.cred
sudo chown "$service_user:$service_group" "$temporary_dir/client-id.cred" "$temporary_dir/client-secret.cred"

unit_file="$temporary_dir/omapmaker.service"
{
  echo '[Unit]'
  echo 'Description=OMapMaker prototype server'
  echo 'Wants=network-online.target'
  echo 'After=network-online.target tailscaled.service'
  echo
  echo '[Service]'
  echo 'Type=simple'
  printf 'User=%s\n' "$service_user"
  printf 'Group=%s\n' "$service_group"
  printf 'WorkingDirectory=%s\n' "$project_dir"
  printf 'ExecStart=%s/start_omapmaker.sh\n' "$project_dir"
  echo 'Restart=always'
  echo 'RestartSec=3'
  echo 'Environment=PYTHONUNBUFFERED=1'
  echo 'Environment=PYTHONDONTWRITEBYTECODE=1'
  echo 'Environment=OMAP_SECURE_COOKIES=1'
  echo 'LoadCredentialEncrypted=lantmateriet_oauth_client_id:/etc/credstore.encrypted/omapmaker/lantmateriet_oauth_client_id.cred'
  echo 'LoadCredentialEncrypted=lantmateriet_oauth_client_secret:/etc/credstore.encrypted/omapmaker/lantmateriet_oauth_client_secret.cred'
  echo 'UMask=0077'
  echo 'NoNewPrivileges=true'
  echo 'PrivateTmp=true'
  echo 'ProtectSystem=strict'
  echo 'ProtectHome=read-only'
  printf 'ReadWritePaths=%s/data\n' "$project_dir"
  echo 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'
  echo
  echo '[Install]'
  echo 'WantedBy=multi-user.target'
} >"$unit_file"

sudo install -m 644 "$unit_file" /etc/systemd/system/omapmaker.service
sudo systemctl daemon-reload
sudo systemctl enable omapmaker.service

# The system service must own port 8765 so the old per-user unit is stopped.
systemctl --user disable --now omapmaker.service >/dev/null 2>&1 || true
if ! sudo systemctl restart omapmaker.service; then
  echo "Systemtjänsten kunde inte starta. Försöker återställa den tidigare användartjänsten." >&2
  systemctl --user enable --now omapmaker.service || true
  exit 1
fi

sleep 1
curl --fail --silent --show-error http://127.0.0.1:8765/api/height-status
echo
echo "Klart. OMapMaker kör nu med en krypterad, återkallningsbar OAuth2-nyckel."
