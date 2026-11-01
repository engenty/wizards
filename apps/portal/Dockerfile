# The client portal (docs/plans/client-portal.md): its SPA and the thin server that signs a
# firm's clients in and forwards to the runtime's client contract. Its own image, apart from the
# runtime's: it reaches the runtime only over HTTP. The build context is the repo root:
#   docker build -f apps/portal/Dockerfile .
# Dockerfile.dockerignore beside this file is this image's ignore file.
#
# Built on GitHub's runners and pulled by the server (.github/workflows/ci.yml, job `images`;
# compose.cloud.yaml, service `portal`).
FROM node:26-bookworm-slim AS base
WORKDIR /app
# Node 25 and later ship without corepack; it comes from npm and reads `packageManager`.
RUN npm install -g corepack@0.36.0 && corepack enable

# `pnpm release` bumps the root package.json's version every release; a copy with the version
# blanked out keeps the install below cached until a dependency really changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/portal/package.json apps/portal/
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/
RUN sed -i 's/"version": *"[^"]*"/"version": "0.0.0"/' package.json

FROM base AS build
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile --filter "@engenty/wizards-portal..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/runner packages/runner
COPY apps/portal apps/portal
RUN pnpm --filter "@engenty/wizards-runner" build && pnpm --filter "@engenty/wizards-portal" build

# The server needs hono and nothing else of the workspace: the SPA is built into dist/web.
FROM base AS prod-deps
COPY --from=manifests /app ./
RUN pnpm install --prod --frozen-lockfile --filter "@engenty/wizards-portal" --config.node-linker=hoisted

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORTAL_PORT=8893
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/portal/dist ./dist
COPY apps/portal/package.json ./
EXPOSE 8893
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8893/health',{signal:AbortSignal.timeout(4000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
