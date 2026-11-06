# IGRIS optional hosted scanner node.
#
# Status: LOCAL / DOCKER USE ONLY until every P0 acceptance criterion in
# docs/ROADMAP.md passes. Do not expose publicly before then.
#
# Security posture: runs as an unprivileged user; scans are always
# egress-filtered (public addresses, ports 80/443 only) by the scanner's
# in-process proxy; no scanner key is held (results are unpublished).

FROM node:22-bookworm-slim AS base

# Install git, python/build tools, and Playwright system dependencies
RUN apt-get update && apt-get install -y \
    git \
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
COPY packages/patcher/package.json ./packages/patcher/
COPY packages/registry/package.json ./packages/registry/
COPY packages/cli/package.json ./packages/cli/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY fixtures/leaky-dapp/package.json ./fixtures/leaky-dapp/
COPY fixtures/leaky-dapp-fixed/package.json ./fixtures/leaky-dapp-fixed/
COPY fixtures/third-party-sink/package.json ./fixtures/third-party-sink/

# Install node dependencies
RUN pnpm install --frozen-lockfile

# Install Playwright browser binaries into a shared, read-only location.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @igris/scanner exec playwright install chromium chromium-headless-shell \
    && chmod -R a+rX /ms-playwright

# Copy source files
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY data/ ./data/

# Build packages
RUN pnpm --filter @igris/core build && \
    pnpm --filter @igris/patcher build && \
    pnpm --filter @igris/registry build && \
    pnpm --filter @igris/scanner build && \
    pnpm --filter @igris/api build

ENV PORT=3001
ENV NODE_ENV=production

# Unprivileged runtime user. NOTE: Playwright launches Chromium without its
# own sandbox by default (chromiumSandbox: false); see docs/ENGINEERING_LOG.md
# for the resulting trust boundary and the hardening still to do.
RUN useradd --create-home --uid 10001 igris
USER igris

EXPOSE 3001

# Workspace packages resolve to their compiled dist/ under this condition.
CMD ["node", "--conditions=igris-dist", "apps/api/dist/index.js"]

