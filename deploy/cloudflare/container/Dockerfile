# All-in-one demo image for Cloudflare Containers. Built by deploy/cloudflare/build-image.sh, which
# assembles the build context (host-built app bundles + a Node 22 binary) so this Dockerfile only
# installs the system services.
#
# Stockfish is GPL-3.0 (https://github.com/official-stockfish/Stockfish); it is installed from the
# Ubuntu package and runs as a separate process.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-16 redis-server stockfish nginx \
 && rm -rf /var/lib/apt/lists/* /var/lib/postgresql/16/main /etc/nginx/sites-enabled/default

COPY node /usr/local/bin/node
WORKDIR /app
COPY node_modules ./node_modules
COPY realtime ./realtime
COPY worker ./worker
COPY web ./web
COPY migrations ./migrations
COPY supervisor.mjs nginx.conf.template ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/app/supervisor.mjs"]
