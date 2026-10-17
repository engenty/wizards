# engenty wizards — one image: API + built SPA + headless Chromium for PDF/PNG and the browser tool.
# The build context is the repo root: docker build -f apps/runtime/Dockerfile .
#
# Built on GitHub's runners and pulled by the server (.github/workflows/ci.yml, job `images`;
# compose.cloud.yaml). The stages are ordered so that a release reuses every layer whose
# inputs did not change: the system packages, both dependency installs, and in the final image
# the large node_modules layers, so the server downloads only what is new.
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# The manifests the installs need, and nothing else. `pnpm release` bumps the root package.json's
# version every release; a copy with the version blanked out keeps both installs below cached
# until a dependency really changes. The real file lands in the final image last.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runtime/package.json apps/runtime/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/wizards/package.json packages/wizards/
COPY packages/runner/package.json packages/runner/
RUN sed -i 's/"version": *"[^"]*"/"version": "0.0.0"/' package.json

# Everything the build needs.
FROM base AS deps
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile

# Only what the runtime needs to run: its dependencies and the shared package's. Its own stage,
# so it does not run again for every change of the source.
FROM base AS prod-deps
COPY --from=manifests /app ./
RUN pnpm install --prod --frozen-lockfile --filter "@engenty-wizards/runtime..."

FROM deps AS build
COPY . .
# The path the app is served under (https://example.com/wizards: /wizards); empty at an origin's root.
ARG APP_BASE_PATH=""
ENV APP_BASE_PATH=$APP_BASE_PATH
RUN pnpm build

# Sandbox engines that aren't part of the runtime (docs/plans/agentos-sandbox.md), only those
# named: `--build-arg SANDBOX_ENGINES=agentos` (about 340 MB). Its own stage, fed with just the
# installer, so a release that leaves the installer as it was reuses the layer instead of
# downloading the engines again.
FROM base AS engines
ARG SANDBOX_ENGINES=""
COPY --from=build /app/apps/runtime/dist/sandbox/install.js /app/apps/runtime/dist/sandbox/agentos-package.js ./apps/runtime/dist/sandbox/
COPY --from=build /app/apps/runtime/dist/cli/home.js ./apps/runtime/dist/cli/
RUN mkdir -p /opt/engines \
  && if [ -n "$SANDBOX_ENGINES" ]; then \
    echo '{ "type": "module" }' > package.json \
    && SANDBOX_ENGINES_DIR=/opt/engines node apps/runtime/dist/sandbox/install.js "$SANDBOX_ENGINES"; \
  fi

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ffmpeg fonts-liberation fonts-noto-color-emoji fonts-inter ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=8891 \
    DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    SANDBOX_ENABLED=0 \
    SANDBOX_ENGINES_DIR=/opt/engines
# Empty unless the image was built with SANDBOX_ENGINES; the sandbox stays off until SANDBOX_ENABLED=1.
COPY --from=engines /opt/engines /opt/engines
# The checkout's layout: the runtime finds the SPA (apps/web/dist) and the Claude Code plugin
# template (plugin/, filled with APP_URL at runtime) relative to its own files. The dependencies
# first: they change least.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/runtime/package.json ./apps/runtime/
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/wizards/package.json ./packages/wizards/
COPY --from=build /app/packages/wizards/dist ./packages/wizards/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/plugin ./plugin
# The plugins that ship with the runtime. Further ones go into a folder of PLUGINS_DIR.
COPY --from=build /app/modules ./modules
# With the release's version: it changes every release, so it comes last.
COPY --from=build /app/package.json ./
VOLUME /data
EXPOSE 8891
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8891/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/runtime/dist/index.js"]
