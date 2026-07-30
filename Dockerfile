FROM alpine:latest

RUN apk add --no-cache nodejs su-exec

WORKDIR /app

COPY index.js ./
COPY lib/ ./lib/
COPY entrypoint.sh /

RUN addgroup -S app && adduser -S app -G app && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
