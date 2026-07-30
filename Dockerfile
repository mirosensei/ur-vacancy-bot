FROM alpine:latest

RUN apk add --no-cache nodejs

WORKDIR /app

COPY index.js ./
COPY lib/ ./lib/

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
    CMD kill -0 1

CMD ["node", "index.js"]
