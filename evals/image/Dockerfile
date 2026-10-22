# Anchor eval image — a broad Linux toolchain for public agent benchmarks
# (SWE-bench, Terminal-Bench subsets) running on Heyo.
#
# Build on the Heyo host from this repo (imageKind: "git"), or locally with
# Sailor's recipe (docker build -> export -> mke2fs -> heyctl artifact push).
# The guest plumbing below mirrors Sailor's toolchain image: /init.sh is PID 1,
# sshd is the exec channel, and /workspace is the data disk.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client openssh-server socat \
      e2fsprogs iproute2 procps util-linux hostname \
      build-essential pkg-config cmake \
      python3 python3-pip python3-venv python3-dev \
      jq unzip zip less openssl tar ripgrep fd-find \
      r-base redis-server sqlite3 libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# The system Python is the eval default. PEP 668 would block `pip install -r`.
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 -m pip install --no-cache-dir pytest

# Older SWE-bench repositories pin Python 3.8/3.9-era dependencies. Python 3.11
# covers most of them without breaking the 3.12 default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common gnupg \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         python3.11 python3.11-venv python3.11-dev \
    && rm -f /usr/lib/python3.11/EXTERNALLY-MANAGED \
    && python3.11 -m pip install --no-cache-dir pytest \
    && rm -rf /var/lib/apt/lists/*

# Node 22 — NodeBB and many Terminal-Bench tasks.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && git config --system init.defaultBranch main

# Guest plumbing: ssh host keys, dirs sshd/exec need, hostname for /init.sh,
# and PID 1.
RUN ssh-keygen -A \
    && mkdir -p /root/.ssh /run/sshd \
    && echo "anchor-eval" > /etc/heyo-hostname
COPY init.sh /init.sh
RUN chmod 0755 /init.sh
