FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.js ./
COPY lib/ ./lib/
COPY docker-entrypoint.sh /app/

RUN chmod +x /app/docker-entrypoint.sh

# 不 COPY config.json 和 state.json — 通过 volume 挂载

RUN addgroup -S app && adduser -S app -G app
USER app

ENTRYPOINT ["/app/docker-entrypoint.sh"]
