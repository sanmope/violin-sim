# Stage 1: Build the SpacetimeDB Rust module to WASM
FROM rust:1.94-bookworm AS builder

RUN rustup target add wasm32-unknown-unknown

WORKDIR /build
COPY server-module/ .
RUN cargo build --target wasm32-unknown-unknown --release

# Stage 2: SpacetimeDB server with the module baked in
FROM clockworklabs/spacetime:latest

USER root
COPY --from=builder /build/target/wasm32-unknown-unknown/release/violin_session.wasm /opt/module/violin_session.wasm
COPY spacetimedb-entrypoint.sh /opt/spacetimedb-entrypoint.sh
RUN chmod +x /opt/spacetimedb-entrypoint.sh
USER spacetime

EXPOSE 3000

ENTRYPOINT ["/opt/spacetimedb-entrypoint.sh"]
