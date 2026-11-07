# IGRIS in one container: the backend (apps/api) and the website (apps/app,
# served by the API from the same origin). Build from the repository root:
#
#   docker build -f apps/api/Dockerfile -t igris .
#   docker run -p 3001:3001 -v igris-data:/data igris
#
# Security posture: runs as an unprivileged user; scans are always
# egress-filtered (public addresses, ports 80/443 only) by the scanner's
# in-process proxy. No key is ever baked into the image.
#
# Persistent state lives under /data (mount a volume / disk there):
#   /data/igris-home  IGRIS_HOME: node identity + scanner key (mode 0600)
#   /data/igris-data  IGRIS_DATA_DIR: scan jobs, cached reports, local registry
#
# Without a scanner key the registry is local (/data/igris-data/registry.json).
# To publish to Arkiv, create the key once INSIDE the running container:
#   node --conditions=igris-dist packages/registry/dist/bin/init-scanner.js <name>
# fund the printed address, set ARKIV_ACCESS_KEY (and IGRIS_TRUSTED_SCANNERS)
# as runtime environment variables, and restart.

FROM node:22-bookworm-slim

# Playwright system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    ca-certificates \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy root monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/registry/package.json ./packages/registry/
COPY apps/api/package.json ./apps/api/
COPY apps/app/package.json ./apps/app/

# Install node dependencies (backend + website build toolchain)
RUN pnpm install --frozen-lockfile --filter @igris/api... --filter @igris/app...

# Install Playwright browser binaries into a shared, read-only location.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @igris/scanner exec playwright install chromium chromium-headless-shell \
    && chmod -R a+rX /ms-playwright

# Copy source files
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY apps/app/ ./apps/app/
COPY data/ ./data/
# The website build publishes this test page at /demo/wallet-requests/.
COPY fixtures/wallet-requests/ ./fixtures/wallet-requests/

# Build packages, the backend and the website (apps/app/dist)
RUN pnpm --filter @igris/core build && \
    pnpm --filter @igris/registry build && \
    pnpm --filter @igris/scanner build && \
    pnpm --filter @igris/api build && \
    pnpm --filter @igris/app build && \
    test -f apps/app/dist/index.html && \
    test -f packages/registry/dist/bin/init-scanner.js

# Unprivileged runtime user (Node runs as it; see the entrypoint).
# Chromium's own OS sandbox is opt-in: IGRIS_CHROMIUM_SANDBOX=1 on hosts
# that allow it (docker run --cap-add=SYS_ADMIN).
RUN useradd --create-home --uid 10001 igris \
    && mkdir -p /data/igris-data /data/igris-home \
    && chown -R igris:igris /data \
    && chmod 0700 /data/igris-data /data/igris-home

ENV PORT=3001 \
    NODE_ENV=production \
    IGRIS_DATA_DIR=/data/igris-data \
    IGRIS_HOME=/data/igris-home \
    IGRIS_STATIC_DIR=/app/apps/app/dist

# Starts as root only to chown the data directories (platform volumes are
# root-owned), then drops to `igris` (docker-entrypoint.sh).
COPY --chmod=755 apps/api/docker-entrypoint.sh /usr/local/bin/igris-entrypoint
ENTRYPOINT ["/usr/local/bin/igris-entrypoint"]

# /data is the mount point for a persistent volume/disk (no VOLUME line:
# Railway rejects it; mount with -v / the platform's disk settings).
EXPOSE 3001

# Workspace packages resolve to their compiled dist/ under this condition.
CMD ["node", "--conditions=igris-dist", "apps/api/dist/index.js"]
