FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_DASHBOARD_API_URL=http://127.0.0.1:9092
ARG NEXT_PUBLIC_DASHBOARD_WS_URL=ws://127.0.0.1:9092
ARG NEXT_PUBLIC_DASHBOARD_API_SECRET=
ARG NEXT_PUBLIC_USE_MOCK_SESSION=0
ARG NEXT_PUBLIC_FLUXER_CDN_BASE=

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_DASHBOARD_API_URL=$NEXT_PUBLIC_DASHBOARD_API_URL \
    NEXT_PUBLIC_DASHBOARD_WS_URL=$NEXT_PUBLIC_DASHBOARD_WS_URL \
    NEXT_PUBLIC_DASHBOARD_API_SECRET=$NEXT_PUBLIC_DASHBOARD_API_SECRET \
    NEXT_PUBLIC_USE_MOCK_SESSION=$NEXT_PUBLIC_USE_MOCK_SESSION \
    NEXT_PUBLIC_FLUXER_CDN_BASE=$NEXT_PUBLIC_FLUXER_CDN_BASE

RUN pnpm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
