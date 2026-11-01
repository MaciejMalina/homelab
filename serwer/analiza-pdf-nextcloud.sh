#!/usr/bin/env bash
# TYLKO ODCZYT — rozpoznanie pod import PDF-ów z Nextclouda do Paperlessa.
# Uruchom na serwerze:  bash ~/analiza-pdf-nextcloud.sh > ~/analiza-pdf.txt 2>&1
set -u
ukryj() { sed -E 's/((PASS|PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=).*/\1<UKRYTE>/I'; }

echo "=== Nextcloud: montowania ==="
docker inspect nextcloud -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'

echo "=== Paperless: montowania i ustawienia pobierania/OCR ==="
docker inspect paperless -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
docker inspect paperless -f '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^PAPERLESS_(CONSUMER|OCR|TASK_WORKERS|THREADS|WORKER|TIME_ZONE|FILENAME|CONSUMPTION)' | ukryj

echo "=== PDF-y w Nextcloudzie: użytkownik / folder główny — liczba, rozmiar ==="
docker exec -u www-data nextcloud sh -c '
  cd /var/www/html/data 2>/dev/null || { echo "brak /var/www/html/data"; exit 0; }
  for u in */; do
    [ -d "$u/files" ] || continue
    find "$u/files" -type f -iname "*.pdf" -printf "%s\t%P\n" 2>/dev/null | awk -F"\t" -v u="${u%/}" "
      { split(\$2, a, \"/\"); f = (index(\$2, \"/\") ? a[1] : \"(główny)\"); n[f]++; s[f] += \$1; N++; S += \$1 }
      END { for (f in n) printf \"%-14s %-40s %6d plików %8.1f MB\n\", u, f, n[f], s[f]/1048576;
            printf \"%-14s %-40s %6d plików %8.1f MB\n\", u, \"=== RAZEM\", N, S/1048576 }"
  done' | sort

echo "=== 10 największych PDF-ów ==="
docker exec -u www-data nextcloud sh -c 'cd /var/www/html/data && find . -path "*/files/*" -type f -iname "*.pdf" -printf "%s\t%p\n" 2>/dev/null' \
  | sort -rn | head -10 | awk -F'\t' '{printf "%8.1f MB  %s\n", $1/1048576, $2}'

echo "=== Wolne miejsce ==="
df -h /mnt/data / | sed 1d
