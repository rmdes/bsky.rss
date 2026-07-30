FROM node:lts-alpine AS deps

WORKDIR /build
COPY package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./

RUN yarn install --immutable

FROM node:lts-alpine

LABEL org.opencontainers.image.description "A configurable RSS poster for Bluesky"
LABEL org.opencontainers.image.source "https://github.com/rmdes/bsky.rss"

WORKDIR /build
COPY package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./
COPY --from=deps /build/node_modules ./node_modules
RUN yarn workspaces focus --production

COPY . .
CMD yarn start
