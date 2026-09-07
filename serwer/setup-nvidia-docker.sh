#!/bin/bash
# =============================================================================
#  SERWER — NVIDIA Container Toolkit (GPU w Dockerze, do NVENC dla Jellyfina)
# =============================================================================
#  Audyt 2026-09-06 oznaczyl to jako GPU-DOCKER: UNK (niepotwierdzone) - ten
#  skrypt sprawdza i, jesli trzeba, doinstalowuje. Zaklada ze sterownik NVIDIA
#  (nvidia-smi) JUZ dziala (uzywany przez Ollama/Whisper) - jesli nie, to
#  osobny, wiekszy temat (instalacja sterownika), nie robimy tego tutaj.
#
#  Uruchomienie: sudo bash setup-nvidia-docker.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Odpal jako root (sudo bash $0)" >&2
  exit 1
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "BLAD: brak nvidia-smi - sterownik NVIDIA nie jest zainstalowany." >&2
  echo "To trzeba zalatwic osobno, zanim ma sens instalowac container toolkit." >&2
  exit 1
fi

echo "== Sterownik NVIDIA (nvidia-smi) =="
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

if command -v nvidia-ctk >/dev/null 2>&1; then
  echo "== nvidia-ctk juz zainstalowany, pomijam instalacje pakietu =="
else
  echo "== Instaluje NVIDIA Container Toolkit =="
  DIST_ID=$(. /etc/os-release && echo "$ID")
  DIST_VER=$(. /etc/os-release && echo "$VERSION_ID")
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  apt-get install -y nvidia-container-toolkit
fi

echo "== Konfiguruje runtime nvidia dla Dockera (/etc/docker/daemon.json) =="
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "== Weryfikacja: docker run --gpus all =="
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi \
  && echo "OK - GPU widoczne w kontenerze" \
  || echo "UWAGA: test nie przeszedl - sprawdz output wyzej przed odpaleniem Jellyfina"
