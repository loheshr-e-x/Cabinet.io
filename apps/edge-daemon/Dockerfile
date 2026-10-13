# Step 1: Build binary using a Rust version supported by the locked dependencies
FROM rust:1.94-slim-bookworm AS builder
WORKDIR /app

# Install build tools and C dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    clang \
    git \
    libclang-dev \
    libvpx-dev \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY apps/edge-daemon/Cargo.toml apps/edge-daemon/Cargo.lock ./
COPY apps/edge-daemon/src ./src

RUN git clone https://github.com/libretro/libretro-fceumm.git /tmp/libretro-fceumm \
    && git -C /tmp/libretro-fceumm checkout ac0d00a7fc01166f84c7bac01d1084ebfd2b865e \
    && make -C /tmp/libretro-fceumm -f Makefile.libretro platform=unix -j2 \
    && install -D /tmp/libretro-fceumm/fceumm_libretro.so /out/fceumm_libretro.so

RUN cargo build --locked --release

# Step 2: Minimal runtime image
FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libvpx7 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/cabinet-edge-daemon /app/edge-daemon
COPY --from=builder /out/fceumm_libretro.so /usr/lib/libretro/fceumm_libretro.so

ENV LIBRETRO_CORE_PATH=/usr/lib/libretro/fceumm_libretro.so

EXPOSE 8080

CMD ["/app/edge-daemon"]