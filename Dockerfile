FROM alpine:3.21

RUN apk add --no-cache nodejs

WORKDIR /app

COPY package.json ./
COPY index.js ./
COPY lib/ ./lib/

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "index.js"]
