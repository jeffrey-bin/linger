# Browser assets and the JavaScript static host are platform-independent. Build
# them natively; only the final Node runtime needs the requested target platform.
FROM --platform=$BUILDPLATFORM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS package-manager

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install --global pnpm@11.7.0 --registry="$NPM_REGISTRY" \
    && npm config set registry "$NPM_REGISTRY" --location=user \
    && npm config set @openai:registry https://registry.npmjs.org --location=user

WORKDIR /app

FROM package-manager AS dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY packages/document-files/package.json ./packages/document-files/package.json
COPY contracts/generated/typescript/package.json ./contracts/generated/typescript/package.json
COPY packages/document-model/package.json ./packages/document-model/package.json
COPY packages/knowledge-format/package.json ./packages/knowledge-format/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json

RUN --mount=type=cache,id=pnpm-store-web-node26.5.0-pnpm11.7.0-linux-amd64,sharing=locked,target=/pnpm/store \
    pnpm install --filter @linger/web... --frozen-lockfile --trust-lockfile \
    --store-dir /pnpm/store --fetch-retries 5 --fetch-timeout 1800000

FROM dependencies AS release-dependencies

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY contracts/generated/typescript ./contracts/generated/typescript
COPY packages/document-model ./packages/document-model
COPY packages/document-files ./packages/document-files
COPY packages/knowledge-format ./packages/knowledge-format
COPY packages/service-kit ./packages/service-kit
COPY scripts/ci/build-web-runtime.sh ./scripts/ci/build-web-runtime.sh
ENV NODE_ENV=production
# Production browser URLs follow the page origin. The Agent Service serves the
# Computer release on /install/.
RUN pnpm --filter @linger/web build:assets \
    && bash scripts/ci/build-web-runtime.sh /app/web-static-host.mjs

FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

WORKDIR /app

COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --from=build /app/web-static-host.mjs /app/apps/web/static-host.mjs
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "apps/web/static-host.mjs"]
