# ==============================================================================
# Multi-stage Dockerfile for Smart QR Print Backend API & Worker
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build stage
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install native compilation dependencies for Alpine Linux
RUN apk add --no-cache openssl libc6-compat

# Copy dependency manifests first for maximum Docker layer caching
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Generate Prisma Client (supports native and linux-musl)
RUN npx prisma generate

# Copy source code and TypeScript configuration
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# Stage 2: Production runtime stage
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Install runtime libraries: openssl for Prisma, wget & curl for healthchecks
RUN apk add --no-cache openssl wget curl ca-certificates

# Set production environment defaults
ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0

# Copy node_modules, compiled dist, prisma schema, and package.json from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Create directories for local uploads / temporary assets and ensure permissions
RUN mkdir -p /app/storage /app/tmp \
    && chown -R node:node /app

# Switch to non-root user for principle of least privilege
USER node

# Expose default API service port
EXPOSE 5000

# Container health probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

# Default command: start API server
CMD ["node", "dist/server.js"]
