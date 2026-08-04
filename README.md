# message-board-api

Backs the **"Get Messages"** CTA on card-sending pages.

Today a user who doesn't know what to write leaves the card page, goes to
[What to Write in a Card](https://blog.123greetings.com/what-to-write-in-a-card/),
hunts for something, copies it, comes back and pastes. This API removes that
round trip: the message box's CTA sends the card's category and subcategory and
gets back 5 messages the user can insert with one tap.

**Status: Stage 0.** The contract is real and final; the messages come from a
checked-in fixture file rather than the blog. That is deliberate — clients can
integrate against the finished contract now, and swapping in real ingest later
changes nothing they can see. See [Stage 1](#stage-1--real-messages).

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

## Stage 1 — real messages

Everything above stays as it is. Only the source changes.

```
client ──▶ this API ──▶ store ◀── ingest job (scheduled) ◀── blog
```

Ingest on a schedule, not per request. A CTA that scrapes live is slow enough to
feel broken, breaks whenever the blog does, and turns every user into traffic on
the blog. Serving from a local store is a few milliseconds and stays up
regardless.

To add it, implement `MessageSource` (`src/types.ts`), register it in
`src/sources/index.ts`, and set `MESSAGE_SOURCE`. Routes, selection, resolution
and every client are untouched.

**First, find out how much parsing is actually needed.** If the blog is
WordPress, most of it may be free:

```bash
curl -s https://blog.123greetings.com/robots.txt
curl -s "https://blog.123greetings.com/wp-json/wp/v2/posts?per_page=1"
curl -s "https://blog.123greetings.com/wp-json/wp/v2/categories?per_page=100"
curl -s https://blog.123greetings.com/feed/
```

A working `wp-json` turns a brittle HTML scraper into a clean JSON read with
real category ids. Either way the ingest job's job is the same: pull each post
under *What to Write in a Card*, split it into individual messages, map it onto
the card categories it serves, and write it out in the shape of
`src/sources/fixtures/topics.json`.

The mapping from card taxonomy to topics is data, not code — extending coverage
means editing `serves` patterns, not shipping a release.

## Layout

```
public/
  index.html         demo page for the CTA
src/
  app.ts             routes + validation
  taxonomy.ts        slug normalisation, fallback chain, stable message ids
  selection.ts       random pick, exclude, wrap-around
  types.ts           Message, Topic, MessageSource
  sources/
    fixture.ts       Stage 0 source
    fixtures/        the messages
  api.test.ts
```

Fixture copy is original placeholder text, not blog content, and every entry
points at the section root. Stage 1 replaces both with real messages and their
per-post URLs.
