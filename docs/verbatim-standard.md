# Cited Conversations — Verbatim Standard

Version 1.0 · Established October 10, 2026 · Casey Cheshire

---

## The Standard

All answer pages on citedconversations.com follow this standard. The page builder enforces it at build time. Any commit that violates it will fail the build.

### 1. Default: Verbatim

The default for any answer excerpt is a verbatim copy from the Descript VTT export, word for word.

### 2. Edited Quote (allowed)

An edited quote may differ from the verbatim VTT only in these ways:

- **Filler removed:** ums, false starts, repeated words, stutters.
- **Removed passage:** shown as an ellipsis (`…`).
- **Added word:** shown in [square brackets]. Only permitted to complete an interrupted sentence or add a referent that makes the excerpt self-contained. Never used to introduce new meaning.

Edited quotes must not:
- Reorder sentences
- Merge two separate passages without an ellipsis between them
- Paraphrase any word inside quotation marks
- Include words from a different speaker

### 3. Synthesis (allowed, conditional)

A synthesis is an editor's summary that draws from multiple separate replies or passages. It is permitted only if:

- It is explicitly labeled **"Synthesis"** on the page.
- It is shown **alongside** (not instead of) the verbatim excerpts it summarizes.
- It does not appear inside quotation marks.

### 4. Build Check

The build fails if:

- Any quoted text contains more than 3 content words not present in the VTT for that speaker's time window.
- Any quoted text has words from the VTT that appear out of order (indicating reordering or sentence merging).

---

## Speaker Track Mapping

| Episode | VTT track prefix | Speaker |
|---|---|---|
| 001 | `Casey Cheshire:` (inline label) | Casey Cheshire |
| 001 | `Adam Needles:` (inline label) | Adam Needles |
| 002 | `casey_3_` | Casey Cheshire |
| 002 | `simon-wilhelm_` | Simon Wilhelm |
| 003 | `paul-jones_2_` | Paul Jones |
| 003 | `casey-cheshire_7_` | Casey Cheshire |

---

## Excluded Passages (Episode 002)

The following time ranges are excluded from all answer blocks by the speaker's request. The build check skips these windows. Any attempt to include content from these ranges will fail the build.

- Audi story: 29:43–30:32
- "AI, please delete" exchange: 35:15–35:55

---

## Transformation Labels

Use exactly these labels in answer blocks:

- `verbatim` — matches VTT word for word (minus filler)
- `edited` — meets the Edited Quote rules above
- `synthesis` — editor's summary, labeled and shown alongside verbatim excerpts

---

## FAQ for Editors

**Can I fix an obvious VTT transcription error (e.g., "RankScaile" → "RankScale")?**
Yes, but the correction must be in [brackets]: "Rank[Scale]". Document it in the page's editorial note if it changes meaning.

**Can I combine two answers to the same question if the speaker continued across a host prompt?**
Only as labeled synthesis. The host's prompts are never absorbed into the excerpt silently.

**Can I use the speaker's exact phrasing but rearrange for clarity?**
No. Any reordering requires synthesis label. There is no "light paraphrase" category.

**What counts as filler?**
Ums, uhs, false starts (word cut off mid-syllable), immediate word repetitions ("the the", "I I"), and isolated affirmative interjections within a sentence. Discourse markers that carry meaning ("actually", "right?", "honestly") are not filler and may not be removed without an ellipsis.

## Filler removal — detailed rule

The following may be dropped from quoted text without an ellipsis marker:
- **Named fillers:** um, uh, er, ah, hmm
- **Immediate repeats:** an identically repeated adjacent word (e.g. "the, the")
- **Descript false-start fragments:** a word ending in a hyphen as Descript transcribes it (e.g. "th-", "ar-", "f-") when the speaker restarts the same thought

Every other removal — including discourse markers ("right", "well", "exactly", "so", "yeah") — requires a visible ellipsis (…) at the point of the cut. Review false-start drops by hand: if the interrupted word changes the meaning, keep it.

Source transcripts (transcript.vtt, transcript.txt) are published exactly as exported from Descript, with track-ID labels replaced by real speaker names; no other edits.
