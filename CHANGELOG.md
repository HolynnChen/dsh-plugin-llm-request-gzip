# Changelog

Three-part versions. The panel's **检查更新** button compares the installed
`package.json` with the one on `main`, so an entry here is worth a release only when
something a user can see has changed.

## 1.7.0

- **HTTP/2, per provider, with a fallback that cannot be worse than not having it.**
  Node's `globalThis.fetch` speaks HTTP/1.1 only — its dispatcher is the built-in
  undici's own Agent, which never passes `allowH2`, and that Agent class is not
  reachable from application code — so the swap is made by driving dsh's own `undici`
  package: its `fetch` with its own `Agent({ allowH2: true })`. The two instances must
  never be crossed (an 8.x Agent with the built-in 7.x fetch fails with
  `invalid onRequestStart method`), which is the rule `lib/transport.js` enforces.
- It is **on by default for a route that pre-transmits**, because pre-transmission is
  what actually pays for it: it re-sends the same multi-kilobyte headers every step,
  and h2 sends only the delta, while the held pool shares one multiplexed connection.
  A route that does not pre-transmit has to ask. `http2: false` at the section level
  is a kill switch; `allowInsecureH2c` (default off) extends it to `http://` endpoints
  over a cleartext h2c connection.
- **Degradation is ALPN's, not a retry loop**: an endpoint that does not offer h2
  simply stays on http/1.1 through the same Agent, with no error. What is left is a
  transport that fails outright — one failure condemns that origin for the life of the
  plugin, so the cost is one extra round trip ever rather than one per request.
- **A fixed silent bug under h2.** undici hands HTTP/1.1 response headers over as a
  flat list but HTTP/2 ones as a plain object, and the reader only understood the
  list. Nothing failed loudly — the timing panel simply reported no `content-encoding`
  on every h2 reply, which looks like a gateway that does not compress. Both shapes
  are read now.
- The timing row reports the protocol that **actually carried** the response, which
  had to be learned rather than read off the response: undici's `Response` has no
  `httpVersion`, and its `client:connected` diagnostic announces `h2` *before* a
  cleartext upgrade is proven, so an attempt the far end refuses announces `h2` and
  then fails. The announced version is only recorded once the send has succeeded —
  a test pins exactly that, because the first draft got it wrong.
- **HTTP/3 is not offered, and cannot be on this stack**: undici contains no HTTP/3
  or QUIC code, and Node 24.12 ships neither `nghttp3` nor `ngtcp2`. A hand-built
  HTTP/3 transport would cost every undici diagnostic the timing view and the
  pre-transmission pool rest on.

## 1.6.1

- **The installer no longer produces an unparseable patch layer from a pristine
  profile.** A fresh `cordis.patch.yml` is comments followed by an empty array, and
  appending the loader entry after `[]` makes a document YAML rejects — it reads one
  document that is both an empty array and a block sequence, so the profile fails to
  compose. The installer now removes the empty array and puts the entry in its place,
  keeping the comments.
- `test/install.test.mjs` runs the installer twice against throwaway profiles from
  four starting states, which is what the fix is verified by.



- **The compression algorithm is chosen per provider, in the settings table**, instead
  of once for the whole plugin. Two routes behind one gateway can now differ — one
  pinned to gzip because that relay is known to dislike brotli, the other left on
  `auto`. The section-wide `encoding` remains as the default a route inherits until it
  sets its own, so existing `settings.yaml` files keep working unchanged.
- The Host already compiled a per-provider `encoding`; only the card did not offer it,
  which is why this is a UI change with a test that proves the two routes really do go
  out differently.



- The ledger row also reports **how many pre-transmitted requests the plugin is
  holding right now**. Those are the connections this plugin owns; anything beyond
  them belongs to undici's keep-alive pool or to the operating system, which is worth
  being able to tell apart when a network tool shows more sockets than the pool size
  suggests.


- **The settings card shows what the timing ledger occupies** — how many sessions it
  covers and how many bytes its stored documents make up — and offers a button to
  clear it. Clearing asks for confirmation first, then removes the stored documents
  (including sessions this process never loaded) and what the running process holds.
  It cannot be undone, and the card says so.
- The per-conversation cap on held requests now counts the pool it has just filed.
  It ran before that write, so the total settled one pool above the bound it claims.



A full read of every file, and the corrections it turned up. Most were documentation:
sentences describing mechanisms that had been removed, or describing current behaviour
backwards. Three of them were things a user reads.

- **The cache column's formula was stated wrongly in its tooltip.** It said the share
  is `cache reads ÷ input`, but `inputTokens` counts *uncached* input only, so that
  divides by too small a number. The divisor is cache reads plus uncached input. The
  README, the calculation and the panel now agree.
- **Two pre-transmission miss reasons were misleading.** One blamed "a gateway closing
  an idle connection" for a failure traced to a pool race; the other said the history
  changed "例如压缩", where 压缩 reads as either request-body compression or context
  compaction.
- **The settings schema's own description of `prewarmPoolSize`** said how many
  conversations may hold a request, which is the opposite of what it does — it is how
  many held requests one conversation keeps. This is the text the settings UI shows.
- Reading the sources removed dead code: a `dropPoolFor` with no caller, per-chunk
  bookkeeping left from the removed assistant-turn prediction, an unused constant, an
  unused threshold handler, and six style objects for markup that no longer exists.
- Two tests that named behaviour they no longer exercised were made to exercise it, and
  a third was renamed to what it actually checks.

## 1.3.2

- The compression switch's tooltip was still the size threshold's text, describing a
  control that is no longer in the card.
- The READMEs said a child agent's pool is kept or released according to queued input,
  which stopped being true when that check was removed.

## 1.3.1

- The size threshold is no longer offered in the card; it stays a schema field.
- The provider column leads the table, takes the slack, and the two switches sit at its
  right edge; the table spans the panel.
- The two switch headings are centred, with tooltips explaining what each switch does.

## 1.3.0

- The settings card reports, per endpoint, what real traffic has established: whether a
  compressed body was refused, whether pre-transmission was switched off, and how many
  compressions have failed in a row. Observations only — nothing is sent to produce it.

## 1.2.x

- **1.2.1** — README section on what the plugin cannot do (signed bodies, transports
  that bypass `fetch`, decoders that refuse an encoding), a guard that leaves an
  AWS-signed body alone, and `scripts/probe-encodings.mjs` to ask an endpoint which
  encodings it decodes before trusting it.
- **1.2.0** — Responses-shaped bodies (`input`) are supported alongside
  chat-completions and Anthropic ones (`messages`); a body whose conversation is not an
  array is reported as 不适用 rather than as an empty pool.

## 1.1.x

- **1.1.2** — opening the settings card checks for an update and says so.
- **1.1.1** — removed the dead assistant-turn prediction helpers and the text around
  them.
- **1.1.0** — a three-part version with an update button; the fixed fields are moved
  behind the conversation so the prefix can carry them; a turn boundary stops releasing
  the pool; a mismatch records where the bytes parted company.
