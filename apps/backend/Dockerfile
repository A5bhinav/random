# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/

# Install all dependencies (including devDeps needed for TypeScript compile)
RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY tsconfig.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/backend/ ./apps/backend/

# Compile TypeScript (builds shared first, then backend, via project references)
RUN npm run build -w @coach/backend

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy workspace manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

EXPOSE 3000

CMD ["node", "apps/backend/dist/index.js"]
