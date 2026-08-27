# Sekrety (sops + age)

Pliki `*.enc.yaml` w tym katalogu są szyfrowane przez [sops](https://github.com/getsops/sops)
kluczem [age](https://github.com/FiloSottile/age) — bezpieczne do trzymania w gicie.

## Edycja

```bash
sops secrets/jarvis-secrets.enc.yaml
```

Otworzy się w `$EDITOR` jako zwykły YAML — po zapisaniu i zamknięciu sops
zaszyfruje z powrotem automatycznie. Wymaga klucza prywatnego w
`~/.config/sops/age/keys.txt` (NIE w repo — backup trzymaj w menedżerze
haseł, bo bez niego nikt tego nie odszyfruje).

## Odczyt (bez edycji)

```bash
sops -d secrets/jarvis-secrets.enc.yaml
```

## Deploy na maszynę

sops/age NIE są (na razie) zainstalowane na malince/serwerze — wartości
z odszyfrowanego pliku wkleja się ręcznie do docelowych `.env`/configów
na maszynie (tak jak dotychczas). To jest źródło prawdy do backupu i
historii zmian, nie automatyczny pipeline deployu.

## Co tu jest

- `jarvis-secrets.enc.yaml` — DISCORD_WEBHOOK (backup-malinka), DISCORD_TOKEN
  (jarvis-bot), restic password. Oba webhook/token ROTOWANE 2026-08-27 (stare
  wartości wyszły w plaintext w terminalu podczas sesji) — patrz pamięć
  projektu, plik `jarvis-wdrozenie-sierpien-2026.md`.
