---
title: How to Keep a Message Queue From Becoming a God Service
description: A queue is supposed to decouple services, not quietly become the thing that knows how your whole system fits together. Where that boundary actually sits, Kafka vs RabbitMQ as a narrower question than it sounds, and what should own orchestration instead.
publishDate: 2026-09-21
tags: [messaging, kafka, rabbitmq, orchestration]
---

A message queue starts its life as the simplest possible thing: a durable
inbox between two services that don't want to be woken up by each other's
downtime. Nobody designs it to become a god service. It happens one
reasonable-looking decision at a time — a routing key that encodes a business
rule, a consumer that fans out to three other services because "it's already
in the handler," a `reply-to` header that turns a queue into an ad hoc RPC
layer. None of these look like architecture decisions. They're just the
easiest way to ship the next feature.

## The responsibility that keeps leaking in

A series of small, reasonable-looking decisions is usually what gets you
there. Watch for:

- **Routing logic that encodes business rules.** A topic exchange with
  bindings like `order.*.high-value.*` means the *broker config* now knows
  what "high-value" means. That's a business rule living in infrastructure
  that no one code-reviews the way they'd review a service.
- **A consumer that coordinates its siblings.** If handling one message
  means synchronously calling four other services in sequence, the queue
  didn't decouple anything — it just moved a monolith's call graph one hop
  downstream and hid it in a consumer function.
- **Payloads that grow into a shared schema everyone depends on.** Once five
  services read one event and each needs a slightly different subset of
  fields, the message body becomes a de facto shared database table, with
  none of a database's tooling for migrations or ownership.
- **Retry and ordering assumptions nobody wrote down.** "This works because
  consumer B always processes after consumer A" is a business invariant
  hiding in message timing. It will break the day someone adds a partition
  or a second consumer instance.

Draw the line at what a queue can actually guarantee: **delivery, ordering
scope, and durability** — never *who talks to whom next*. The moment a queue's
configuration or a consumer's handler encodes "and then call the next
service," that decision has quietly become load-bearing infrastructure with
none of the visibility a real orchestrator would give it.

## Kafka vs. RabbitMQ is a narrower question than it sounds

Both get reached for as "the message queue," but they're solving different
problems, and the wrong pick is usually what forces responsibility to leak
into the wrong place later.

The practical question to ask: **does anything downstream need to replay
history, or does every message just need to reach exactly one worker and be
done?** Event sourcing, audit trails, analytics pipelines, and "many teams
each want their own read of the same event stream" all point at Kafka. Job
queues, RPC-style request/reply, and anything that needs the broker to make
a routing or priority decision at delivery time point at RabbitMQ. Picking
Kafka for a task queue usually means reinventing acknowledgment and retry
semantics RabbitMQ gives you for free; picking RabbitMQ for an event stream
usually means someone eventually builds a bad, bespoke version of Kafka's
replay log on top of it.

| | Kafka | RabbitMQ |
|---|---|---|
| Model | Append-only log, partitioned; consumers pull and track their own offset | Smart broker; pushes messages, tracks per-message state |
| Best fit | Event streams many independent readers need to replay or reprocess | Task distribution and request/reply where the broker should make per-message routing calls |
| Ordering | Guaranteed per-partition only | Guaranteed per-queue, with more per-message control (priority, delay, TTL) |
| Replay | Native — offsets are just a pointer into the log | Not native — consumed messages are gone unless you built retention yourself |
| Routing intelligence | Minimal by design — routing is a partition key, not broker logic | Rich — exchanges, bindings, dead-lettering, priority queues |
| Throughput ceiling | Very high, built for it | High, but the broker does more work per message so it costs more at the same volume |
| Distribution makeup | Inherent — partitions spread across brokers, each replicated across an in-sync-replica (ISR) set | Optional — a single node handles real load by default; HA comes from quorum queues (Raft-based) when you need it |
| Example fit | A clickstream/activity-event pipeline where a dashboard, a warehouse loader, and a fraud-detection service each independently replay the same stream | A file-upload service dispatching each upload to workers for virus scanning, thumbnailing, and transcoding — each job acked and retried on its own |

## Do these actually need to be distributed?

That's a separate question from which tool you picked, and the two engines
answer it very differently.

**Kafka is distributed by construction.** A topic's partitions are spread
across brokers, each partition has a replication factor with an
in-sync-replica (ISR) set, and consumer parallelism is capped by partition
count — one consumer per partition within a group. Running Kafka
"undistributed" isn't really an option past a single dev broker; the
distribution model is the point.

**RabbitMQ is distributed by choice.** A single well-resourced node handles
a surprising amount of real traffic, and reaching for a cluster before you
need one just adds quorum overhead. When you do need HA, **quorum queues**
(Raft-based, the modern default) replace the old mirrored-queue
implementation that had well-documented split-brain problems. If you
specifically want Kafka-like replay semantics *within* RabbitMQ, **streams**
are the newer, purpose-built answer rather than bending a classic queue into
that shape.

The decision to distribute either one should be driven by a measured
throughput or availability requirement, not by a sense that "production
should be clustered." A single RabbitMQ node behind good monitoring is
often the right answer for a while.

## Who coordinates the fallout downstream

This is where most of the responsibility creep described above actually
ends up: one event lands, and now four or five microservices need to react
to it in some order, some of them conditionally, some with compensation if a
later step fails. The instinct is to let that emerge from services reacting
to each other's events — **choreography**. It feels appropriately decoupled
at first. It stops feeling that way once you're trying to answer "what
happens when service C fails" by mentally simulating six services' event
handlers, because there's no single place that sequence is written down.

The alternative is putting a **named coordinator** in front of that fallout
instead of letting the queue's topology become the coordinator by accident.
This is the **orchestration** half of the saga pattern, and it's a real,
separate layer — not a bigger message broker:

- **[Temporal](https://temporal.io)** — workflows as ordinary code (retries,
  timers, and compensation are language constructs, not YAML), with durable
  execution so a workflow survives process crashes and resumes exactly where
  it left off. The default reach if the team wants orchestration logic to be
  testable, debuggable code.
- **AWS Step Functions** — JSON-defined state machines, deeply native to the
  rest of AWS (Lambda, SQS, ECS as steps). A strong fit if the downstream
  services already live in AWS and you don't want to run and operate
  another piece of infrastructure yourself.
- **Camunda / Zeebe** — BPMN-based, common where the workflow itself needs
  to be visible and editable by non-engineers (ops, compliance), not just
  encoded in a repo.
- **Netflix Conductor** — JSON DAG-based orchestration engine, open source,
  a reasonable option for teams that want Step-Functions-style declarative
  workflows without being on AWS.

What all of them give you that choreography doesn't: **one place that owns
the sequence**, can time out a stuck step, can run compensating actions when
step three fails after step one and two already succeeded, and can be
queried for "where is saga `order-4471` right now" without grepping logs
across five services. The queue still does what it's good at — durable,
decoupled delivery between the orchestrator and each worker. It just stops
being asked to also remember the plan.

The rule of thumb that holds up: if you can point to the one artifact that
says "this is the order things happen in, and this is what we do if step
three fails," you have an orchestrator. If that knowledge only exists as the
sum of every consumer's handler code, your message queue has become one
without anyone deciding it should.
