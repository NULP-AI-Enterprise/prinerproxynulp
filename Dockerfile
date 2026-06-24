# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cache friendly)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production image ───────────────────────────────────────────────
FROM node:20-alpine AS runner

# Minimal attack surface: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Only install production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled JS and static views
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/views ./dist/views

# Drop to non-root
USER appuser

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/login || exit 1

CMD ["node", "dist/server.js"]
