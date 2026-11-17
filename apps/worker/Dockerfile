# Analysis worker with Stockfish (GPL-3.0; source: https://github.com/official-stockfish/Stockfish).
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter @tempo/worker... --filter @tempo/database... --filter @tempo/shared... --filter @tempo/chess-core...
RUN pnpm --filter @tempo/database generate && pnpm --filter @tempo/worker build

FROM node:22-bookworm-slim
ENV NODE_ENV=production STOCKFISH_PATH=/usr/games/stockfish
RUN apt-get update && apt-get install -y --no-install-recommends stockfish && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
EXPOSE 4100
CMD ["node", "dist/index.js"]
