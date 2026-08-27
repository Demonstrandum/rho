# a clean machine with pi and this checkout, for ci/smoke.ts.
#
#   docker build -f ci/Dockerfile -t rho-smoke .
#   docker run --rm rho-smoke
#
# build args:
#   PI_VERSION   npm version or tag of the pi cli (default: latest)
#
# the image installs pi globally and rho as a user-scoped pi package, so the
# build itself covers the install path. the smoke test then runs against a
# temporary agent directory of its own.
FROM node:24-bookworm-slim

ARG PI_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

# ripgrep and procps are what the agent's own tools expect; util-linux carries
# script(1), which the smoke test uses to get a pseudo-terminal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl unzip git jq ripgrep procps util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

WORKDIR /rho
COPY . /rho

# the postinstall script links the bundled pi packages, so it needs the tree.
RUN bun install

RUN pi install /rho && pi list

ENTRYPOINT ["bun", "/rho/ci/smoke.ts"]
