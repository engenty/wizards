# The cloud's documents service (docs/plans/runs-on-their-own.md, package 7.2): PDFs, Word and
# Excel files and scans read in a container of its own, behind the small API of apps/documents.
# It keeps nothing: no volumes, no way to the databases, no secret but the one it shares with the
# runtime (DOCUMENTS_SECRET), which sends it documents (DOCUMENTS_URL there).
# The build context is the repo root: docker build -f apps/documents/Dockerfile .
FROM node:26-bookworm-slim AS deps
WORKDIR /app
# Node 25 and later ship without corepack; it comes from npm and reads `packageManager`.
RUN npm install -g corepack@0.36.0 && corepack enable
# The manifests the install needs; the root's version blanked out, so a release keeps this cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/documents/package.json apps/documents/
RUN sed -i 's/"version": *"[^"]*"/"version": "0.0.0"/' package.json
# Every library linked in /app/node_modules as well: the runtime's files below find them there.
RUN pnpm install --prod --frozen-lockfile --config.public-hoist-pattern="*" \
    --filter "@engenty/wizards-documents"

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    DOCUMENTS_PORT=8894 \
    TESSDATA_DIR=/opt/tessdata \
    HOME=/tmp
# Tesseract's models for German and English, the ones LiteParse downloads on a first scan: in the
# image, so a scan needs no way out.
ADD --chmod=644 https://github.com/tesseract-ocr/tessdata_best/raw/main/deu.traineddata \
    https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata /opt/tessdata/
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/documents/package.json ./apps/documents/
COPY apps/documents/src ./apps/documents/src
# The reading is the runtime's own (apps/runtime/src/documents/read.ts), as it is, with the files
# it imports: nothing of them reads the runtime's settings. tsx runs them; `type: module` is all
# of the runtime's package.json they need.
COPY apps/runtime/src/documents/read.ts apps/runtime/src/documents/ocr.ts ./apps/runtime/src/documents/
COPY apps/runtime/src/engenty/doc-converter ./apps/runtime/src/engenty/doc-converter
COPY apps/runtime/src/engenty/csv-import/xlsx-workbook.ts ./apps/runtime/src/engenty/csv-import/
COPY apps/runtime/src/render/markdown.ts ./apps/runtime/src/render/
COPY apps/runtime/src/on-demand.ts ./apps/runtime/src/
COPY apps/runtime/src/sandbox/install.ts apps/runtime/src/sandbox/agentos-package.ts ./apps/runtime/src/sandbox/
COPY apps/runtime/src/cli/home.ts ./apps/runtime/src/cli/
RUN echo '{ "type": "module" }' > apps/runtime/package.json
# The image's `node` user (1000), never root. The root file system may be read-only, with a tmpfs
# on /tmp.
USER node
WORKDIR /app/apps/documents
EXPOSE 8894
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8894/health',{signal:AbortSignal.timeout(4000)}).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/main.ts"]
