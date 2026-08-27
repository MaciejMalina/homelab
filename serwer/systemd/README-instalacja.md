# Instalacja backupu malinki — krok po kroku

Kolejność ma znaczenie: najpierw malinka (agent + klucz), potem serwer (skrypt + timery).
Po każdym kroku jest podane, **jak sprawdzić, że działa**.

---

## Krok 1 — SERWER: klucz i katalogi

```bash
sudo mkdir -p /etc/jarvis /opt/jarvis/scripts /mnt/data/backups/malinka/{rootfs,images,meta}
sudo chmod 0750 /etc/jarvis

# klucz wyłącznie do backupu, bez hasła (ma działać z crona)
sudo ssh-keygen -t ed25519 -N '' -C 'jarvis-backup serwer->malinka' -f /root/.ssh/jarvis_backup

# hasło do repozytorium restic — ZAPISZ JE TEŻ POZA SERWEREM (menedżer haseł!)
# Bez niego backup jest bezużyteczny.
sudo sh -c 'openssl rand -base64 32 > /etc/jarvis/restic-pass'
sudo chmod 0600 /etc/jarvis/restic-pass
sudo cat /etc/jarvis/restic-pass    # <-- przepisz do menedżera haseł TERAZ

sudo apt install -y rsync restic zstd curl smartmontools

# klucz publiczny do wklejenia na malince:
sudo cat /root/.ssh/jarvis_backup.pub
```

**Weryfikacja:** `sudo restic version` zwraca wersję, `/root/.ssh/jarvis_backup.pub` istnieje.

---

## Krok 2 — MALINKA: agent i konto backupowe

```bash
sudo install -m 0755 jarvis-backup-agent.sh /usr/local/bin/jarvis-backup-agent.sh
sudo useradd -m -s /bin/bash bkp
sudo install -d -m 0700 -o bkp -g bkp /home/bkp/.ssh

# sudoers: konto 'bkp' może uruchomić WYŁĄCZNIE ten jeden skrypt
echo 'bkp ALL=(root) NOPASSWD: SETENV: /usr/local/bin/jarvis-backup-agent.sh' \
  | sudo tee /etc/sudoers.d/jarvis-backup
sudo chmod 0440 /etc/sudoers.d/jarvis-backup
sudo visudo -c            # MUSI wypisać "parsed OK"

# authorized_keys — jedna linia wg wzoru z authorized_keys.example
sudo -u bkp tee /home/bkp/.ssh/authorized_keys >/dev/null <<'EOF'
restrict,command="/usr/local/bin/jarvis-backup-agent.sh" ssh-ed25519 AAAA<TU_KLUCZ_Z_KROKU_1> jarvis-backup
EOF
sudo chmod 600 /home/bkp/.ssh/authorized_keys
```

**Weryfikacja (z serwera):**

```bash
ssh -i /root/.ssh/jarvis_backup bkp@malinka ping
# -> pong malinka 2026-08-25T03:00:01+02:00

ssh -i /root/.ssh/jarvis_backup bkp@malinka           # bez polecenia
# -> jarvis-backup-agent: odrzucono (brak polecenia...)   <-- tak ma być!

ssh -i /root/.ssh/jarvis_backup bkp@malinka 'rm -rf /'
# -> odrzucono (polecenie spoza białej listy)              <-- tak ma być!
```

Jeśli trzeci test **nie** zostanie odrzucony — zatrzymaj się i popraw `authorized_keys`.

---

## Krok 3 — SERWER: skrypty i konfiguracja

```bash
sudo install -m 0750 backup-malinka.sh       /opt/jarvis/scripts/backup-malinka.sh
sudo install -m 0750 jarvis-prune-backups.sh /opt/jarvis/scripts/jarvis-prune-backups.sh
sudo install -m 0640 backup-malinka.env      /etc/jarvis/backup-malinka.env
sudo nano /etc/jarvis/backup-malinka.env     # wpisz PI_HOST i DISCORD_WEBHOOK
```

**Weryfikacja — najpierw na sucho:**

```bash
sudo /opt/jarvis/scripts/backup-malinka.sh test
```

Powinieneś zobaczyć `pong`, listę pierwszych plików z dry-runu rsynca i metadane.
Dopiero potem pierwszy prawdziwy przebieg (pierwszy rsync trwa najdłużej):

```bash
sudo time /opt/jarvis/scripts/backup-malinka.sh daily
sudo restic -r /mnt/data/backups/restic snapshots --tag malinka
```

---

## Krok 4 — SERWER: timery

```bash
sudo cp systemd/jarvis-backup-malinka*.service systemd/jarvis-backup-malinka*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-backup-malinka.timer jarvis-backup-malinka-image.timer
systemctl list-timers 'jarvis-*'
```

---

## Krok 5 — MALINKA: pobudka serwera przed backupem

Serwer sam się nie obudzi. W cronie malinki (tam, gdzie już masz WoL):

```cron
# 03:00 — budzimy serwer; timery na serwerze zrobią resztę o 03:15 i (nd) 03:40
0 3 * * * /usr/bin/wakeonlan <MAC_SERWERA> >/dev/null 2>&1
```

`Persistent=true` w timerach oznacza, że jeśli serwer się nie obudzi na czas,
backup wystartuje natychmiast przy najbliższym starcie systemu.

---

## Krok 6 — test odtworzenia (bez tego backup jest tylko nadzieją)

```bash
# jeden plik z konkretnego snapshotu
sudo restic -r /mnt/data/backups/restic restore latest \
     --tag malinka --target /tmp/test-restore \
     --include /mnt/data/backups/malinka/rootfs/etc/hostname
cat /tmp/test-restore/mnt/data/backups/malinka/rootfs/etc/hostname

# integralność repozytorium
sudo /opt/jarvis/scripts/backup-malinka.sh verify
```

**Wpisz w kalendarz przypomnienie raz na kwartał: wgraj obraz `.img.zst` na
zapasową kartę/dysk i sprawdź, czy malinka z niego wstaje.** To jedyny sposób,
żeby wiedzieć, że backup działa.

Odtworzenie obrazu:

```bash
zstd -dc /mnt/data/backups/malinka/images/malinka-2026-08-30.img.zst \
  | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
```

---

## Krok 7 — czyszczenie retencji dla POZOSTAŁYCH backupów

`backup-malinka.sh` czyści tylko swoje kopie. Reszta (dumpy Postgresa, archiwa
Nextcloud itd.) idzie osobnym skryptem — najpierw na próbę:

```bash
sudo /opt/jarvis/scripts/jarvis-prune-backups.sh              # pokazuje, co skasuje
sudo nano /opt/jarvis/scripts/jarvis-prune-backups.sh         # dopisz swoje katalogi do CELE=()
sudo /opt/jarvis/scripts/jarvis-prune-backups.sh --wykonaj    # dopiero gdy lista wygląda dobrze
```

Potem do crona roota na serwerze:

```cron
30 4 * * * /opt/jarvis/scripts/jarvis-prune-backups.sh --wykonaj >> /var/log/jarvis-prune.log 2>&1
```
