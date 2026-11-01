# JARVIS Trener — obraz na malinkę (arm64). Build: docker compose build
# Etapy: deps (npm ci) -> builder (next build) -> cli (Prisma CLI do `db push`) -> runner (sam standalone)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# kompilator na wypadek, gdyby better-sqlite3 nie miał gotowej binarki dla arm64
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npx next build

FROM node:22-bookworm-slim AS cli
WORKDIR /cli
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm init -y >/dev/null && npm install --no-audit --no-fund prisma@6.19.3

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 TZ=Europe/Warsaw
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=cli /cli /cli
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
# pełny wygenerowany klient (standalone nie kopiuje pliku .wasm kompilatora zapytań)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
