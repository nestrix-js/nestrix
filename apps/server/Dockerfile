# Standalone Nestrix server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t nestrix-server .
FROM node:26-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The server's own build plus the workspace packages it depends on (@nestrix/nestjs, @nestrix/ui).
RUN pnpm --filter "@nestrix/server..." build
# A production-only copy of the server and its dependencies (workspace packages are copied, not linked).
RUN pnpm --filter @nestrix/server --prod deploy --legacy /out

FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
# Located at ../../migrations relative to dist/storage.
COPY --from=build --chown=node:node /repo/apps/server/migrations ./migrations
USER node
EXPOSE 4318
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4318)+'/login').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
