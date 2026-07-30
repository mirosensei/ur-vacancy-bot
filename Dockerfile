FROM alpine:latest

RUN apk add --no-cache nodejs

WORKDIR /app

COPY index.js ./
COPY lib/ ./lib/

CMD ["node", "index.js"]
