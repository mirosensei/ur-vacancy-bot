FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.js ./
COPY lib/ ./lib/

# 不 COPY config.json 和 state.json — 通过 volume 挂载

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "index.js"]
