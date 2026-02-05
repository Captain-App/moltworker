FROM docker.io/cloudflare/sandbox:0.7.0

# Install Node.js 22 (required by openclaw) and rsync (for R2 backup sync)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
ENV NODE_VERSION=22.13.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates rsync \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install git and build tools
RUN apt-get update && apt-get install -y git python3 make g++

# Clone and build openclaw from Captain-App fork (includes CaptainApp provider)
RUN git clone https://github.com/Captain-App/openclaw.git /tmp/openclaw-build \
    && cd /tmp/openclaw-build \
    && npm install --legacy-peer-deps --force || npm install --ignore-scripts \
    && npm run build \
    && npm pack \
    && npm install -g captain-app-openclaw-*.tgz \
    && openclaw --version \
    && rm -rf /tmp/openclaw-build

# Create openclaw directories
# Templates are stored in /root/.openclaw-templates for initialization
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/.openclaw-templates \
    && mkdir -p /root/openclaw \
    && mkdir -p /root/openclaw/skills

# Copy startup script
# Build cache bust: 2026-02-04-v12-captainapp-provider
ARG BUILD_VERSION=v17
COPY start-moltbot.sh /usr/local/bin/start-moltbot.sh
RUN chmod +x /usr/local/bin/start-moltbot.sh

# Copy default configuration template
# Cache bust: 2026-02-05-v14 - Force template update with Telegram config
COPY moltbot.json.template /root/.openclaw-templates/moltbot.json.template
RUN cat /root/.openclaw-templates/moltbot.json.template | head -5

# Copy custom skills
COPY skills/ /root/openclaw/skills/

# Set working directory
WORKDIR /root/openclaw

# Expose the gateway port
EXPOSE 18789
# Build cache bust: Wed Feb  5 08:50:00 GMT 2026
