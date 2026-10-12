# Step 1: Build binary using latest official Rust image (supports Rust 2024 edition crates)
FROM rust:latest AS builder
WORKDIR /app

# Install build tools and C dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY apps/edge-daemon/Cargo.toml apps/edge-daemon/Cargo.lock ./
COPY apps/edge-daemon/src ./src

RUN cargo build --release

# Step 2: Minimal runtime image
FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/cabinet-edge-daemon /app/edge-daemon

EXPOSE 8080

CMD ["/app/edge-daemon"]