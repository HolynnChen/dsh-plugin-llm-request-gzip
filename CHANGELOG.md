# Changelog

Three-part versions. The panel's **检查更新** button compares the installed
`package.json` with the one on `main`, so an entry here is worth a release only when
something a user can see has changed.

## 1.5.1

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
