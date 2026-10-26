# vue-tsc patches TypeScript and needs real Node; bun's node shim fails to resolve .vue modules.
FROM node:22-slim AS build
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server.ts localAgents.ts folderPicker.ts ./
COPY src ./src
# Pre-create so a fresh named volume inherits bun ownership (server chmods it to 0700).
RUN mkdir data && chown bun:bun data
USER bun
VOLUME /app/data
EXPOSE 29417
CMD ["bun", "server.ts"]
