# mwaskom__seaborn-2848 — official SWE-bench image + Heyo guest plumbing.
FROM swebench/sweb.eval.x86_64.mwaskom_1776_seaborn-2848:latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         openssh-server socat e2fsprogs iproute2 procps util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ssh-keygen -A \
    && mkdir -p /root/.ssh /run/sshd \
    && echo "anchor-swe" > /etc/heyo-hostname

COPY init.sh /init.sh
RUN chmod 0755 /init.sh
