# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-alpine AS ui
WORKDIR /build/web
COPY web/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS server
ARG TARGETOS
ARG TARGETARCH
WORKDIR /build
COPY go.mod ./
COPY *.go ./
COPY prompts/ ./prompts/
COPY investigate-skills/ ./investigate-skills/
COPY dashboard-skills/ ./dashboard-skills/
COPY --from=ui /build/web/dist ./web/dist
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /warroom .

FROM --platform=$BUILDPLATFORM alpine:3.21 AS certificates
RUN apk add --no-cache ca-certificates

FROM alpine:3.21
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=server /warroom /usr/local/bin/warroom
USER 65532:65532
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/warroom"]
