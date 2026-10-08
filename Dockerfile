FROM node:22-bookworm-slim

# Chrome renders the bot's videos with the same engine the site uses; ffmpeg makes the result play everywhere.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget gnupg ffmpeg fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get install -y --no-install-recommends chromium; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
