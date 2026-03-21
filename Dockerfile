FROM node:20-bookworm-slim AS build

ENV NODE_OPTIONS="--max-old-space-size=1024 --openssl-legacy-provider"

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
COPY scripts ./scripts

RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024 --openssl-legacy-provider" \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

CMD ["npm", "start"]
