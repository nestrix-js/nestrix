# The two example services (examples/jaeger: service-a calls service-b), built from the repository
# root so the workspace @nestrix-js/nestjs is used:
#   docker build -f examples/standalone/Dockerfile -t nestrix-example-services .
FROM node:26-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "jaeger-example..." build
RUN pnpm --filter jaeger-example --prod deploy --legacy /out

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/examples/jaeger/dist ./dist
USER node
# The compose file picks dist/service-a.js or dist/service-b.js.
CMD ["node", "dist/service-a.js"]
