# Built from the repo root (`docker build -f packages/web/Dockerfile .`)
# so it can reach the whole monorepo — packages/web depends on
# @karyakram/core (a workspace package) at build time. See docs/08-kubernetes.md
# for why this is a separate image from karyakram-app: nginx serving
# static files is a fundamentally different runtime, not another Node
# process choosing a different entrypoint.
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @karyakram/core run build

# Baked in at build time, not runtime — this is a static nginx image, and
# the value has to be something the *browser* can reach, not an
# in-cluster DNS name. Matches the fixed NodePort the demo's kind cluster
# config maps to a known host port. See docs/08-kubernetes.md and
# k8s/kind-config.yaml.
ARG VITE_API_BASE_URL=http://localhost:8081
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @karyakram/web run build

# ---

FROM nginx:1.27-alpine AS karyakram-web

COPY --from=build /repo/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
