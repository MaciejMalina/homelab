FROM python:3.12-slim
# openssh-client: "Uśpij/restart serwera" = ssh jpower@serwer poweroff|reboot (forced command jarvis-power-agent.sh)
# tzdata: godziny wydarzeń z kalendarza w Europe/Warsaw (zoneinfo)
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py zrodla.py ./
COPY static/ static/
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8084
EXPOSE 8084
CMD ["python", "app.py"]
