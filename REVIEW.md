# AF dare game: review and recommendations

Reviewed: `index.html` (2,361 lines) and `dares.json` (122 dares).
Prototype: `dare-engine.js` + `dare-lab.html` (in this folder).

## 1. Bugs in index.html

| # | Problem | Where | Effect |
|---|---------|-------|--------|
| 1 | **Deleting a built-in dare doesn't stick.** On load, the GitHub `dares.json` is merged with localStorage. Deleting a dare only removes it from localStorage, so the next reload brings it back. | `loadChallenges` ~L1015 | Deleted dares come back after a reload. Edited dares do stay changed (localStorage overrides by id). |
| 2 | **"+ Add participant" and participant "Edit" crash.** They open `#participantModal`, which isn't in the HTML. | L1069–1086 | You can't change players in the UI. Names/genders are hard-coded at L1041. |
| 3 | **"Will interact with" is never used.** Picking players (`selectNextParticipants`) only looks at gender and play count. The consent-aware, pair-fairness picker `selectParticipantsByGenderMix` exists but is never called. | L1866 vs L2119 | The `interactions` settings do nothing. |
| 4 | **Dead setup screens.** `showParticipants()`, the names screen, the details screen (gender radios and checkboxes) and `setIntensity()` are never reached, or their values are never read. | L1505, L823–849, L1809 | About 150 lines of code that does nothing; confusing to maintain. |
| 5 | **Ties always go to the first person in the list.** "Least used" is sorted with no random tie-break, so with even counts the first man in the list is always M1 and the first woman is always F1. | L1931, L1957 | Predictable picks; the same person keeps being the one who "does". |
| 6 | **M1/M2 and F1/F2 numbers don't mean anything.** A dare using only `<M2>` gets the least-used man, just like `<M1>`. | — | The "Secondary …" dares (11/13, 29/34, 31/32, 35/36, 53/54…) are near-duplicates. |
| 7 | **Stats use substring matching.** A player counts as "in" a dare if `dareText.includes(name)`. | L2259 | A name inside another word or name (e.g. "Em" in "Emma") is counted wrong. |
| 8 | **Import "fix" never runs.** It expects `F-M` style but the JSON uses `FM`. `genderMix` and `participantCount` are never used for selection at all. | L1425 | Bad metadata goes unnoticed (see #111 below). |
| 9 | **Images saved as base64 in localStorage.** Storage is capped at about 5 MB and `setItem` isn't in a try/catch. | L1037, L1597 | A couple of photos and every later save fails silently. |
| 10 | **No skip or veto.** Once names are shown, the only option is to do the dare. | game screen | See section 3. |
| 11 | **Timer is random 1/2/3 min** whatever the dare. | L1987 | A kiss can get 3 minutes and a full session 1 minute. |
| 12 | **Dare text is inserted as raw HTML** and names go into a regex unescaped. | L2335, L1158 | Mostly harmless with your own data, but `(` in a name breaks highlighting. |

## 2. Data issues in dares.json

- **#111** is tagged `FMM` but the text needs two women and one man (`<M1>`, `<F1>`, `<F2>`).
- **#93** has `requiresToy: true` but says "bound" without naming what it's bound with. Name the item (e.g. cuffs) so a toy filter can work.
- **`requiresToy` is a yes/no.** 32 dares need *something* (clamps, wand, crop, paddle, cuffs, wax, strap-on…), but the game can't skip the ones for gear you don't have. Props that aren't toys (blindfold, ice, oil, drinks, feather, scarves) and places (stairs, mirror, desk chair, kitchen island) aren't tracked at all.
- **Coverage is lopsided.** Clothed: 14 dares, all level 1. Underwear: 27 at level 2, but only 6 at level 3 and 1 at level 4. Naked: 25/32/17 at levels 3/4/5. The game only shows dares that *exactly* match the current clothing level, so once players are undressed the gentler dares are gone, and the underwear stage runs out fast.
- **Title and text are stuck together** ("Sensual Lip Lock: …"). Splitting them lets the game show a headline.
- **Who does what is unclear in a few:** #38 (who licks?) and #83 (who spanks whom?).
- **No dares for any gender other than man/woman.** A player marked "Other" is never picked.

## 3. Consent and safety (the most important upgrade)

For a game like this, the biggest improvement is making "no" easy and invisible:

1. **Per-player hard limits** (anal, penetration, restraint, spanking, same-sex, group…), set privately at setup. Dares that break a limit are simply never given to that player. Nobody has to refuse in front of the group.
2. **Mutual partner consent:** a pairing is only used if *both* people ticked each other. The current checkboxes only record one direction.
3. **A free "Pass" button** that doesn't count against anyone and quietly removes that dare for the night.
4. **Safety notes** on wax (low-temp only), restraints (keep safety shears nearby, nothing around the neck) and deepthroat-type dares, plus a reminder of the safeword whenever the level goes up.
5. **Privacy:** the page and `dares.json` are public on GitHub Pages with real first names hard-coded. Consider a private repo, removing the names (enter them at setup), and `<meta name="robots" content="noindex">`.

## 4. Better dare management (built in the prototype)

**A new dare format (v2).** Placeholders become role slots, and requirements become tags:

```json
{
  "id": "d29", "title": "Bare Clit Vibe Kiss",
  "text": "{A} applies the vibrator directly to {B}'s clitoris on the lowest setting while kissing her on the sofa.",
  "roles": { "A": "M", "B": "F" },
  "contacts": [["A", "B"]],
  "intensity": 2, "clothing": 2,
  "props": ["vibrator"], "places": ["sofa"],
  "tags": ["kissing"], "duration": 90
}
```

- `roles` can be `"any"`. Gender-neutral dares (neck kisses, spanking, massage) then work for any pairing, including "Other" players.
- `contacts` says who actually touches whom. This drives consent checks, so in "{A} or {C} kisses {B}" the two men aren't treated as touching each other.
- **Casting** tries every valid way to assign players to roles, given gender, limits and mutual consent. It scores each option on how often each person has played, each pair has played (counted double), and who "leads" vs "receives", then picks the fairest with a random tie-break. In a 40-dare simulation each of 4 players got 22–23 dares and every man–woman pair got 11–12.
- **Kit and rooms:** tick what you have tonight and dares needing anything else are skipped.
- **Clothing ≤ current** instead of "equals", preferring dares at the current clothing level.
- **Migration:** old-format files convert automatically (titles split, slots mapped, props/places/tags detected, data errors flagged). It's heuristic, so check `contacts` on group dares by hand.
- **Export for current game:** writes the old `<M1>/<F1>` format, so you can use the lab to curate and generate, then import into your existing game unchanged.

## 5. Generating dares

`dare-engine.js` contains a small grammar of **42 acts × 13 places × 13 twists**. Twists include blindfold, silence, eye contact, ice, feather, and adding a third player who watches, judges or joins in. That gives about **5,100 distinct, valid dares** across all five levels, e.g.:

> *On the edge of the dining table, {A} holds the vibrator on {B}'s bare clit, changing speed every 20 seconds, and meanwhile {C} holds {B}'s wrists.*

Rules stop combinations that don't make sense physically (no 69 against a wall, a standing lift only in a doorway/wall/counter, a third-player blowjob only during positions where it's possible). Generation only returns dares your kit supports and your current players can be cast in. The lab can mix generated dares into play live, so you never run out at a level.

**Why a grammar and not an AI model?** It works offline, is instant and free, and nobody's details leave the device. You also control exactly what can appear: every fragment is written and rated in advance, so a generated dare can't exceed its level or break a limit. An LLM call from a static page would need an API key exposed in public JavaScript, and its output would still need the same tagging to be safe to cast.

**To extend it,** add lines to `ACTS` or `TWISTS` (one line each). New acts automatically combine with every place and twist.

## 6. Suggested next steps (in order)

1. Fix bugs 1–3 (delete persistence, the missing participant modal, wiring in consent).
2. Add the Pass button and per-player limits.
3. Move the game onto `dare-engine.js` (replace `selectNextParticipants` with `DareEngine.nextDare`, `displayDare` with `DareEngine.render`) and switch `dares.json` to v2.
4. Use each dare's `duration` for the timer.
5. Fill the thin spots with generated dares (underwear levels 3–4), and remove or merge the near-duplicate "Secondary" dares.
