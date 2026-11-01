#!/bin/sh
# Przy każdym starcie dopasowuje schemat bazy do prisma/schema.prisma (bez kasowania danych), potem startuje appkę.
set -e
mkdir -p /app/data
node /cli/node_modules/prisma/build/index.js db push --schema /app/prisma/schema.prisma --skip-generate
exec node /app/server.js
