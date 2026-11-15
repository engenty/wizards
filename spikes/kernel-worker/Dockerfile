# One wizard as a Worker on workerd, for a server of one's own (Coolify on the VPS). Built from
# the repository's root, since the deploy package pins the kernel, the edge batteries and the
# runner by `link:` into packages/ (a released CLI would write versions instead).
#   docker build -f spikes/kernel-worker/Dockerfile --build-arg WIZARD=wizards/x-post -t wizard .
#   docker run -p 8080:8080 -v runs:/app/.workerd/runs wizard
FROM node:24-bookworm-slim AS build
ARG WIZARD=wizards/x-post
RUN npm install -g pnpm@10.23.0
WORKDIR /repo
COPY . .
# The runner and what it builds on (the shared definitions), for the run page and its CSS.
RUN pnpm install --frozen-lockfile --filter "@engenty/wizards-runner..." \
  && cd packages/runner && node scripts/css.mjs
WORKDIR /repo/spikes/kernel-worker
# `wizards deploy`: the deploy package, then its own install and build.
RUN pnpm install --ignore-workspace --frozen-lockfile \
  && node deploy.mjs "$WIZARD" --out deploy/wizard \
  && cd deploy/wizard && pnpm install --ignore-workspace && pnpm build \
  && cp node_modules/.pnpm/@cloudflare+workerd-linux-*/node_modules/@cloudflare/workerd-linux-*/bin/workerd /repo/workerd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/workerd /usr/local/bin/workerd
WORKDIR /app
COPY --from=build /repo/spikes/kernel-worker/deploy/wizard/dist ./dist
COPY --from=build /repo/spikes/kernel-worker/deploy/wizard/workerd.capnp ./
# Each run is one SQLite file here: a volume keeps them across deploys.
RUN mkdir -p .workerd/runs
VOLUME /app/.workerd/runs
EXPOSE 8080
# Secrets from the environment: MODEL_API_KEY (and MODEL_BASE_URL), or HOME_URL + DEPLOY_KEY.
CMD ["workerd", "serve", "workerd.capnp", "--experimental", "--socket-addr", "http=0.0.0.0:8080"]
