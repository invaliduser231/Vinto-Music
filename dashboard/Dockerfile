FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_DASHBOARD_WS_URL=
ARG NEXT_PUBLIC_VISUALIZER_LEAD_MS=600
ARG NEXT_PUBLIC_USE_MOCK_SESSION=0
ARG NEXT_PUBLIC_FLUXER_CDN_BASE=

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_DASHBOARD_WS_URL=$NEXT_PUBLIC_DASHBOARD_WS_URL \
    NEXT_PUBLIC_VISUALIZER_LEAD_MS=$NEXT_PUBLIC_VISUALIZER_LEAD_MS \
    NEXT_PUBLIC_USE_MOCK_SESSION=$NEXT_PUBLIC_USE_MOCK_SESSION \
    NEXT_PUBLIC_FLUXER_CDN_BASE=$NEXT_PUBLIC_FLUXER_CDN_BASE

RUN pnpm run build && rm -rf .next/cache

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/next.config.ts /app/server.ts ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src/lib/shard-directory.ts ./src/lib/shard-directory.ts
COPY --from=build /app/src/server ./src/server

EXPOSE 3000

CMD ["node", "server.ts"]
