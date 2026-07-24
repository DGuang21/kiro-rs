FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app/admin-ui
COPY admin-ui/package.json admin-ui/bun.lock* ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY admin-ui ./
RUN bun run build

FROM rust:1.92-alpine AS builder

RUN apk add --no-cache musl-dev perl make

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY --from=frontend-builder /app/admin-ui/dist /app/admin-ui/dist

RUN cargo build --release --no-default-features

FROM alpine:3.21

# tzdata：Alpine 默认无时区数据库，装上后 TZ 才能生效（chrono::Local 依赖它）。
# 默认东八区，使用量统计的"今日"切分、自动更新时间等按北京时间对齐；可用 TZ 覆盖。
RUN apk add --no-cache ca-certificates tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app
COPY --from=builder /app/target/release/kiro-rs /app/kiro-rs

VOLUME ["/app/config"]

EXPOSE 8990

CMD ["./kiro-rs", "-c", "/app/config/config.json", "--credentials", "/app/config/credentials.json"]
