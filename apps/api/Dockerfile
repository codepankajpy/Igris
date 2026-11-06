# Production Dockerfile for Igris Scanner API
# Compatible with Railway, Render, Fly.io, and Docker Compose

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

# Install Playwright browser binaries
RUN pnpm --filter @igris/scanner exec playwright install chromium chromium-headless-shell

# Copy source files
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY apps/web/public/ ./apps/web/public/
COPY examples/ ./examples/
COPY data/ ./data/

# Build packages
RUN pnpm --filter @igris/core build && \
    pnpm --filter @igris/patcher build && \
    pnpm --filter @igris/registry build && \
    pnpm --filter @igris/scanner build && \
    pnpm --filter @igris/api build

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]

