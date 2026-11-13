# Build from the repository root:  docker build -f server/Dockerfile -t luma .

# Stage 1: install dependencies. The database package compiles native code,
# so this stage uses the full image, which has a compiler and Python.
FROM node:22 AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: the image that runs. Same Node version, without the build tools.
FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/server.js ./server/
COPY server/src ./server/src
COPY server/public ./server/public
COPY world ./world
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
# No VOLUME line and no USER line on purpose: Railway rejects VOLUME in a Dockerfile,
# and it mounts its volumes as root, so a non-root process could not write the database.
CMD ["node", "server/server.js"]
