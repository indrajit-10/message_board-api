# message-board-api

Backs the **"Get Messages"** CTA on card-sending pages.

Today a user who doesn't know what to write leaves the card page, goes to
[What to Write in a Card](https://blog.123greetings.com/what-to-write-in-a-card/),
hunts for something, copies it, comes back and pastes. This API removes that
round trip: the message box's CTA sends the card's category and subcategory and
gets back 5 messages the user can insert with one tap.

Messages come from the blog via [`npm run ingest`](#getting-real-messages). Until
that has been run, the API serves a small set of checked-in fixtures instead, so
a fresh checkout still boots and the CTA still answers.

## Quick start

```bash
npm install
npm run dev     # http://localhost:3000
npm test
```

Open <http://localhost:3000> for the demo page, or call it directly:

```bash
curl "http://localhost:3000/v1/messages?category=birthday&subcategory=friends"
```

## Pages

| URL | What it is |
|---|---|
| `/` | The CTA demo — the feature as a card sender sees it |
| `/api` | API explorer — every endpoint, testable on its own |
| `/browse` | Every message currently loaded, by topic, with search |

All three are static files served by the API itself, so they call it
same-origin with no build step. `/api` and `/browse` both show whether the
messages are ingested or the built-in fixtures.


## Demo page

`http://localhost:3000` is a stand-in for a card-sending page: a message box
with the CTA wired up, so you can see the feature rather than read about it.
Pick a card with the preset chips or type any category, press **Get Messages**,
and click a suggestion to drop it into the box.

It is built to show the two behaviours that are easy to miss from the JSON:

- The **quinceanera / cousin** preset is a category with no messages. Note that
  the button still returns something usable and the panel says so, rather than
  erroring.
- **Show me 5 more** sends `exclude`, so a second press never repeats what is
  already on screen.

The page also prints the exact request it made, which makes it a quick way to
check a category before wiring anything up. It is served by the API itself
(`public/index.html`, static, no build step) so it can call it same-origin.

## The contract

### `GET /v1/messages`

| Param | Required | Default | Notes |
|---|---|---|---|
| `category` | yes | — | Card category slug, e.g. `birthday` |
| `subcategory` | no | — | Card subcategory slug, e.g. `friends` |
| `limit` | no | `5` | 1–25 |
| `exclude` | no | — | Comma-separated ids already on screen |

```json
{
  "category": "birthday",
  "subcategory": "friends",
  "resolved": {
    "topic": "birthday-friends",
    "label": "Birthday wishes for friends",
    "match": "exact",
    "source_url": "https://blog.123greetings.com/what-to-write-in-a-card/"
  },
  "count": 5,
  "messages": [
    {
      "id": "birthday-friends:709dd8e7",
      "text": "Happy birthday to the friend who makes ordinary days worth remembering.",
      "source_url": "https://blog.123greetings.com/what-to-write-in-a-card/"
    }
  ],
  "has_more": true,
  "wrapped": false
}
```

`text` is plain text, always — it goes straight into a `<textarea>`, so it
carries no markup or HTML entities.

### `GET /v1/categories`

Coverage map: which card categories have dedicated messages, and how many.
Use it to decide where writing more messages actually pays off.

### `GET /v1/health`

Source name, topic and message counts, last ingest timestamp.

### `GET /v1/topics/:id`

One topic with **every** message in it, rather than a sample. For checking what
an ingest actually produced.

### `GET /v1/search?q=`

Free-text search across every message; each hit says which topic it came from.
`limit` defaults to 100, max 500, and `truncated` says whether there were more.


## Two behaviours worth knowing

**The CTA never fails.** The card taxonomy is much larger than the message
coverage, so an unmatched card is normal, not an error. Resolution walks:

```
birthday/friends   ->  exact      dedicated messages for this subcategory
birthday/*         ->  category   general messages for this category
*                  ->  generic    messages that suit any card
```

`resolved.match` reports which rung it landed on, so the UI can be honest —
*"Birthday wishes for friends"* vs *"Wishes you can use for any card"* — without
ever showing the user an empty box. An unknown category returns 200, not 404.

**Pressing the CTA again shows something new.** Selection is random, not
paginated. Send the ids already on screen as `exclude` and they won't come back.
Once the pool is exhausted the response wraps to the full set with
`wrapped: true` rather than returning an empty list, because a button that
suddenly returns nothing reads as broken.

## Wiring up the CTA

```js
let seen = [];

async function getMessages({ category, subcategory }) {
  const params = new URLSearchParams({ category, limit: '5' });
  if (subcategory) params.set('subcategory', subcategory);
  if (seen.length) params.set('exclude', seen.join(','));

  const res = await fetch(`${API_BASE}/v1/messages?${params}`);
  const data = await res.json();

  seen = data.wrapped ? [] : [...seen, ...data.messages.map((m) => m.id)];
  return data;
}
```

Render `data.messages`; on tap, insert `message.text` into the message box.
Label the list from `data.resolved.label`.

## Getting real messages

Two ways to get them. Pick one.

**Without an ingest step** — the server reads the blog itself at startup:

```bash
npm run dev:live
```

Nothing else to run and no data file. The first boot takes a few seconds while
it crawls, after which requests are served from memory in single-digit
milliseconds, and it re-reads the blog every six hours. If the blog cannot be
reached it says so and uses the fixtures, so the API still answers.

**With an ingest step** — crawl once, write a store, serve that:

```bash
npm run probe                          # what does the blog expose?
npm run ingest -- --dry-run --verbose  # what would be extracted, without writing
npm run ingest -- --reset              # wipe the store and rebuild it
npm run dev
```

More to remember, but the messages are a file you can read, diff and roll back,
boot is instant, and a blog outage cannot affect a restart. Prefer this once
it is running somewhere real; `dev:live` is the shorter path while you are
still looking at what comes out.

Restart the API and it serves the store automatically — `/v1/health` will say
`"source": "store"` with the ingest timestamp.

Ingest runs on a schedule, never per request. A CTA that scrapes live is slow
enough to feel broken, breaks whenever the blog does, and turns every card
sender into traffic on the blog. Reading a local store is a few milliseconds and
stays up regardless.

```
client ──▶ this API ──▶ data/topics.json ◀── npm run ingest ◀── blog
```

### What gets crawled

By default ingest walks `/what-to-write-in-a-card/` and **everything beneath
it** — `/birthday/`, `/birthday/for-mom/`, `/anniversary/` and so on — following
links rather than asking an API. Whether those pages are WordPress posts, pages
or hand-built HTML is not knowable from outside, and the posts API only ever
sees one of the three.

Crawling stays inside the section: another host, a path above the section, and
assets are all skipped, and `/birthday` and `/birthday/` are the same page.

The path is also the taxonomy. `/what-to-write-in-a-card/birthday/for-mom/`
carries the segments `birthday` and `for-mom`, which is what the mapping rules
read — far steadier than guessing from a slug.

`--transport wp-json` switches to the REST API instead, falling back to the
feed. Use it if the section ever stops being crawlable; the summary always
prints which transport ran.

### Start with the probe

`npm run probe` reports what the host actually serves — `robots.txt`, whether
`wp-json` and the feed respond, every blog category with post counts, and the
tag structure of a sample post. Run it before the first ingest, and again if
extraction quality drops: a theme change shows up here first.

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Report what would be extracted, write nothing |
| `--verbose` | Also print a sample of the kept messages |
| `--reset` | Delete the store first, so nothing from a previous run survives |
| `--section <path>` | Crawl a different subtree, default `/what-to-write-in-a-card/` |
| `--transport wp-json` | Use the REST API instead of crawling |
| `--category <slug>` | With `--transport wp-json`, restrict to one blog category |
| `--limit <n>` | Stop after n pages |
| `--base <url>` | Point at a different host |
| `--out <path>` | Write somewhere other than `data/topics.json` |

### Reading the summary

```
transport   wp-json
posts       6
markup      list=3  paragraph=1  blockquote=1  linebreak=1
extracted   16 messages
kept        13 after dedupe

Topics (5):
      8  everyday             *
      6  birthday-friends     birthday/friends birthday/best_friend
      3  thank-you            thank_you/* thanks/*

1 post had messages but no card mapping:
  ten-tips-for-picking-a-card
  Add rules to src/ingest/rules.json to bring these in.
```

Three lines are worth acting on:

- **`markup`** — which HTML shape each post used. Posts do not agree on how to
  mark up a list of wishes, so every strategy runs and the one yielding the most
  usable messages wins. A sudden shift toward `none` means the theme changed.
- **posts that yielded no messages** — either not message posts, or markup
  `extract.ts` does not read yet.
- **posts with no card mapping** — real messages that no card category claims.
  This is the list that tells you which rules to write next.

Nothing is dropped silently; anything skipped is named.

### Extending coverage

`src/ingest/rules.json` maps posts onto card categories. First matching rule
wins, so specific rules come before general ones. `all` keywords must every one
appear in the post's slug, title or blog categories; `any` needs at least one.

```json
{
  "id": "birthday-friends",
  "label": "Birthday wishes for friends",
  "serves": ["birthday/friends", "birthday/best_friend"],
  "all": ["birthday"],
  "any": ["friend", "bestie"]
}
```

Widening coverage is a data edit, not a release.

If extraction picks up junk or misses real messages, the filters are in
`src/ingest/extract.ts` — `BOILERPLATE` for navigation and calls to action,
`rejectReason` for length, links, headings and enumeration.

### Sources

| `MESSAGE_SOURCE` | Behaviour |
|---|---|
| `auto` (default) | Ingested store if `data/topics.json` exists, else fixtures |
| `live` | Read the blog at startup, no store file (`npm run dev:live`) |
| `store` | Ingested store only; fails to boot if it is missing |
| `fixture` | Checked-in fixtures only |

`data/` is gitignored — regenerate it, do not commit it.

If ingest produces no topic serving `*`, the fixture fallback is kept and the
run says so. Without a global fallback the API cannot answer for an uncovered
card, which is precisely the case the CTA exists to handle.

## Layout

```
public/
  index.html         demo page for the CTA
  api.html           API explorer
  browse.html        message browser
src/
  app.ts             routes + validation
  taxonomy.ts        slug normalisation, fallback chain, stable message ids
  selection.ts       random pick, exclude, wrap-around
  types.ts           Message, Topic, MessageSource
  sources/
    fixture.ts       checked-in fallback messages
    store.ts         ingested messages
    live.ts          reads the blog at startup, no store file
    fixtures/        the fallback messages
  ingest/
    probe.ts         what does the blog expose?
    crawl.ts         walks the section URL tree
    fetchPosts.ts    wp-json, falling back to the feed
    extract.ts       post HTML -> individual messages
    mapping.ts       post -> card categories
    rules.json       the mapping, as data
    run.ts           the ingest CLI
  api.test.ts
  ingest/ingest.test.ts
```

Fixture copy is original placeholder text, not blog content. It exists so the
API answers before the first ingest, and as the global fallback if ingest does
not produce one.
