---
title: One Post, a Million Feeds
description: A news feed post is written once and read in thousands of places. How that shapes the storage layout, when a feed actually gets built, what happens when a celebrity posts, why feed pagination needs cursors, and which tech runs each layer.
publishDate: 2026-09-22
tags: [news-feed, fan-out, caching, pagination]
---

A post gets written once. If the author has 50,000 followers, it can be read
50,000 times, often within the first hour. The whole design follows from
that ratio: every decision moves work away from the read path, even when it
makes writes more expensive.

## Why a single posts table falls over

The obvious schema is one `posts` table and a query like this:

```sql
SELECT * FROM posts
WHERE author_id IN (/* the ~500 accounts I follow */)
ORDER BY created_at DESC
LIMIT 20;
```

That works for a prototype. At scale, `posts` is sharded by `author_id`, so
this query fans out to nearly every shard, pulls the latest rows from each,
and merge-sorts them. The feed is the most-opened screen in the app, so that
scatter-gather runs on every open and every pull-to-refresh, for every user.
Posts rarely change, but the join between "who I follow" and "what they
wrote" gets recomputed constantly.

So the data gets split by how it's read:

- **Posts store.** The source of truth for each post, keyed by `post_id`.
  It's written once and read through a cache.
- **Timeline store.** One list of `post_id`s per user, precomputed and
  ready to serve.
- **Social graph.** Follower and following lists, paged, so fan-out can walk
  them in chunks.

## Storing for reads

The timeline is a wide row per user, clustered by post ID in descending
order:

```sql
CREATE TABLE timeline (
  user_id  bigint,
  post_id  bigint,   -- Snowflake-style: time-sortable
  PRIMARY KEY (user_id, post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);
```

Or, for the hot tier, a Redis sorted set per user, capped at a few hundred
entries. It holds **IDs only**. A popular post exists once in the post cache
and is referenced from a million timelines as an 8-byte ID, so serving a
feed is one timeline read plus a batched multi-get for posts that are almost
always cached already. Time-sortable IDs give you ordering, uniqueness and a
pagination cursor from a single column.

## When the feed gets built

A feed can be assembled at three points, and production systems use all
three.

**When a post is written (push).** Fan-out workers take the new post off a
queue, page through the author's followers, and prepend the `post_id` to
each follower's timeline. By the time a follower opens the app, their feed
is already sitting in cache. This is the default path for most accounts.

**When the user opens the app (pull).** The feed service fetches recent
posts from each followed account and merges them on the spot. Writes cost
nothing and reads cost a lot, so pull is kept for cases where push is too
expensive or no timeline exists yet.

**When the feed is served (ranking).** On a ranked feed, the precomputed
timeline is a list of candidates. A ranking service scores a few hundred of
them per request, because its signals (likes in the last ten minutes, what
you just tapped on) go stale too fast to precompute.

Some events force a partial rebuild:

- **Follow:** backfill the new account's recent posts so the feed changes
  right away.
- **Unfollow:** filter that author out at read time, and clean the timeline
  up in the background.
- **Returning after weeks away:** inactive timelines get evicted, so the
  first load rebuilds by pull, and push keeps it warm from then on.
- **Scrolling past the cap:** the timeline holds a few hundred IDs, and
  anything older falls back to pull.

## When a popular account posts

Push for an account with 300 followers is a few hundred cheap writes. For an
account with 40 million followers, it's 40 million writes, most of them for
people who won't open the app today, and the fan-out workers back up for
everyone else.

So large accounts switch to pull:

- Accounts under a follower threshold fan out on write.
- Accounts over it skip fan-out. Their recent posts go into a small
  per-author cache.
- At read time, the feed service merges the user's precomputed timeline
  with the latest posts from the handful of large accounts they follow,
  ordered by `post_id`.

Most users follow only a few such accounts, so the merge costs a few cache
lookups. Set the threshold from measured fan-out cost, because a round
number picked up front will be wrong.

## Pagination

Offset pagination (`LIMIT 20 OFFSET 40`) breaks on a feed. New posts land at
the top while the user scrolls, so page three shifts down and repeats items
from page two.

Use a **cursor**: the last `post_id` the client saw.

```sql
SELECT post_id FROM timeline
WHERE user_id = ? AND post_id < :cursor
LIMIT 20;
```

> This assumes time-sortable IDs. With random or per-shard IDs, the cursor
> becomes `(created_at, post_id)`, with the ID breaking ties.

This composes with the hybrid merge because every source is sorted by the
same key. Take up to 20 IDs below the cursor from the timeline and from each
large account's cache, merge them, keep the top 20, and return the last one
as the next cursor. Pull-to-refresh runs the same query in the other
direction (`post_id > :newest_seen`).

Ranked feeds rank once per session and store that ordering briefly, and the
cursor becomes a position in it.

## The stack, layer by layer

| Layer | Holds | Tech | Why |
|---|---|---|---|
| Source of truth | Post rows, keyed by `post_id` | Sharded MySQL or Postgres (Vitess, Citus) | Key lookups and single-row writes, sharded by author |
| Post cache | Hydrated posts | Memcached | Fast multi-get across thousands of keys, and hot posts stay resident |
| Social graph | Follower and following edges | Sharded MySQL adjacency tables behind a cache (Meta's TAO is this shape) | Fan-out needs paged follower scans, and reads need "who do I follow" |
| Fan-out pipeline | New-post events | Kafka, partitioned by `author_id` | Absorbs bursts, keeps each author's posts in order, and replays if workers fall behind |
| Timeline store | Every user's post ID list | Cassandra or ScyllaDB | Wide rows kept sorted by the clustering key, with cheap appends that scale out |
| Timeline cache | The newest few hundred IDs per active user | Redis sorted sets | `ZADD` on fan-out, a range query per page, `ZREMRANGEBYRANK` to cap. Score by millisecond timestamp, since 64-bit IDs lose precision as a double |
| Large-account cache | Recent posts from accounts over the threshold | Redis lists, one per author | Every follower's feed load reads it, so it lives in memory |
| Ranking | Per-request candidate scores | Feature store (e.g. Feast on Redis) plus a model server | Fresh engagement signals within request latency |
| Cursors | Position in the feed | Opaque API token, plus Redis with a TTL for ranked session snapshots | Chronological feeds need no server state, and ranked feeds need a little for a short time |

The pattern underneath all of it: precompute whatever is cheap to precompute,
merge at read time whatever is too expensive to push, and accept that a feed
is a slightly stale, eventually consistent view. People scrolling a feed
won't notice a post showing up three seconds late. They will notice a feed
that takes three seconds to load.
