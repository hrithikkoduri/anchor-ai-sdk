# Eval image

A broad Linux toolchain for public benchmarks on Heyo: Python 3.12 + 3.11,
pip, pytest, Node 22, R, Redis, SQLite, a native build toolchain, and the
guest plumbing `/init.sh`/sshd that Heyo boots.

## Option A — let the Heyo host build it (no local Docker)

Push this directory on a branch, then point the eval at the branch:

```bash
# .env (gitignored)
HEYO_IMAGE=anchor-eval:git
HEYO_IMAGE_KIND=git
HEYO_IMAGE_GIT_REPO=https://github.com/hrithikkoduri/anchor-ai-sdk.git
HEYO_IMAGE_GIT_REF=eval-image
HEYO_IMAGE_GIT_DOCKERFILE=Dockerfile
HEYO_IMAGE_GIT_CONTEXT=evals/image
HEYO_IMAGE_SIZE_MB=8192
HEYO_DISK_GB=10
```

The first `sandbox.start()` pays for the host build; later boots reuse it.

## Option B — Sailor's local recipe

Sailor's `image/build.sh` builds the Docker image, exports the rootfs,
materializes an ext4 disk, and publishes it with `heyctl`:

```bash
docker build --platform linux/amd64 -f Dockerfile -t anchor-eval .
cid="$(docker create anchor-eval)"
docker export "$cid" -o rootfs.tar
docker rm "$cid"
# inside a Linux container with e2fsprogs:
mke2fs -q -t ext4 -d /rootfs -F rootfs.ext4 8192M
heyctl login --server "https://admin.us5.heyo.work" --token-stdin
heyctl artifact push rootfs.ext4 --tag harness/anchor-eval:latest --public
```

`heyctl` is installed with `cargo install hws`. The published artifact is a
`heyvm.rootfs.v1` (4–8 GiB `rootfs.ext4`), so publish from a Linux host/CI:
macOS cannot create the root-owned filesystem entries.
