# syntax=docker/dockerfile:1
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:25-alpine
ARG APP_VERSION=""
LABEL org.opencontainers.image.title="Fenzy Mock Gateway" \
      org.opencontainers.image.description="Mock SMS, Email and Payment gateway for testing"
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=4000 \
    SMTP_PORT=2525 \
    DATA_DIR=/data
WORKDIR /app
# The app never runs npm/yarn at runtime; removing them drops their bundled dependencies (and CVEs) from the image.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
VOLUME ["/data"]
EXPOSE 4000 2525
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
