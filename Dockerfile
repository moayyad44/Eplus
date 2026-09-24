# EmergencyPlus — single image: API + built web app served from the same origin.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/package.json web/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/server/src server/src
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
EXPOSE 4000
# Apply pending migrations, sync permissions/base configuration, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/bootstrap.ts && node dist/index.js"]
