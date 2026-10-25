# Node 26 runs the TS sources with no build and no flags. Never add
FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app

# NEVER --omit=optional: resvg's native renderer is optional, and every render would fail.
# --ignore-scripts: prebuilt binaries are bundled, and npm would run node-gyp with no compiler.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY fonts ./fonts
COPY locales ./locales
COPY database ./database
COPY static ./static
COPY templates ./templates
COPY ace ./ace

# SQLite writes -wal and -shm next to the db, so /data must be a directory owned by node.
# No VOLUME: a `docker run` without -v would silently orphan the data in an anonymous volume.
RUN mkdir -p /data/img && chown -R node:node /data
USER node

ENV PORT=8000 DATA_DIR=/data
EXPOSE 8000

# 127.0.0.1, since localhost may resolve to ::1. NEVER fail on queue backlog: Coolify gates
# deploys on health, and a restart loses in-flight work.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM.
CMD ["node", "src/main.ts"]
