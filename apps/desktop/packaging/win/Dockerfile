FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates nsis imagemagick nodejs npm && rm -rf /var/lib/apt/lists/*
# resources.mjs writes the icon and version into Linger.exe.
RUN npm install -g resedit@3.1.0 && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules
