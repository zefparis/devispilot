# Build context : racine du dépôt (server/ + public/).
# docker build -f server/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3400 \
    STATIC_ROOT=/srv/static \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/migrations ./migrations
COPY public /srv/static
USER node
EXPOSE 3400
CMD ["node", "dist/server.js"]
