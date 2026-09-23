---
title: Picking the Thing That Remembers the Plan
description: Temporal, Step Functions, Conductor, etcd, and Kafka all get called "orchestration" at some point. They sit at three different layers. How to tell them apart, and which one to reach for in seven system designs where one click fans out across many services.
publishDate: 2026-09-22
tags: [orchestration, temporal, step-functions, sagas, microservices]
---

Click "Place order" on a hardware store, or "Submit" on LeetCode, and a
dozen services each do one narrow job: validate, reserve, charge, run,
score, notify. Something has to know what order those jobs happen in and
what to undo when job four fails. The
[message queue note](/system-design/message-queue-responsibility-boundaries)
argued that the queue shouldn't be that something. This one is about what
should be, and how to choose it.

The hard part is the vocabulary. "Orchestration" gets used for three
different layers, and designs go sideways when they mix them.

## Three layers that all get called orchestration

**Message queues and logs** (Kafka, RabbitMQ, SQS) move a message from a
producer to a consumer durably. They know about delivery, acknowledgment,
ordering scope, and retention. They have no idea that message B is supposed
to follow message A, or that a failure at step four means step two needs
reversing.

**Coordination stores** (etcd, ZooKeeper, Consul) hold a small amount of
strongly consistent state that a cluster agrees on: who the leader is, who
holds a lock, which instances are alive, what the config is. They give you
primitives (leases, ephemeral nodes, watches, compare-and-swap) and nothing
above them. etcd is the brain of Kubernetes, which is why it shows up next to
the word "orchestration", but Kubernetes orchestrates *containers* by running
controllers that watch etcd and reconcile toward a desired state. Nobody
writes a checkout flow as etcd keys.

**Workflow orchestrators** (Temporal, AWS Step Functions, Camunda, Conductor)
own the business sequence itself. They persist where each workflow instance
is, call each step, apply retries and timeouts per step, wait for hours or
days if needed, and run compensation when a later step fails. This is the
layer a multi-service submit flow needs.

| | Message queue / log | Coordination store | Workflow orchestrator |
|---|---|---|---|
| Examples | Kafka, RabbitMQ, SQS | etcd, ZooKeeper, Consul | Temporal, Step Functions, Camunda, Conductor |
| Stores | Messages in flight (or a retained log) | Kilobytes of cluster metadata | The state of every running workflow instance |
| Knows about sequence? | No | No | Yes, that's its whole job |
| Failure story | Redelivery, dead-letter queue | Lease expiry, leader re-election | Per-step retry, timeout, compensation |
| Typical question it answers | "Did this event reach every consumer?" | "Which node is the leader right now?" | "Where is order 4471, and what happens if the charge fails?" |

In a real system they stack. A Temporal cluster uses a database for
durable state and internal task queues to hand work to workers. Kafka
(before KRaft) used ZooKeeper for controller election. A checkout workflow
might publish `order-completed` to Kafka at the end so the analytics and
search teams can react without the workflow knowing they exist.

### Where the ZooKeeper vs etcd question fits

It's a real comparison, one layer down. Both are CP consensus stores: Zab
with a hierarchical tree of znodes for ZooKeeper, Raft with a flat key space
for etcd. etcd is lighter and speaks gRPC, and it's the default in
cloud-native stacks; ZooKeeper's footprint keeps shrinking now that Kafka
dropped it. Consul adds service discovery, health checks, and multi-datacenter
gossip on top of its own Raft core. You'd bring any of them up for leader
election, distributed locks, or service discovery. None of them has
anything to say about a submit flow.

## Choreography first, or a named coordinator

Before picking a tool, decide whether you need one. Choreography (each
service reacts to the previous service's event) is fine when the steps are
few, independent, and don't need undoing. A post being published and
triggering search indexing, notifications, and analytics is choreography,
and an orchestrator would add latency and a dependency for nothing.

You want an orchestrator when at least one of these is true:

- A later step's failure means earlier steps have to be reversed (a saga).
- The flow waits on something slow or human: a warehouse scan, a fraud
  review, a 20-minute cloud API.
- Someone will ask "what state is this particular request in?" and the
  answer can't be "grep five services' logs."
- The sequence changes often enough that it should live in one reviewable
  file.

## The tools, briefly

**Temporal** (and Cadence, which it forked from) runs workflows as ordinary
Go, Java, TypeScript, or Python. The server records every step's result in
an event history stored in Cassandra, Postgres, or MySQL. If a worker dies,
another one replays that history through the workflow code and continues
from the exact line it stopped at. Retries, timers, and compensation are
plain `try`/`catch` and `sleep`. The cost is that workflow code must be
deterministic (no direct wall-clock reads or random numbers), and a single
workflow's history is capped (around 50K events), so very long loops use
Continue-As-New to start a fresh history. You run the cluster yourself or
pay for Temporal Cloud.

**AWS Step Functions** defines the state machine in Amazon States Language
(JSON), with first-class integrations for Lambda, ECS, SQS, DynamoDB, and
most of AWS. Standard workflows run for up to a year and are billed per state
transition. Express workflows cap at five minutes and are billed by duration,
which suits high-volume, short flows. Distributed Map fans a step out across
thousands of parallel child executions. Zero servers to run; the price is AWS
lock-in and branching logic that gets unwieldy in JSON.

**Camunda (Zeebe)** models workflows in BPMN, the flowchart notation business
analysts already use. It earns its place when ops or compliance people need
to read or edit the process, like insurance claims or loan approvals.

**Conductor** is Netflix's JSON-DAG engine. Netflix stopped maintaining it in
late 2023; it lives on as Conductor OSS, maintained by Orkes. Still a fair
choice for declarative workflows off AWS, though you're picking a smaller
community than Temporal's.

## Seven system design choices

### 1. Hardware order checkout

Validate the cart and coupon, run fraud checks, reserve inventory at a
warehouse, charge the card, create a shipment, email the customer. If the
charge fails after inventory is reserved, release the inventory. If shipping
fails after the charge, refund.

**Pick: Temporal.** This is the textbook saga. The compensation logic is the
interesting part, and in Temporal it reads like code: each successful step
pushes its undo onto a list, and the `catch` block walks the list backwards.
The flow also changes constantly (a new fraud vendor, a buy-now-pay-later
branch, a region with different tax rules), and code gets reviewed and tested
like everything else. Step Functions works too if the shop is all-in on AWS,
but the rollback branches multiply fast in JSON.

Each activity must be **idempotent** because the orchestrator retries it. Pass an idempotency key (the order ID plus step
name) to the payment provider so a retried charge doesn't double-bill.

### 2. LeetCode "Submit"

Enqueue the code, pick a sandbox, compile, run 50 test cases with time and
memory limits, tear down the sandbox, write the verdict, update the user's
stats, and push the result back to the browser.

**Pick: Amazon SQS feeding a pool of sandbox workers, with no workflow
engine.** A submission lives for a few seconds and has no compensation: if a
sandbox dies mid-run, you rerun the whole submission, which is cheap and
correct because running code has no external side effects. The things that
matter are throughput during a contest spike and the latency the user feels
while staring at "Judging…". SQS's visibility timeout and a dead-letter
queue give you "a crashed worker's job gets picked up again"
for free. The post-verdict side effects (stats, streaks, contest leaderboard,
plagiarism checks) are choreography off a `submission-judged` event.

An orchestrator becomes worth it if the judge grows long-running steps:
contest-end rejudging of every submission, or a CI-style pipeline where one
failed stage should skip the rest and report partial results. Temporal fits
that well. Until then, a workflow engine on this path would add a network hop
per step to a flow that needs none of what it offers.

### 3. Cloud environment provisioning

Create a VPC, subnets, five VMs, two managed databases, and firewall rules.
Each call to the cloud API returns immediately and completes 30 seconds to 20
minutes later. Some steps depend on others; some can run in parallel. If the
database fails to come up, tear down what was created.

**Pick: AWS Step Functions.** The flow is
mostly "call, then poll until ready," which Step Functions expresses directly
with Wait states and retries, and Standard workflows run long enough for any
provisioning job. The dependency graph maps cleanly to Parallel states, and
the provisioning calls themselves are AWS API calls Step Functions can make
without any glue code. Off AWS, or when the steps involve lots of conditional logic per provider,
Temporal's durable timers make "poll every 30 seconds for up to 20 minutes"
a three-line loop.

This is also the one place etcd comes up legitimately. Done
Kubernetes-style, provisioning becomes a controller: store
the desired environment spec, watch it, and reconcile toward it repeatedly
(Crossplane does exactly this). Reconciliation handles drift that a
one-shot workflow never sees, at the cost of being harder to explain as a
sequence.

### 4. Video upload and transcoding

The raw file lands in object storage via a presigned URL. Split it into
10-second chunks, transcode each chunk into several resolutions across
hundreds of workers, stitch the outputs, run moderation, generate
thumbnails, push to the CDN, then mark the post live.

**Pick: AWS Step Functions with Distributed Map.** The top-level sequence
(split → transcode all → stitch → moderate → publish) is
a workflow, and it needs one because "moderation rejected it, delete every
rendition" is compensation. The transcode step is a fan-out of thousands of
identical, independent jobs. Distributed Map runs that fan-out as thousands
of parallel child executions and collects the results before the stitch step
starts, so the chunk dispatch and the control flow live in one definition.
In Temporal, the workflow enqueues the chunks as activities and waits for all
of them, though at thousands of chunks per video you'd batch them or use
child workflows so one workflow's history doesn't hit its cap. Conductor was
built for exactly this at Netflix and still works, with the caveat that
Netflix no longer maintains it.

Once the post goes live, publishing `post-published` to Kafka hands off to
feed fan-out, search, and analytics. The workflow ends at the moment the
content is ready, and everything after that is choreography.

### 5. Loan application and approval

A borrower applies. Verify identity (KYC), pull a credit report, run
automated underwriting rules, and route anything borderline to a human
underwriter, who may request more documents and wait days for them. Approved
loans go to e-signature, then funding. Regulators can ask, years later, why
a specific application was declined.

**Pick: Camunda.** The process has human steps that last days, and people
outside engineering own its rules: credit policy decides the thresholds,
compliance decides what gets reviewed, and auditors need to see which path an
application took. BPMN gives all of them one diagram to read, and Camunda
executes that diagram directly, including user tasks that show up in an
underwriter's work queue with their own deadlines and escalations. Each
completed instance leaves an audit trail of every step, decision, and who
made it.

Temporal could run the same flow, and the code would be clean, but every
policy change would go through an engineer and a deploy, and the auditor's
question gets answered by reading Go. When the process is itself the
regulated artifact, a model that non-engineers can read is worth the extra
ceremony.

### 6. Posting a tweet

A user posts. The post is saved, attached media gets processed, the post
fans out to followers' timelines, gets indexed for search, triggers
mention and reply notifications, and feeds trends and analytics.

**Pick: Kafka, with the services choreographed off a `post-created`
event.** Plenty of services react to one click here, but none of them
depends on another's result, and nothing needs undoing if one of them lags.
Search indexing a few seconds late is fine. A notification that fails gets
retried by the notification service on its own. The timeline fan-out (the
heavy part, covered in [One Post, a Million Feeds](/system-design/news-feed-read-path))
is one consumer group among several, reading the same event as search and
analytics, each at its own pace. Kafka's retained log also lets a new
consumer, like a spam model added next quarter, replay recent posts without
anyone re-publishing them.

The one piece with a real sequence is media: a video has to finish
transcoding before the post shows up in feeds. That's scenario 4, and it
runs before `post-created` gets published. The tweet flow itself has no
plan for anything to own.

### 7. A distributed job scheduler

Build the system that runs millions of scheduled jobs: "every day at 09:00
in the user's timezone, send the digest," "every 5 minutes, sync this
account," "once, 30 days from now, expire this trial." Each job must fire
on time, once, even when scheduler nodes crash.

**Pick: etcd to coordinate the scheduler nodes, with jobs stored in a
database and dispatched through SQS.** Here the thing being designed is the
scheduler, so the hard problem sits one layer down: making sure every job
has exactly one scheduler node responsible for it at any moment. Split the
jobs table into partitions by job ID. Each scheduler node takes ownership of
a set of partitions by holding an etcd lease on each one. Every second or
so, a node queries its partitions for jobs where `next_run_at <= now`, sends
them to SQS, and advances `next_run_at` in the same transaction. If a node
dies, its leases expire within seconds, and the surviving nodes claim the
orphaned partitions and pick up where it left off. A worker pool consumes
SQS and runs the jobs.

The jobs themselves live in the database. etcd holds only which node owns
which partition, a few kilobytes, which is the size of data it's built for.
Delivery is at-least-once (a node can crash after enqueueing but before
committing), so workers deduplicate on a run ID made of the job ID plus its
scheduled time.

Temporal has built-in Schedules, and if your product already runs on
Temporal and needs a few thousand cron-style jobs, use them. At millions of
jobs, wrapping each one in a workflow means running a workflow engine as a
timer database. A workflow engine does come back in when a single job is
itself a multi-step pipeline, like a nightly export that extracts, transforms,
and uploads: the scheduler fires the job, and the job starts a workflow.

## A cheat sheet for new scenarios

| If the flow… | Reach for | Because |
|---|---|---|
| Has compensation logic and changes often | Temporal | Sagas read as code, get tested as code |
| Lives entirely in AWS and is mostly calls to AWS services | Step Functions | No servers, native integrations, visual execution history |
| Must be readable or editable by non-engineers | Camunda | BPMN is the shared language with ops and compliance |
| Is seconds long, high volume, and safe to rerun from scratch | SQS + a worker pool | An orchestrator adds latency and buys nothing |
| Is one event that several teams react to independently | Kafka + choreography | No sequence to own, so nothing needs to own it |
| Needs leader election, locks, or config agreement | etcd / ZooKeeper / Consul | A different layer; this was never workflow state |

The test from the queue note still holds. If you can point to one artifact
that says "this is the order things happen in, and this is what we do when
step three fails," you have an orchestrator. The seven designs above mostly
differ in whether that artifact should exist at all, and whether it should
be code, JSON, or a BPMN diagram.
