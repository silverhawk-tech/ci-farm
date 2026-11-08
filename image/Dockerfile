# Slot image (spike, not final): Ubuntu + its own Docker daemon + the official GitHub Actions runner.
# Built and run by the ci-run user under rootless Docker. Root inside = host uid ci-run (user namespace).
# Pinned by digest (the index of ubuntu:24.04 on 2026-11-01); bump deliberately, never float.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG RUNNER_VERSION=2.338.2
# Ubuntu snapshot service id: every package comes from the archive state at that instant, so two builds of this file give the same packages.
ARG APT_SNAPSHOT=20261030T000000Z
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ENV DEBIAN_FRONTEND=noninteractive RUNNER_ALLOW_RUNASROOT=1 ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1
# Step 1 installs only ca-certificates (the snapshot service is https); the archive is GPG-signed, so this one step needs no pin.
# Step 2 switches apt to the snapshot (documented global option) and installs everything else from it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
    && apt-get update && apt-get install -y --no-install-recommends \
      curl git jq sudo unzip zip tar gzip xz-utils docker.io iptables uidmap libicu74 \
      python3 build-essential \
      xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-cyrillic xfonts-scalable fonts-liberation \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 \
      libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 \
    && rm -f /etc/apt/apt.conf.d/50snapshot && rm -rf /var/lib/apt/lists/*
# The snapshot setting is removed again once the build is done: a job's own `apt-get update` (Playwright's --with-deps runs one first, and a failed
# update aborts it even when every package is already present) then uses the normal archive, not the snapshot service that returned 503 on 2026-11-02.
# The image's contents stay pinned; only apt run later by a job is unpinned.
# The install above also bakes in the system packages Playwright's `install --with-deps chromium` asks for on Ubuntu 24.04 (list read from
# playwright-core 1.63.0), so a CI run does not need apt: with them present that step's apt install has nothing to fetch, even if the mirror is down.
RUN curl -fsSL -o /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && echo "${RUNNER_SHA256}  /tmp/runner.tgz" | sha256sum -c - \
    && mkdir /runner && tar -xzf /tmp/runner.tgz -C /runner && rm /tmp/runner.tgz
# The slot's own Docker needs a real filesystem for its layers: overlay on top of the slot's own overlay is refused by the kernel
# (spike 5). An anonymous volume lives on the host filesystem and is removed with the container (docker rm -v).
VOLUME /var/lib/docker
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
WORKDIR /runner
ENTRYPOINT ["/entrypoint.sh"]
