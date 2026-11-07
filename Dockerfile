FROM node:26-alpine

LABEL org.opencontainers.image.description="A configurable RSS poster for Bluesky"
LABEL org.opencontainers.image.source="https://github.com/rmdes/bsky.rss"

WORKDIR /build
COPY package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./
# node:26 images ship neither yarn nor corepack, so run the repo's pinned yarn release
# (yarnPath in .yarnrc.yml) directly.
RUN YARN_ENABLE_IMMUTABLE_INSTALLS=true \
    node "$(sed -n 's/^yarnPath: //p' .yarnrc.yml)" workspaces focus --production \
 && rm -rf /root/.yarn

COPY . .
CMD ["node", "--import", "tsx", "app/index.ts"]
