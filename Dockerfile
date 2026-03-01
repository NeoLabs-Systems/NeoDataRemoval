# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Non-root user
RUN addgroup -g 1001 -S ndr && adduser -S -u 1001 -G ndr ndr
RUN mkdir -p /app/db_data && chown -R ndr:ndr /app

USER ndr

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/auth/me || exit 1

CMD ["node", "server.js"]
