# syntax=docker/dockerfile:1

# Scholars Profile System — production container image.
#
# Multi-stage build (deps -> build -> runtime). Pairs with `output: "standalone"`
# in next.config.ts: the runtime stage ships only Next's standalone server
# bundle and runs as the unprivileged `node` user. ADR-008, Phase 0.

# ---- Base -------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---- Dependencies -----------------------------------------------------------
# Installed against the lockfile in a cache-friendly layer. `npm ci` runs the
# repo `postinstall` (prisma generate), so the Prisma schema is copied first.
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- Build ------------------------------------------------------------------
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# lib/generated/ is excluded from the build context (.dockerignore); regenerate
# the Prisma client against the in-image schema, then build.
RUN npx prisma generate && npm run build

# ---- Runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
USER node
# Next standalone output: a self-contained server with a trimmed node_modules.
# `.next/static` is copied alongside it per the Next.js deployment docs. The
# app ships no `public/` directory — robots.txt, sitemap.xml, and llms.txt are
# route handlers and there are no other static assets — so nothing else is
# copied.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
