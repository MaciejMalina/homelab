#!/bin/bash
# ~/scripts/nightly-backup.sh  (uruchamiane na MALINCE z crona o 7:00)
# Budzi serwer (WoL) i odpala backup PO STRONIE SERWERA (zrzut na RAID /mnt/data).
# Kopie trzymane sa wylacznie na serwerze.
#
# ZMIANA (2026-08-27): logowanie jako root@serwer kluczem bota Discorda
# przestalo dzialac po SSH hardeningu (PermitRootLogin no). Teraz laczymy sie
# jako bkptrigger@serwer dedykowanym kluczem, ktory przez forced command
# potrafi wylacznie odpowiedziec "pong" albo uruchomic backup.sh - patrz
# serwer/jarvis-server-backup-agent.sh w paczce.

SERVER_IP=192.168.1.162
SERVER_MAC=4c:cc:6a:4a:33:6d
SSH_KEY=/home/macmal/.ssh/jarvis-server-backup-trigger    # dedykowany klucz, TYLKO do tego
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i $SSH_KEY"
REMOTE=bkptrigger@$SERVER_IP

log(){ echo "[$(date '+%F %T')] $*"; }

# 1) Obudz serwer jesli spi
if ! ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1; then
  log "Serwer spi - wysylam WoL"
  wakeonlan "$SERVER_MAC" >/dev/null 2>&1 || etherwake "$SERVER_MAC" 2>/dev/null
  for i in $(seq 1 36); do          # czekaj do ~3 min na ping
    ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1 && break
    sleep 5
  done
fi

# 2) Czekaj na SSH (agent odpowiada "pong ...")
for i in $(seq 1 24); do
  ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong' && break
  sleep 5
done
ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong' || { log "BLAD: brak SSH do serwera"; exit 1; }

# 3) Uruchom backup na serwerze (zrzut na RAID)
log "Uruchamiam backup na serwerze"
ssh $SSH_OPTS "$REMOTE" run

# 4) Po backupie: odpal przypomnienia CRM (serwer juz czuwa)
log "Wywoluje przypomnienia (n8n webhook /reminders)"
curl -s -m 60 -X POST "http://$SERVER_IP:5678/webhook/reminders" >/dev/null 2>&1 || true

log "Gotowe. Serwer zostanie uspiony przez idle-shutdown gdy bezczynny."
