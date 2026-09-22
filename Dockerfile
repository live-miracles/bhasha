# Bhasha app image: builds apps/web's static SPA and packages it alongside
# apps/api, which serves both /api/* and the built SPA from one Node process
# (see apps/api/src/index.ts's static-serving middleware). Three stages:
#
#   deps        - full workspace install (incl. devDependencies), used only
#                 to build the web SPA.
#   web-build   - runs `npm run build --workspace apps/web` -> apps/web/dist.
#   runtime-deps - a SEPARATE, production-only install (apps/api's
#                 dependencies only -- no devDependencies, no apps/web
#                 frontend deps) so the final image doesn't carry build
#                 tooling it will never run.
#   runtime     - the actual image that ships: apps/api's source (run
#                 directly via tsx, matching `npm run start` in dev -- see
#                 the tsx-in-dependencies note below) + apps/web/dist +
#                 migrations, on the same base image as runtime-deps so
#                 better-sqlite3's native binding is ABI-compatible.
#
# Design choice (see repo-root docs / task report for the full rationale):
# apps/api's `start` script already runs the TypeScript source directly via
# `node --import tsx src/index.ts` in dev. Rather than adding a second
# (tsc-emit-JS) build pipeline just for Docker, this image runs the exact
# same command in production. `tsx` was promoted from apps/api's
# devDependencies to dependencies (see apps/api/package.json) specifically
# so it's available in a `--omit=dev` production install.

FROM node:22-bookworm-slim AS deps
# better-sqlite3 has no prebuilt binary for this image's exact Node/glibc
# combination, so npm falls back to compiling it from source via node-gyp,
# which needs Python + a C++ toolchain (neither is in the slim base image).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM deps AS web-build
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN npm run build --workspace apps/web

FROM node:22-bookworm-slim AS runtime-deps
# Same node-gyp/better-sqlite3 need as the `deps` stage above -- this is a
# separate, fresh `npm ci`, not a copy of `deps`'s node_modules, so the
# toolchain has to be installed again here too.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# --workspace apps/api installs only that workspace's own dependencies
# (plus anything it needs from the root); --include-workspace-root keeps
# root-level resolution consistent with the committed lockfile.
# --omit=dev drops devDependencies entirely (tsc/vitest/etc never ship).
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/package.json ./package.json
COPY --from=runtime-deps /app/package-lock.json ./package-lock.json
COPY tsconfig.base.json tsconfig.base.json
COPY apps/api/package.json apps/api/package.json
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
# apps/api/src/index.ts's DEFAULT_WEB_DIST_PATH resolves two directories up
# from itself plus "web/dist" -- i.e. apps/web/dist relative to this same
# /app root -- so mirroring the monorepo's own apps/api + apps/web layout
# here means the default needs no WEB_DIST_PATH override in this image.
COPY --from=web-build /repo/apps/web/dist apps/web/dist

WORKDIR /app/apps/api
ENV PORT=8787
EXPOSE 8787

# Equivalent of apps/api's "start" script (node --import tsx src/index.ts),
# run explicitly rather than via `npm run start` to avoid an extra npm
# process wrapping the server.
CMD ["node", "--import", "tsx", "src/index.ts"]
