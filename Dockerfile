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

# ---- Prisma CLI closure -----------------------------------------------------
# The migrate task (sps-migrate-*) reuses the runtime image with entrypoint
# `npx prisma migrate deploy`, but Next standalone tracing drops the Prisma CLI
# and its full dependency closure -- the CLI is never imported by server code,
# and its config loader (@prisma/config) eagerly requires effect, c12,
# deepmerge-ts, empathic, etc. Resolve that closure cleanly in an isolated
# install (npm does the transitive resolution) rather than hand-copying deps
# out of the trimmed standalone node_modules. Versions track package.json so it
# never drifts from the app's Prisma.
FROM base AS prismacli
WORKDIR /pris
COPY package.json ./
RUN npm install --no-save --omit=dev --no-audit --no-fund \
      "prisma@$(node -p "require('./package.json').dependencies.prisma")" \
      "dotenv@$(node -p "require('./package.json').devDependencies.dotenv")"

# ---- Runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Prisma's schema/query engines probe for libssl to pick the matching engine
# build; bookworm-slim omits the openssl package, so Prisma misdetects and
# falls back to an openssl-1.1.x engine -- a risk for the TLS connection the
# migrate task makes to Aurora. Install openssl (Debian OpenSSL 3.0) + CA certs
# so the correct engine is selected. Run as root before dropping to `node`.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
USER node
# Next standalone output: a self-contained server with a trimmed node_modules.
# `.next/static` is copied alongside it per the Next.js deployment docs. The
# app ships no `public/` directory — robots.txt, sitemap.xml, and llms.txt are
# route handlers and there are no other static assets — so nothing else is
# copied.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# Prisma migrate assets for the shared `sps-migrate-*` task (entrypoint
# `npx prisma migrate deploy`). Next standalone tracing omits the schema, the
# migration SQL, the config file, and the CLI closure -- none are server-code
# imports -- so add them here. The CLI closure comes from the `prismacli` stage
# (full transitive resolution incl. the Linux schema-engine binary) overlaid
# onto the standalone node_modules; the app's own deps are untouched since
# `prisma` pulls neither @prisma/client nor the mariadb adapter. The schema
# declares no migrate-time driver adapter, so the native schema engine connects
# directly from DATABASE_URL -- no JS driver needed.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=prismacli --chown=node:node /pris/node_modules ./node_modules
# .bin/prisma must be a real symlink: Docker COPY dereferences it into a plain
# file under .bin/, breaking the CLI's __dirname-relative load of
# prisma_schema_build_bg.wasm. Recreate it pointing into prisma/build/.
RUN ln -sf ../prisma/build/index.js node_modules/.bin/prisma

EXPOSE 3000
CMD ["node", "server.js"]
