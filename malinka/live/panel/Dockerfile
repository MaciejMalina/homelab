FROM python:3.12-slim
# openssh-client: "Uśpij serwer" = ssh jpower@serwer poweroff (forced command jarvis-power-agent.sh)
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py .
COPY static/ static/
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8084
EXPOSE 8084
CMD ["python", "app.py"]
