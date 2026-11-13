# Build from the repository root:  docker build -f server/Dockerfile -t luma .
FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/server.js ./server/
COPY server/src ./server/src
COPY server/public ./server/public
COPY world ./world
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/server.js"]
