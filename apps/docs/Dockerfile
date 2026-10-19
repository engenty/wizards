# The documentation site: the pages of docs/content, shown by apps/docs. One Next.js server,
# everything below /docs. The build context is the repo root:
#   docker build -f apps/docs/Dockerfile .
# Dockerfile.dockerignore beside this file is this image's ignore file; the root .dockerignore is
# the runtime image's and leaves the site out.
#
# Built on GitHub's runners and pulled by the server (.github/workflows/ci.yml, job `images`;
# deploy/Dockerfile.docs).
FROM node:26-bookworm-slim AS base
WORKDIR /app
# Node 25 and later ship without corepack; it comes from npm and reads `packageManager`.
RUN npm install -g corepack@0.36.0 && corepack enable

# `pnpm release` bumps the root package.json's version every release; a copy with the version
# blanked out keeps the install below cached until a dependency really changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json apps/docs/
RUN sed -i 's/"version": *"[^"]*"/"version": "0.0.0"/' package.json

FROM base AS build
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile --filter "@engenty/wizards-docs..."
COPY tsconfig.base.json ./
COPY apps/docs apps/docs
COPY docs/content docs/content
COPY docs/assets docs/assets
# The address the site is published at: canonical links and link previews use it.
ARG NEXT_PUBLIC_DOCS_SITE_URL=""
ENV NEXT_PUBLIC_DOCS_SITE_URL=$NEXT_PUBLIC_DOCS_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@engenty/wizards-docs" build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8896 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# The standalone output keeps the repo's layout: the server is apps/docs/server.js, and it looks
# for the built files and the public folder beside itself.
COPY --from=build /app/apps/docs/.next/standalone ./
COPY --from=build /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=build /app/apps/docs/public ./apps/docs/public
EXPOSE 8896
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8896/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/docs/server.js"]
