FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS dependencies
WORKDIR /src/apps/teamhub
COPY apps/teamhub/go.mod apps/teamhub/go.sum ./
COPY contracts/generated/go/go.mod /src/contracts/generated/go/go.mod
COPY skills/go.mod /src/skills/go.mod
RUN for attempt in 1 2 3 4 5; do \
		go mod download && exit 0; \
		sleep $((attempt * 5)); \
	done; \
	exit 1

FROM dependencies AS build
COPY contracts/generated/go /src/contracts/generated/go
COPY skills /src/skills
COPY apps/teamhub .
RUN CGO_ENABLED=0 go build -trimpath -o /out/teamhub ./cmd/teamhub && \
	CGO_ENABLED=0 go build -trimpath -o /out/teamhub-migrate ./cmd/migrate && \
	CGO_ENABLED=0 go build -trimpath -o /out/teamhub-account ./cmd/account && \
	CGO_ENABLED=0 go build -trimpath -o /out/teamhub-skill-package-audit ./cmd/skill-package-audit

FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f AS runtime-dependencies
RUN apk add --no-cache ffmpeg

FROM dependencies AS release-dependencies
COPY --from=runtime-dependencies /usr/bin/ffmpeg /release-dependencies/ffmpeg

FROM runtime-dependencies AS runtime-base
RUN addgroup -S teamhub && adduser -S -G teamhub teamhub
RUN mkdir -p /data && chown teamhub:teamhub /data
WORKDIR /app
USER teamhub

FROM runtime-base AS runtime
COPY NOTICE ./NOTICE
COPY third_party/licenses ./third_party/licenses
# The process listens on loopback by default; the image serves every interface.
ENV TEAMHUB_HTTP_ADDRESS=:8080
COPY --from=build /out/teamhub /usr/local/bin/teamhub
COPY --from=build /out/teamhub-migrate /usr/local/bin/teamhub-migrate
COPY --from=build /out/teamhub-account /usr/local/bin/teamhub-account
COPY --from=build /out/teamhub-skill-package-audit /usr/local/bin/teamhub-skill-package-audit
EXPOSE 8080
ENTRYPOINT ["teamhub"]
