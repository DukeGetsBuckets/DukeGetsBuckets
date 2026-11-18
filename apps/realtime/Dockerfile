# Realtime service (Socket.IO). Build context = repository root.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages ./packages
COPY apps/realtime ./apps/realtime
RUN pnpm install --frozen-lockfile --filter @tempo/realtime... --filter @tempo/database... --filter @tempo/shared... --filter @tempo/chess-core...
RUN pnpm --filter @tempo/database generate && pnpm --filter @tempo/realtime build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/realtime/package.json ./apps/realtime/package.json
COPY --from=build /app/apps/realtime/node_modules ./apps/realtime/node_modules
COPY --from=build /app/apps/realtime/dist ./apps/realtime/dist
COPY --from=build /app/apps/realtime/start.sh ./apps/realtime/start.sh
WORKDIR /app/apps/realtime
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.REALTIME_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Runs `prisma migrate deploy` before starting, so a fresh database is initialised automatically.
CMD ["sh", "start.sh"]
