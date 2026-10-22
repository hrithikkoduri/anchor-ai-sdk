# SWE-bench task image + Heyo guest plumbing. The official image already
# contains the conda env and /testbed at the task's base commit; this only adds
# the boot channel (sshd/init.sh) so Heyo can run it.
FROM swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-11143:latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         openssh-server socat e2fsprogs iproute2 procps util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ssh-keygen -A \
    && mkdir -p /root/.ssh /run/sshd \
    && echo "anchor-swe" > /etc/heyo-hostname

COPY init.sh /init.sh
RUN chmod 0755 /init.sh
