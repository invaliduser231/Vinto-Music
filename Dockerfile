FROM node:26-bookworm-slim AS build

ENV NODE_OPTIONS="--max-old-space-size=1024 --openssl-legacy-provider"

WORKDIR /app

RUN npm install -g pnpm@12.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts

RUN pnpm run build

FROM node:26-bookworm-slim AS runtime

ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=1.3.1

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024 --openssl-legacy-provider" \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && mkdir -p /etc/yt-dlp/plugins \
  && curl -L "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_YTDLP_POT_PROVIDER_VERSION}/bgutil-ytdlp-pot-provider.zip" -o /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install -g pnpm@12.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY assets/fonts ./assets/fonts

CMD ["node", "dist/src/index.js"]
