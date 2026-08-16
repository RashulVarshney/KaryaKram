# One shared image for every backend Node process (API, scheduler, worker
# app) — same monorepo, same node_modules; which process actually runs is
# chosen by each Kubernetes Deployment's `command:`, the same way the
# demo scripts have picked an entrypoint since M1. See docs/08-kubernetes.md.
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---

FROM node:22-slim AS karyakram-app

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/bench ./bench

# No default CMD — every Deployment sets its own `command:`, exactly like
# every demo script since M1 has chosen which src/bin/*.ts to run.
