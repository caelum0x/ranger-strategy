FROM public.ecr.aws/docker/library/node:22 AS builder
RUN npm install -g bun typescript ts-node husky

WORKDIR /app

# Copy package files first to leverage cache
COPY package.json yarn.lock ./
COPY drift-common/protocol/sdk/package.json ./drift-common/protocol/sdk/
COPY drift-common/common-ts/package.json ./drift-common/common-ts/

# Install build dependencies
RUN npm install -g bun

ENV NODE_ENV=production

WORKDIR /app/drift-common/protocol/sdk
COPY drift-common/protocol/sdk/ .
RUN bun install && bun run build

WORKDIR /app/drift-common/common-ts
COPY drift-common/common-ts/ .
RUN bun install && bun run build

WORKDIR /app
COPY . .
RUN bun install && bun run build

FROM public.ecr.aws/docker/library/node:22-alpine
COPY --from=builder /app/dist/ ./lib/

ENV NODE_ENV=production
EXPOSE 9464

CMD ["node", "./lib/index.js"]
