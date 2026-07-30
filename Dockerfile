FROM node:24-alpine

LABEL org.opencontainers.image.description="A configurable RSS poster for Bluesky"
LABEL org.opencontainers.image.source="https://github.com/rmdes/bsky.rss"

WORKDIR /build
COPY package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn workspaces focus --production \
 && rm -rf /root/.yarn

COPY . .
CMD ["node", "--import", "tsx", "app/index.ts"]
