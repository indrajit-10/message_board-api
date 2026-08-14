# message-board-api

Backs the **"Get Messages"** CTA on card-sending pages.

Today a user who doesn't know what to write leaves the card page, goes to
[What to Write in a Card](https://blog.123greetings.com/what-to-write-in-a-card/),
hunts for something, copies it, comes back and pastes. This API removes that
round trip: the message box's CTA sends the card's category and subcategory and
gets back 5 messages the user can insert with one tap.

Every message comes from our own blog, written by a person. Nothing here
generates text, and the API refuses to serve the placeholder copy it ships with
— see [Placeholders are never served](#placeholders-are-never-served).

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

A fresh checkout has no messages yet. Fill in
[`src/ingest/manifest.json`](#the-manifest) and run `npm run ingest`.

## Pages

| URL | What it is |
|---|---|
| `/` | The CTA demo — the feature as a card sender sees it |
| `/api` | API explorer — every endpoint, testable on its own |
| `/browse` | Every message currently loaded, by topic, with search |

All three are static files served by the API itself, so they call it
same-origin with no build step.

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

When nothing covers the card, `resolved` is `null`, `messages` is empty, and
`unavailable_reason` says why. The app should hide the button.

### `GET /v1/categories`

Coverage map: which card categories have messages, and how many.

### `GET /v1/health`

Source name, topic and message counts, last ingest timestamp.

### `GET /v1/topics/:id`

One topic with **every** message in it, rather than a sample.

### `GET /v1/search?q=`

Free-text search across every message; each hit says which topic it came from.
`limit` defaults to 100, max 500, and `truncated` says whether there were more.

## Two behaviours worth knowing

**The CTA degrades, it doesn't fail.** The card taxonomy is much larger than the
message coverage, so an unmatched card is normal, not an error. Resolution
walks:

```
birthday/friends   ->  exact      dedicated messages for this subcategory
birthday/*         ->  category   general messages for this category
*                  ->  generic    messages that suit any card
```

`resolved.match` reports which rung it landed on, so the UI can be honest —
*"Birthday wishes for friends"* vs *"Wishes you can use for any card"*. An
unknown category returns 200, not 404.

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

  if (!data.resolved) return null;   // nothing covers this card; hide the button
  seen = data.wrapped ? [] : [...seen, ...data.messages.map((m) => m.id)];
  return data;
}
```

Render `data.messages`; on tap, insert `message.text` into the message box.
Label the list from `data.resolved.label`.

## The manifest

`src/ingest/manifest.json` is the whole configuration of what gets read. It
maps our own blog's pages onto card categories:

```json
{
  "base": "https://blog.123greetings.com",
  "defaults": {
    "selector": ".entry-content li, .entry-content blockquote",
    "minLength": 15,
    "maxLength": 400
  },
  "topics": [
    {
      "id": "birthday-friends",
      "label": "Birthday wishes for friends",
      "serves": ["birthday/friends", "birthday/best_friend"],
      "pages": [
        "/what-to-write-in-a-card/birthday/for-friends/",
        { "url": "/birthday-messages-for-friends/", "selector": ".msg-list li" }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `base` | The host. Every `pages` entry resolves against it, and a page on another host is refused |
| `defaults.selector` | CSS selector holding the messages, when a page doesn't override it |
| `defaults.minLength` / `maxLength` | Length window for a single message |
| `topics[].id` | Topic id, and the prefix of every message id it produces |
| `topics[].label` | What the UI calls this list |
| `topics[].serves` | Card patterns: `category/subcategory`, `category/*`, or `*` |
| `topics[].pages` | Blog pages to read. A path string, or `{ url, selector }` |
| `topics[].find` | Keywords used *only* by `npm run suggest`. Never read during ingest |

Several topics may list the same page — it is fetched once and feeds each of
them. A topic with no pages is allowed; it simply serves nothing until you add
some, and every run says which topics those are.

The manifest is validated on load. A `serves` pattern the taxonomy could never
match, a duplicate topic id, a cross-host URL and a backwards length window are
all rejected by name and line, rather than becoming a topic that silently
answers nothing.

### Why declared rather than discovered

This is our site, so the code doesn't guess at it. Earlier versions crawled the
section tree, read sitemaps, ran four extraction strategies and voted on the
winner, then matched posts to categories with 152 keywords. All of that existed
to answer "what does this website do?" — a question we can answer directly.

The practical difference is failure. Guessing degrades quietly: a theme change
drops the message count and nothing errors. Declaring fails loudly: the page is
named, the topic it fed is named, and the fix is a line in this file.

## Getting messages

**With an ingest step** — read the declared pages once, write a store, serve it:

```bash
npm run check      # read everything, report, write nothing
npm run ingest     # same, but write data/topics.json
npm run dev
```

The messages are then a file you can read, diff and roll back, boot is instant,
and a blog outage cannot affect a restart. Ingest runs on a schedule, never per
request — a CTA that scrapes live is slow enough to feel broken, breaks whenever
the blog does, and turns every card sender into traffic on the blog.

```
client ──▶ this API ──▶ data/topics.json ◀── npm run ingest ◀── blog
```

**Without an ingest step** — the server reads the pages itself at startup:

```bash
npm run dev:live
```

No data file, and it re-reads every six hours. Boot is slower and messages are
only as fresh as the last refresh. A request still never waits on the blog. If
the pages cannot be read it falls back to placeholders, `/v1/health` reports
`degraded: true`, and the API serves nothing.

### Filling in the manifest

`npm run suggest` reads the blog's sitemap and proposes URLs per topic, matching
the `find` keywords against each URL path:

```bash
npm run suggest             # print suggestions for topics with no pages yet
npm run suggest -- --write  # put them in the manifest
npm run suggest -- --all    # include topics that already have pages
```

Without `--write` it only prints. Keywords match whole words, so
`/birthday-wishes-for-grandmother/` does not answer for the `mom` topic, and the
shortest matching path sorts first — `/birthday-messages/` ahead of
`/birthday-messages-for-dad/` for the general topic.

**A matching URL is not proof the page holds card messages.** After `--write`,
always run `npm run check -- --verbose` and read what each page actually
produced before serving any of it.

If the host is unreachable from where you are running this — a locked-down CI
box, an egress policy — save the sitemap and pass it in instead:

```bash
npm run suggest -- --from ./sitemap_index.xml
```

`--from` takes a sitemap (index or urlset) or a plain list of URLs, one per
line, and repeats. A sitemap index only lists other sitemaps, so it reports
those and asks you to save them too rather than coming back empty:

```
These are sitemap indexes listing 6 more sitemap(s).
Save each of these and pass them too, with another --from:
  https://blog.123greetings.com/post-sitemap.xml
  https://blog.123greetings.com/page-sitemap.xml
```

### Flags

Both `ingest` and `check` take:

| Flag | Effect |
|---|---|
| `--dry-run` | Report what would be extracted, write nothing |
| `--strict` | Exit non-zero if any page did not extract cleanly. For CI |
| `--verbose` | Also print a sample of the kept messages |
| `--reset` | Delete the store first, so nothing from a previous run survives |
| `--topic <id>` | Only this topic, for iterating on one selector |
| `--base <url>` | Point every page at a different host, e.g. staging |
| `--manifest <path>` | Use a different manifest |
| `--out <path>` | Write somewhere other than `data/topics.json` |
| `--delay <ms>` | Gap between requests, default 250 |

`npm run check` is `--dry-run --strict`. Run it on a schedule: it is what turns
"the blog's markup moved" into a red build instead of a shrinking store.

### Reading the summary

```
pages       12 declared
            9 ok
            2 FALLBACK — declared selector found nothing
            1 UNREACHABLE
extracted   184 messages
kept        152 after dedupe
rejected    too_short=41  boilerplate=18

Topics (8 of 42 have messages):
     38  birthday-general       birthday/* *
     22  birthday-friends       birthday/friends birthday/best_friend

2 pages fell back to guessing the markup:
  https://blog.123greetings.com/birthday-messages/
      salvaged 14 via list, for birthday-general
  Fix: give these pages a "selector" in the manifest, or update defaults.selector.
```

Four things are worth acting on:

- **`FALLBACK`** — the declared selector matched nothing and the old guess-work
  salvaged the page. It still contributed messages, but the manifest is now
  wrong. This is the line that used to be invisible.
- **`UNREACHABLE`** — the page 404'd, timed out or returned non-HTML.
- **`EMPTY`** — read fine, no messages found. Either not a message page, or
  markup `extract.ts` does not read.
- **`rejected`** — what the filters threw away and why. `too_short` in the
  thousands means the length window is wrong for this site; `boilerplate` in the
  thousands means it is working.

Nothing is dropped silently; anything skipped is named, with the fix.

If extraction picks up junk or misses real messages, the filters are in
`src/ingest/extract.ts` — `BOILERPLATE` for navigation and calls to action,
`rejectReason` for length, links, headings and enumeration.

## Sources

| `MESSAGE_SOURCE` | Behaviour |
|---|---|
| `auto` (default) | Ingested store if it exists, else placeholders |
| `live` | Read the declared pages at startup, no store file (`npm run dev:live`) |
| `store` | Ingested store only; fails to boot if it is missing |
| `fixture` | Placeholders only |

`MESSAGE_STORE_PATH` overrides where the store is read from, for deploys that
mount it outside the repo. `data/` is gitignored — regenerate it, do not commit
it.

### Placeholders are never served

The repo ships a small set of placeholder messages so a fresh checkout boots and
the pages render. They are written by us, and the API will not hand them to a
user: they are loaded, marked `origin: "placeholder"`, and filtered out of every
read path — messages, search, categories and the topic view alike.

The whole value of this feature is that a person wrote the words, so a message
we wrote is worse than no message. `/v1/health` reports `placeholder_messages`
so a leak would be visible, and it should be `0` in production.

That is why a fresh checkout answers with an empty list until you have run an
ingest. It is working as intended.

## Layout

```
public/
  index.html         demo page for the CTA
  api.html           API explorer
  browse.html        message browser
src/
  index.ts           boot: pick a source, start the server
  core/              the domain, no HTTP and no network
    types.ts         Message, Topic, MessageSource
    taxonomy.ts      slug normalisation, the fallback chain, stable message ids
    selection.ts     random pick, exclude, wrap-around
    catalog.ts       one derived, indexed view of the loaded topics
  http/              the API surface
    createApp.ts     assembly
    context.ts       what routes are given
    params.ts        query parsing and validation
    respond.ts       errors and cache headers
    routes/          messages, catalog, search, health
  sources/           where topics come from
    fixture.ts       checked-in placeholders
    store.ts         ingested messages
    live.ts          reads the declared pages at startup, no store file
  ingest/
    manifest.json    which pages, for which topics — the whole configuration
    manifest.ts      load and validate it
    collect.ts       fetch exactly the declared pages
    fetch.ts         one polite GET
    extract.ts       page HTML -> individual messages
    build.ts         pages -> topics, plus what went wrong
    run.ts           the ingest CLI
    suggest.ts       propose URLs from the sitemap, for filling in the manifest
    sitemap.ts       what the site says it has (only used by suggest)
```

`core/` knows nothing about Express, and `http/` knows nothing about where
messages came from. `catalog.ts` is where placeholder filtering, message ids and
the search index are derived — once per load, not once per request.
