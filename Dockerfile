FROM alpine:latest

RUN apk add --no-cache nodejs

WORKDIR /app

COPY index.js ./
COPY lib/ ./lib/

RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["node", "index.js"]
