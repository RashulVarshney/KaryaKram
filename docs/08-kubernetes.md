# Design note: deploying to a real orchestrator, not inventing new guarantees

Status: **implemented** (M8 complete). The "Implementation notes" section
near the end was added during wrap-up.

## What M8 is not

Every milestone through M7 proved something new about this system:
event sourcing, deterministic replay, retries/timers/signals, leader
election, observability. M8 proves nothing new. `docs/plans/m8-kubernetes.md`'s
own "Depends on" line says it plainly: this is packaging and infra for
guarantees the system already has. The exit criteria is that a `kubectl
delete pod` mid-workflow behaves the same way `kill -9` already did in
M1's and M3's local demos — same at-least-once activity execution, same
exactly-once workflow completion, now under a real orchestrator's pod
lifecycle instead of a locally-spawned Node process. If this milestone
needed a new correctness argument, that would mean something upstream
was never actually proven — it would, so the goal here is confirmation
under different infrastructure, not new engineering.

## `kind`, not minikube — and confirmed to actually work here first

Both are throwaway local clusters; the difference is what runs under
them. minikube typically drives a VM (or a container driver, depending
on setup) as the node; `kind` runs each "node" as a Docker container
directly — no extra virtualization layer, and it's purpose-built for
exactly this use case: spin up a real cluster for a demo or CI run, throw
it away when done. That's a better fit for a project that's already
chosen the minimal tool for the job at every prior milestone (a plain SQL
advisory lock over a coordination service in M6, a hand-rolled harness
over k6 in M7) — `kind` needs nothing beyond the Docker daemon this
project already depends on for Postgres.

This wasn't assumed to work — it was checked before any of this note was
written. `kind create cluster` was run directly in this project's
development environment first: a real cluster came up, `kubectl get
nodes` showed it `Ready`, and every core pod (`coredns`, `etcd`,
`kube-apiserver`, `kube-controller-manager`, `kube-scheduler`,
`kube-proxy`, the CNI, the storage provisioner) reached `Running`. That
matters for the same reason it mattered before saying M5's browser UI
worked: build success and a healthy-looking log line are not the same as
having actually run the thing. Here, the thing was actually run.

## Plain manifests + `kubectl kustomize`, not Helm

Helm earns its cost when there's more than one real deployment target —
different environments, different value overrides, a chart meant to be
reused by other people. This milestone has exactly one target: a local
`kind` cluster, applied the same way every time, by one command. Helm's
templating language, `values.yaml` layer, and chart versioning would all
be solving a problem this project doesn't have yet. `kustomize` is built
into `kubectl` itself (`kubectl apply -k`) — no extra tool, no extra
dependency — and is enough to bundle a directory of plain YAML into one
`kubectl apply`. Plain YAML also means every manifest is readable
top-to-bottom without a templating engine in the way, which matters for
a project whose whole point is showing the actual mechanism, not hiding
it behind abstraction.

## Two images, not five

Five components run as Node processes today (the API server, the
scheduler, and the timer-workflow worker app — activity, workflow-replay,
and timer workers together in one process, the same "app" shape M4's own
demo already used) plus one that serves static assets (the web frontend).
Building a separate Docker image per Node process would mean four
nearly-identical images — same base, same `pnpm install && pnpm build`,
differing only in which `dist/**/bin/*.js` gets run as the final `CMD`.
Instead: **one shared image** (`karyakram-app`) containing the fully
built monorepo (every package's `dist/`, plus `node_modules`), with the
actual process chosen by the Kubernetes Deployment's `command:` — the
scheduler Deployment runs `node packages/scheduler/dist/bin/run-scheduler.js`,
the worker Deployment runs `node packages/worker-sdk/dist/bin/timer-workflow-app.js`,
the API Deployment runs `node packages/api/dist/bin/serve.js`. This is
the same pattern the demo scripts have used since M1 — one codebase,
the entrypoint picked by whoever's launching the process — just moved
from `spawn()`-ing a local `tsx` process to a Kubernetes `command:`. The
web frontend gets its own **second image** (`karyakram-web`) because it's
a genuinely different runtime: static files served by nginx, not a Node
process at all.

## Observability-in-Kubernetes: explicitly out of scope

M7 already proved tracing and metrics work, verified live against a real
Jaeger/Prometheus/Grafana stack — over Docker Compose, not Kubernetes.
Redeploying that same stack a second time, now as Kubernetes manifests,
would prove nothing new about the metrics/tracing code and would roughly
double this milestone's manifest surface for a demo that isn't part of
the exit criteria (the exit criteria is about pod-deletion durability,
not about where Grafana lives). Every process already reads
`OTEL_EXPORTER_OTLP_ENDPOINT`/`METRICS_PORT` from the environment, so
wiring observability into the cluster later is a ConfigMap entry away,
not a redesign — deliberately left for whenever it's actually needed
rather than built now to look complete.

## The chaos demo reuses M1/M3/M4/M6's own verification, it doesn't reinvent it

Two pod-deletion checks, each mapped directly onto a guarantee an earlier
milestone already proved locally:

1. **Worker pod deleted mid-workflow.** Start the M4 timer workflow
   (`timerWorkflow` — activity, durable timer, activity), wait for the
   first activity to complete, `kubectl delete pod` the worker pod that's
   running it (`--grace-period=0` to approximate the abruptness of
   `kill -9`, not a graceful drain), let the Deployment controller
   reschedule a replacement, and confirm the workflow still reaches
   `COMPLETED` with each activity's execution count still exactly 1 —
   the identical assertion M4's local demo already makes, just triggered
   by the Kubernetes scheduler's pod lifecycle instead of a local
   `child_process.kill('SIGKILL')`.
2. **Scheduler leader pod deleted.** Run 3 scheduler replicas, confirm
   one is leader (`scheduler_leadership`, same as M6), delete that pod,
   confirm a survivor takes over — the identical check M6's local demo
   already makes, under real pod scheduling instead of `kill -9` on a
   locally-spawned process.

Neither check is new engineering. Both exist to answer one question
honestly: does moving from "a local process the demo script spawned and
killed" to "a pod Kubernetes spawned and I deleted" change any of the
guarantees already proven? It shouldn't, by construction — the
durability mechanisms (event sourcing, leases, advisory locks) don't
know or care what process-management layer is above them. This demo is
where that claim gets checked, not assumed.

## The Kubernetes demo is a manual script, not part of `pnpm test`

`pnpm test` (unit + integration) has to stay fast — it runs on every
push. Standing up a `kind` cluster, building and loading two Docker
images, and running a multi-step chaos scenario takes real wall-clock
time and a real Docker daemon with room for an extra cluster's worth of
containers — the same reason M1 through M7's own `demo:mN` scripts were
never folded into `pnpm test` either. `pnpm demo:m8` follows that same
established pattern: a slower, infra-heavy proof script that's run
explicitly, not a fast regression check that runs on every commit. CI
keeps checking lint/typecheck/build/unit/integration, unchanged.

## Exit demo, restated precisely

`pnpm demo:m8` builds both Docker images, creates a `kind` cluster,
loads the images into it (no registry needed for a local demo), applies
the manifests via `kubectl apply -k k8s/`, waits for every Deployment to
report ready, then runs the two chaos checks above and prints a
pass/fail summary for each — the same shape every prior milestone's demo
has used, now proving its guarantees hold under `kubectl delete pod`
instead of a local `kill -9`.

## Implementation notes

**A real bug, found by actually running the migration Job in a pod
rather than assuming the command was right**: `k8s/migrate-job.yaml`
originally ran `node_modules/.bin/node-pg-migrate`, resolved from
`/repo` (the image's `workingDir`). It failed immediately —
`OCI runtime create failed ... exec: "node_modules/.bin/node-pg-migrate":
stat node_modules/.bin/node-pg-migrate: no such file or directory`.
`node-pg-migrate` is a devDependency of `packages/db` specifically, not
the workspace root, so pnpm links its executable at
`packages/db/node_modules/.bin/node-pg-migrate` — a repo-root-relative
`node_modules/.bin/` never had it. Confirmed with `docker run --entrypoint
sh` against the built image before touching the manifest, fixed by
pointing the Job's `command` at the correct path, then reconfirmed by
actually running the Job to completion in a real pod. The same
class of gap M7's `pg_notify` bug came from: something that looks right
by inspection and is wrong the instant it actually runs.

**`kind` really does work in this project's development environment,
end to end, not just for `kind create cluster`.** The full flow — two
`docker build`s, a real cluster, `kind load docker-image`, `kubectl
apply -k`, both chaos checks, teardown — was run start to finish (twice:
once to catch the migration bug, once clean) before calling this
milestone done. A representative run:

```
7. Chaos check 1: kill the worker pod mid-timer-workflow...
   workflowId = d8188053-2a61-4357-b308-47cd415ac5ad
   deleting pod/worker-7f5bfbcbb6-fj4xj with --grace-period=0...
   before-timer executions: 1, after-timer executions: 1 — PASS

8. Chaos check 2: kill the scheduler leader pod...
   current leader = scheduler-5648dfdd8f-c5s87
   deleting pod/scheduler-5648dfdd8f-c5s87 with --grace-period=0...
   new leader = scheduler-5648dfdd8f-4b5zl, failover took 566ms — PASS

PASS: worker-pod and scheduler-leader chaos checks both hold under a real Kubernetes cluster.
```

Both checks passed on both runs. Scheduler failover under real pod
deletion (566ms here) landed in the same rough range M6's local `kill
-9` demo measured (32ms–223ms across 6 runs) — a little higher, which
tracks: a Kubernetes pod delete goes through the API server and the
kubelet's own teardown before the container actually dies, whereas a
local `kill -9` hits the process directly. Still comfortably fast, and
the mechanism doesn't care which layer triggered the connection loss —
the advisory lock releases the same way either way.

**`kubectl`/`kind` were installed to `~/.local/bin`, not a system-wide
location** — this environment has no passwordless `sudo`, and
`/usr/local/bin` isn't writable without it. Neither tool needs root to
run: `kind` just talks to the already-available Docker daemon. Anyone
reproducing this demo with normal `sudo` access can install them
wherever they'd normally put CLI tools; nothing about the manifests or
the demo script assumes a particular install location, only that
`docker`, `kind`, and `kubectl` resolve on `PATH`.
