/* dare-engine.js — data model, migration, couple-aware casting, dare generation and a party picker.
 * No dependencies. Works in the browser (window.DareEngine) and in Node (require).
 *
 * Dare (v2):
 * {
 *   id, title, text,              // slots: {A} name, {A.spouse} their spouse's name,
 *                                 //        {A:they} {A:them} {A:their} gendered pronouns
 *   roles: { A: 'M'|'F'|'any', ... },
 *   everyone: false,              // true = all players, no slots
 *   contacts: [{ a:'A', b:'B', tags:[...], rel:'swap'|'spouse'|undefined }],
 *                                 // who touches whom, what they do, and whether that pair
 *                                 // must be (or must not be) a married couple
 *   intensity: 1-5, clothing: 1-3, props: [], places: [], tags: [], duration: seconds,
 *   source: 'deck' | 'generated'
 * }
 * Player: { name, gender: 'M'|'F'|'X', color, partners: [names], limits: [tags] }
 * Rules:  { spouseOf: { name: name }, swapLevel: 0-3 }
 *   swapLevel 0 = no swapping (watch only), 1 = kissing, 2 = soft swap (no penetration), 3 = full swap.
 *   Applies to contact between a man and a woman who aren't married to each other.
 *   Women together (or any same-gender pair) are governed only by mutual partner ticks.
 */
(function (root) {
  'use strict';

  // ---------- vocab ----------
  const PROPS = {
    vibrator: /\bvib(e|es|rator|rating)\b/i,
    wand: /\bwand\b/i,
    'nipple-clamps': /nipple clamps?/i,
    blindfold: /blindfold/i,
    ice: /\bice\b/i,
    oil: /\boil(ed)?\b/i,
    wax: /\bwax\b/i,
    crop: /\bcrop\b/i,
    paddle: /\bpaddle\b/i,
    cuffs: /\bcuffs\b/i,
    'silk-scarf': /\bscar(f|ves)\b/i,
    'strap-on': /strap-on/i,
    feather: /\bfeather\b/i,
    drink: /\b(drink|shot|sip)\b/i,
  };
  const TOY_PROPS = ['vibrator', 'wand', 'nipple-clamps', 'wax', 'crop', 'paddle', 'cuffs', 'strap-on'];

  const PLACES = {
    sofa: /\b(sofa|couch|sectional)\b/i,
    bed: /\bbed\b|headboard/i,
    armchair: /armchair|chair arms/i,
    'dining-table': /dining (table|chair)|\bthe table\b|table edge/i,
    kitchen: /kitchen|countertop|\bcounter\b|island/i,
    'coffee-table': /coffee table/i,
    ottoman: /ottoman/i,
    rug: /\brug\b|\bfloor\b/i,
    doorframe: /doorframe/i,
    wall: /\bwall\b/i,
    desk: /\bdesk\b/i,
    stairs: /stair/i,
    mirror: /mirror/i,
  };

  const TAGS = {
    kissing: /kiss/i,
    oral: /oral|lick|suck|eats? (her )?out|blowjob|\b69\b|cunnilingus|face sitting|sits on .{0,10}face|mouth over/i,
    hands: /strok|finger|handjob|massag|caress|trac|squeez|fondl|rub/i,
    penetration: /penetrat|fucks?\b|intercourse|thrust|riding|driving into|inserts/i,
    anal: /anus|anal/i,
    spanking: /spank|crop|paddle/i,
    restraint: /cuff|bound|\bties?\b|restrain|wrists/i,
    sensation: /\bice\b|wax|feather|breath/i,
    blindfold: /blindfold/i,
  };

  const SWAP_LEVELS = ['No swapping (watch only)', 'Kissing only', 'Soft swap (no penetration)', 'Full swap'];
  const KINDS = { spouse: 'Spouses', swap: 'Swap', girls: 'Girls', mmf: 'MMF', ffm: 'FFM', all: 'All four', trio: 'Trio' };

  // ---------- helpers ----------
  const uniq = (a) => [...new Set(a)];
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pairKey = (a, b) => [a, b].sort().join('|');
  const detect = (text, dict) => Object.keys(dict).filter((k) => dict[k].test(text));
  const defaultDuration = (lvl) => [60, 90, 120, 180, 300][Math.max(0, Math.min(4, lvl - 1))];
  const spouseSlots = (text) => uniq([...String(text).matchAll(/\{([A-D])\.spouse\}/g)].map((m) => m[1]));

  /** Accepts old [a, b] pairs or {a, b, tags, rel} objects. */
  function normContacts(d) {
    return (d.contacts || []).map((c) => (Array.isArray(c) ? { a: c[0], b: c[1], tags: c[2] || d.tags || [], rel: c[3] } : { tags: d.tags || [], ...c }));
  }

  function rulesFromCouples(couples, players) {
    const spouseOf = {};
    let swapLevel = 3;
    (couples || []).forEach((c) => {
      const [x, y] = c.members;
      if (!x || !y) return;
      spouseOf[x] = y; spouseOf[y] = x;
      swapLevel = Math.min(swapLevel, Number(c.swap));
    });
    if (!(couples || []).length) swapLevel = 3;
    return { spouseOf, swapLevel };
  }

  // ---------- migration from the original format ----------
  function migrateV1(c) {
    const raw = String(c.description || '');
    const colon = raw.indexOf(':');
    const title = colon > 0 && colon < 60 ? raw.slice(0, colon).trim() : '';
    let text = colon > 0 && colon < 60 ? raw.slice(colon + 1).trim() : raw.trim();

    const found = uniq((text.match(/<[FM][12]>/g) || []));
    const roles = {};
    const slotOf = {};
    found.forEach((ph, i) => { const k = 'ABCD'[i]; slotOf[ph] = k; roles[k] = ph[1]; });
    found.forEach((ph) => { text = text.split(ph).join('{' + slotOf[ph] + '}'); });

    const everyone = found.length === 0 && /all four|all players|all boundaries/i.test(text);
    const tags = detect(text, TAGS);
    const keys = Object.keys(roles);
    const onlyF = keys.length > 0 && keys.every((k) => roles[k] === 'F');
    // contacts (heuristic): mixed-gender pairs always; same-gender pairs only for
    // all-female dares or when one acts directly on the other. Men are never paired.
    const contacts = [];
    const VERB = '(?:kiss|lick|eat|use|rub|press|finger|strok|suck|touch)\\w*';
    const GAP = '(?:(?!\\{)[^.;]){0,40}?';
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (roles[a] !== roles[b]) { contacts.push({ a, b, tags: tags.slice() }); continue; }
      if (roles[a] === 'M') continue;
      const acts = (x, y) => new RegExp(`\\{${x}\\}${GAP}\\b${VERB}${GAP}\\{${y}\\}`).test(text);
      if (onlyF || acts(a, b) || acts(b, a)) contacts.push({ a, b, tags: tags.slice() });
    }
    if (contacts.some(({ a, b }) => roles[a] === 'F' && roles[b] === 'F')) tags.push('same-sex');
    if (keys.length >= 3 || everyone) tags.push('group');

    const props = detect(text, PROPS);
    const warnings = [];
    const mixFromText = keys.map((k) => roles[k]).sort().join('');
    const declared = String(c.genderMix || '').replace(/-/g, '').split('').sort().join('');
    if (!everyone && declared && declared !== mixFromText) warnings.push(`genderMix said ${c.genderMix}, text needs ${mixFromText}`);
    const toyish = props.some((p) => TOY_PROPS.includes(p));
    if (!!c.requiresToy !== toyish && !(c.requiresToy && props.length)) warnings.push(`requiresToy=${!!c.requiresToy} but detected props: ${props.join(', ') || 'none'}`);

    return {
      id: 'd' + c.id, title, text, roles, everyone, contacts,
      intensity: Number(c.intensity) || 1, clothing: Number(c.clothingLevel) || 1,
      props, places: detect(text, PLACES), tags: uniq(tags),
      duration: defaultDuration(Number(c.intensity) || 1), source: 'deck', warnings,
    };
  }

  function normalizeDeck(json) {
    if (!Array.isArray(json)) throw new Error('Expected an array of dares');
    return json.map((c) => {
      if (c.text !== undefined && c.roles) { const d = { warnings: [], ...c }; d.contacts = normContacts(d); return d; }
      return migrateV1(c);
    });
  }

  /** Can this dare be written in the original game's <M1>/<F1> format? */
  function v1Compatible(d) {
    return !spouseSlots(d.text).length && !normContacts(d).some((c) => c.rel);
  }

  function toV1(d, n) {
    const roles = { ...d.roles };
    const keys = Object.keys(roles);
    keys.forEach((k) => {
      if (roles[k] !== 'any') return;
      const others = keys.filter((x) => x !== k).map((x) => roles[x]);
      roles[k] = others.includes('M') && !others.includes('F') ? 'F' : others.includes('F') && !others.includes('M') ? 'M' : (others.filter((g) => g === 'F').length <= others.filter((g) => g === 'M').length ? 'F' : 'M');
    });
    const count = { M: 0, F: 0 };
    let text = d.text;
    keys.forEach((k) => {
      const g = roles[k]; count[g]++;
      text = pronouns(text, k, g).split('{' + k + '}').join(`<${g}${count[g]}>`);
    });
    return {
      id: n,
      description: (d.title ? d.title + ': ' : '') + text,
      intensity: d.intensity,
      participantCount: d.everyone ? 4 : keys.length,
      genderMix: d.everyone ? 'FFMM' : 'F'.repeat(count.F) + 'M'.repeat(count.M),
      image: null,
      requiresToy: d.props.some((p) => TOY_PROPS.includes(p)),
      clothingLevel: d.clothing,
    };
  }

  // ---------- consent, couples + casting ----------
  const canDo = (player, dare) => !(player.limits || []).some((t) => dare.tags.includes(t));
  const mutual = (a, b) => (a.partners || []).includes(b.name) && (b.partners || []).includes(a.name);
  const genderFits = (player, want) => want === 'any' || player.gender === want;

  /** Is this contact allowed between these two people under the couples' rules? */
  function relationOk(pa, pb, contact, rules) {
    if (!rules) return true;
    const married = rules.spouseOf[pa.name] === pb.name;
    if (contact.rel === 'swap' && married) return false;
    if (contact.rel === 'spouse' && !married) return false;
    if (married || pa.gender === pb.gender) return true;
    const lvl = rules.swapLevel;
    if (lvl <= 0) return false;
    if (lvl === 1) return contact.tags.every((t) => t === 'kissing' || t === 'group');
    if (lvl === 2) return !contact.tags.includes('penetration');
    return true;
  }

  function emptyStats() { return { plays: {}, pairs: {}, leads: {}, kinds: {} }; }

  /** All valid ways to cast a dare, best (fairest) first. Returns [] if impossible. */
  function castings(dare, players, stats, rules) {
    stats = stats || emptyStats();
    const contacts = normContacts(dare);
    if (dare.everyone) {
      if (!players.every((p) => canDo(p, dare))) return [];
      if (rules && rules.swapLevel < 3) {
        const pseudo = { tags: dare.tags };
        const m = players.find((p) => p.gender === 'M'), f = players.find((p) => p.gender === 'F' && rules.spouseOf[m && m.name] !== p.name);
        if (m && f && !relationOk(m, f, pseudo, rules)) return [];
      }
      return [{ cast: null, people: players.slice(), score: 0 }];
    }
    const keys = Object.keys(dare.roles);
    const needSpouse = spouseSlots(dare.text);
    const out = [];
    const walk = (i, used, cast) => {
      if (i === keys.length) {
        for (const c of contacts) {
          const pa = cast[c.a], pb = cast[c.b];
          if (!mutual(pa, pb) || !relationOk(pa, pb, c, rules)) return;
        }
        for (const k of needSpouse) {
          const sp = rules && rules.spouseOf[cast[k].name];
          if (!sp || used.has(sp) || !players.some((p) => p.name === sp)) return;
        }
        const people = keys.map((k) => cast[k]);
        let score = 0;
        people.forEach((p) => { score += stats.plays[p.name] || 0; });
        contacts.forEach((c) => { score += 2 * (stats.pairs[pairKey(cast[c.a].name, cast[c.b].name)] || 0); });
        score += 0.5 * (stats.leads[cast[keys[0]].name] || 0);
        out.push({ cast: { ...cast }, people, score: score + Math.random() * 0.9 });
        return;
      }
      const want = dare.roles[keys[i]];
      for (const p of players) {
        if (used.has(p.name) || !genderFits(p, want) || !canDo(p, dare)) continue;
        used.add(p.name); cast[keys[i]] = p;
        walk(i + 1, used, cast);
        used.delete(p.name); delete cast[keys[i]];
      }
    };
    walk(0, new Set(), {});
    return out.sort((x, y) => x.score - y.score);
  }

  function kindOf(dare, casting, rules) {
    if (dare.everyone || casting.people.length >= 4) return 'all';
    // classify by who actually touches; a watcher or caller doesn't make it a threesome
    const touching = uniq(normContacts(dare).flatMap((c) => [c.a, c.b])).map((k) => casting.cast[k]).filter(Boolean);
    const ppl = touching.length ? touching : casting.people;
    const m = ppl.filter((p) => p.gender === 'M').length, f = ppl.filter((p) => p.gender === 'F').length;
    if (ppl.length === 3) return m === 2 && f === 1 ? 'mmf' : f === 2 && m === 1 ? 'ffm' : 'trio';
    if (f === 2) return 'girls';
    if (ppl.length === 2 && rules && rules.spouseOf[ppl[0].name] === ppl[1].name) return 'spouse';
    return 'swap';
  }

  /** Spouses who should OK this dare before it's shown (anyone whose partner has cross-couple M/F contact). */
  function spouseCheck(dare, casting, rules) {
    if (!rules || !casting.cast) return dare.everyone && rules ? Object.keys(rules.spouseOf) : [];
    const who = [];
    normContacts(dare).forEach((c) => {
      const pa = casting.cast[c.a], pb = casting.cast[c.b];
      if (pa.gender !== pb.gender && rules.spouseOf[pa.name] !== pb.name) {
        [pa, pb].forEach((p) => { const s = rules.spouseOf[p.name]; if (s) who.push(s); });
      }
    });
    return uniq(who);
  }

  function recordPlay(stats, dare, casting, kind, sign = 1) {
    casting.people.forEach((p) => { stats.plays[p.name] = (stats.plays[p.name] || 0) + sign; });
    if (casting.cast) {
      normContacts(dare).forEach((c) => { const k = pairKey(casting.cast[c.a].name, casting.cast[c.b].name); stats.pairs[k] = (stats.pairs[k] || 0) + sign; });
      const lead = casting.cast[Object.keys(dare.roles)[0]];
      stats.leads[lead.name] = (stats.leads[lead.name] || 0) + sign;
    }
    if (kind) stats.kinds[kind] = (stats.kinds[kind] || 0) + sign;
  }
  const undoPlay = (stats, dare, casting, kind) => recordPlay(stats, dare, casting, kind, -1);

  function kitAllows(dare, kit) {
    if (!kit) return true;
    const props = new Set(kit.props || []), places = new Set(kit.places || []);
    return dare.props.every((p) => props.has(p)) && dare.places.every((p) => places.has(p));
  }

  function blocker(dare, players, kit, rules) {
    const missProps = dare.props.filter((p) => !(kit.props || []).includes(p));
    if (missProps.length) return 'needs ' + missProps.join(', ');
    const missPlaces = dare.places.filter((p) => !(kit.places || []).includes(p));
    if (missPlaces.length) return 'no ' + missPlaces.join(', ');
    if (!castings(dare, players, null, rules).length) return 'nobody can be cast (gender, partners, limits or swap level)';
    return '';
  }

  function nextDare(deck, players, opts) {
    const { intensity, clothing, used = new Set(), stats = emptyStats(), kit, rules } = opts;
    const pool = deck.filter((d) => d.intensity === intensity && d.clothing <= clothing && !used.has(d.id) && kitAllows(d, kit));
    const ranked = shuffle(pool).sort((a, b) => (b.clothing === clothing) - (a.clothing === clothing));
    for (const d of ranked) {
      const c = castings(d, players, stats, rules);
      if (c.length) return { dare: d, casting: c[0], kind: kindOf(d, c[0], rules) };
    }
    return null;
  }

  // ---------- rendering ----------
  const PRON = { F: { they: 'she', them: 'her', their: 'her' }, M: { they: 'he', them: 'him', their: 'his' }, X: { they: 'they', them: 'them', their: 'their' } };
  function pronouns(text, slot, gender) {
    const p = PRON[gender] || PRON.X;
    return text.replace(new RegExp(`\\{${slot}:(they|them|their)\\}`, 'g'), (_, w) => p[w]);
  }

  function render(dare, casting, html, rules) {
    let t = html ? esc(dare.text) : dare.text;
    const fmt = (p) => (html ? `<b style="color:${esc(p.color || '#0ff')}">${esc(p.name)}</b>` : p.name);
    if (casting && casting.cast) {
      Object.keys(casting.cast).forEach((k) => {
        const p = casting.cast[k];
        t = pronouns(t, k, p.gender);
        if (rules && rules.spouseOf[p.name]) {
          const sp = rules.players ? rules.players.find((x) => x.name === rules.spouseOf[p.name]) : null;
          t = t.split('{' + k + '.spouse}').join(sp ? fmt(sp) : esc(rules.spouseOf[p.name]));
        }
        t = t.split('{' + k + '}').join(fmt(p));
      });
    }
    return t;
  }

  // ---------- generator ----------
  // [id, title, text, roles, intensity, clothing, tags, props, extra]
  // extra: { contacts: [[a, b, tags, rel]], rel: 'swap'|'spouse' (main pair), noPlace, noTwist }
  // Two-role acts: {A} leads, {B} receives.
  // Hand-written scene dares. Each is a complete little moment with its own hook.
  // [id, title, text, roles, intensity, clothing, tags, props, extra]
  // extra: { contacts: [[a, b, tags, rel]], rel: 'swap'|'spouse', places: [...], secs }
  // {A} {B} {C} {D} names · {B.spouse} their spouse · {A:they}/{A:them}/{A:their} pronouns
  const C = (a, b, tags, rel) => [a, b, tags, rel];
  const ANY2 = { A: 'any', B: 'any' }, MF = { A: 'M', B: 'F' }, FM = { A: 'F', B: 'M' }, XF = { A: 'any', B: 'F' }, XM = { A: 'any', B: 'M' }, FF = { A: 'F', B: 'F' };
  const MMF = { A: 'M', B: 'F', C: 'M' }, FFM = { A: 'F', B: 'M', C: 'F' }, MFMF = { A: 'M', B: 'F', C: 'M', D: 'F' };
  const ACTS = [
    // ================= LEVEL 1 · Icebreaker (clothed, kissing, light touch) =================
    ['hotcold', 'Hot or Cold', '{B} closes {B:their} eyes. {A} hovers {A:their} lips a breath away from {B}\'s skin and drifts slowly around; {B} can only say "warmer" or "colder" until {A} finds the one spot {B} wants kissed. Then {A} kisses it properly.', ANY2, 1, 1, ['kissing'], []],
    ['statue', 'Statue', '{B} has to stay perfectly still for 60 seconds while {A} kisses {B}\'s neck, ears and lips. If {B} moves or makes a sound, the clock starts again.', ANY2, 1, 1, ['kissing'], [], { secs: 60 }],
    ['almost', 'Almost', '{A} and {B} bring their lips as close as they can without touching and hold it there for 30 seconds, breathing each other in. Then {B} decides whether it becomes a kiss.', ANY2, 1, 1, ['kissing'], [], { secs: 30 }],
    ['threesecrets', 'Three Secrets', '{A} whispers three things {A:they} would love to do to {B} later tonight. {B} picks one, and {A} gives a preview on {B}\'s neck.', ANY2, 1, 1, ['kissing'], []],
    ['melt', 'Melt', '{A} holds an ice cube in {A:their} mouth and traces it from {B}\'s ear down to the collarbone, then warms the same path back up with slow kisses.', ANY2, 1, 1, ['kissing', 'sensation'], ['ice']],
    ['pulse', 'Pulse Points', '{A} kisses the inside of {B}\'s wrist, then the inside of the elbow, then the side of the neck, slower at every stop, and finishes on {B}\'s lips.', ANY2, 1, 1, ['kissing'], []],
    ['guessspot', 'Guess the Spot', 'Blindfold {B}. {A} kisses {B} in three unexpected places; {B} has to name each one before getting a proper kiss on the lips.', ANY2, 1, 1, ['kissing', 'blindfold'], ['blindfold']],
    ['sharedsip', 'Shared Sip', '{A} takes a sip of a drink and kisses {B} so slowly that the drink passes from mouth to mouth.', ANY2, 1, 1, ['kissing'], ['drink']],
    ['noblink', 'Eyes Open', '{A} and {B} kiss with their eyes open, holding eye contact the whole time. Whoever looks away first owes the other a favour of their choosing later tonight.', ANY2, 1, 1, ['kissing'], []],
    ['undressme', 'Say It Slowly', 'Between slow kisses down {B}\'s neck, {A} whispers exactly how {A:they} would undress {B}, piece by piece. No touching the clothes yet.', ANY2, 1, 1, ['kissing'], []],
    ['claimed', 'Claimed', '{B} sits sideways across {A}\'s lap. {A} holds {B} by the hips and kisses {B:them} like there\'s nobody else in the room.', ANY2, 1, 1, ['kissing'], []],
    ['pinned', 'Pinned', '{A} holds {B}\'s wrists against the wall above {B:their} head and kisses {B} until {B:they} asks to be let go.', ANY2, 1, 1, ['kissing', 'restraint'], [], { places: ['wall'] }],
    ['bite', 'The Bite', '{A} kisses {B} deeply five times, ending each kiss with a slow tug on {B}\'s lower lip.', ANY2, 1, 1, ['kissing'], []],
    ['s-ask', 'Ask Nicely', '{A} has to ask {B.spouse}, out loud and in detail, for permission to kiss {B}. If {B.spouse} is convinced, {A} gets one long kiss; if not, {A} tries again with a better argument.', ANY2, 1, 1, ['kissing'], [], { rel: 'swap' }],
    ['s-count', 'Countdown', '{A} kisses {B} while {B.spouse} counts slowly down from 30 out loud. {B.spouse} may pause the count whenever they like.', ANY2, 1, 1, ['kissing'], [], { rel: 'swap', secs: 45 }],
    ['s-eyes', 'Look at Me', '{A} kisses {B}\'s neck while {B} keeps eye contact with {B.spouse} the whole time.', ANY2, 1, 1, ['kissing'], [], { rel: 'swap' }],
    ['g-show', 'Show Them', '{A} and {B} kiss slowly in front of their husbands, who have to keep their hands in their laps the whole time.', FF, 1, 1, ['kissing'], []],
    ['g-lipstick', 'Lipstick Trail', '{A} puts on lipstick and leaves a trail of kisses down {B}\'s neck and collarbone. {B.spouse} counts the marks, and {A} owes one more kiss for every mark {B.spouse} finds.', FF, 1, 1, ['kissing'], []],
    ['mmf-sandwich', 'Sandwich', '{B} stands between {A} and {C}. {A} kisses her lips while {C} kisses her neck from behind, and on her signal they switch.', MMF, 1, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['kissing'])] }],
    ['mmf-bothsides', 'Both Sides', '{B} sits between {A} and {C}. They each kiss one side of her neck at the same time, and she decides who gets her lips.', MMF, 1, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['kissing'])] }],
    ['ffm-threeway', 'Three-Way Kiss', '{A} and {C} kiss {B} at the same time, all three mouths together, for as long as the three of them can keep it going.', FFM, 1, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['kissing']), C('A', 'C', ['kissing'])] }],
    ['ffm-passiton', 'Pass It On', '{A} kisses {B} deeply, then {B} passes that same kiss on to {C}, and {C} brings it back to {A}. Three rounds, each slower than the last.', FFM, 1, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['kissing']), C('A', 'C', ['kissing'])] }],
    ['a-mirrorkiss', 'Mirror Kiss', 'Side by side on the sofa: {A} kisses {B} while {C} kisses {D}. The first pair to break apart takes a shot.', MFMF, 1, 1, ['kissing'], ['drink'], { contacts: [C('A', 'B', ['kissing'], 'swap'), C('C', 'D', ['kissing'], 'swap')] }],

    // ================= LEVEL 2 · Flirty (underwear/topless, touching through clothes, massage) =================
    ['onepiece', 'One Piece', '{A} chooses one item of {B}\'s clothing and takes it off slowly, kissing every bit of skin it uncovers.', ANY2, 2, 1, ['kissing'], []],
    ['slowsong', 'Slow Song', '{A} and {B} slow-dance to one whole song, pressed close together. {A}\'s hands may wander anywhere over {B}\'s clothes, but never under them.', ANY2, 2, 1, ['hands'], [], { secs: 210 }],
    ['tellwhere', 'Tell Me Where', '{B} takes {A}\'s hands and guides them over {B:their} clothes to the three places {B} most wants touched tonight. {A} lingers at each one.', ANY2, 2, 1, ['hands'], []],
    ['clothedlap', 'Lap Dance', '{A} gives {B} a slow, fully clothed lap dance. {B} has to keep both hands on the armrests; every time they come off, {A} takes a step back.', ANY2, 2, 1, ['hands'], []],
    ['undertop', 'Under the Top', '{A} slides both hands up under {B}\'s top and takes {A:their} time exploring, while kissing {B} slowly.', ANY2, 2, 1, ['hands', 'kissing'], []],
    ['bodymap', 'Body Map', '{B} lies back in underwear. {A} kisses a slow path from {B}\'s ankle, up the inside of the knee and thigh, and stops right at the underwear line. Then {A} starts again on the other leg.', ANY2, 2, 2, ['kissing'], []],
    ['slick', 'Slick', '{A} warms massage oil in {A:their} hands and works it into {B}\'s back, hips and the backs of {B:their} thighs, slipping under the edges of {B:their} underwear but never any further.', ANY2, 2, 2, ['hands'], ['oil']],
    ['countthem', 'Count Them', '{B} bends over the arm of the sofa in underwear. {A} gives five spanks, and {B} has to count each one out loud and say thank you. Miss a count and that one doesn\'t count.', ANY2, 2, 2, ['spanking'], []],
    ['nohandsbra', 'No Hands', '{A} takes {B}\'s bra off without using hands, then kisses and sucks each nipple until they\'re hard.', XF, 2, 2, ['oral'], []],
    ['dryrun', 'Dry Run', '{B} straddles {A} in underwear and grinds slowly to one song, hands on {A}\'s chest. Neither of you can touch below the waist.', ANY2, 2, 2, ['hands'], [], { secs: 210 }],
    ['featherlight', 'Feather Light', 'Blindfold {B}. {A} traces a feather or fingertips over {B}\'s body for one minute; then {B} names the spot that felt best, and {A} kisses it.', ANY2, 2, 2, ['sensation', 'kissing'], ['blindfold']],
    ['icepath', 'Ice Path', '{A} drags an ice cube from {B}\'s neck down over {B:their} stomach to the waistband and follows the trail of water with {A:their} tongue.', ANY2, 2, 2, ['sensation', 'kissing'], ['ice']],
    ['throughlace', 'Through the Lace', '{A} strokes {B} through {B:their} underwear with two fingers, so slowly that {B:they} has to beg for more pressure, and {A} only gives it when {B:they} says please.', ANY2, 2, 2, ['hands'], []],
    ['dialup', 'Turn It Up', '{A} runs the vibrator over {B}\'s underwear on the lowest setting. It only goes up a notch when {B:they} asks, and {B:they} has to ask nicely.', ANY2, 2, 2, ['hands'], ['vibrator']],
    ['navel', 'Body Shot', '{B} lies back. {A} pours a little drink into {B}\'s navel, drinks it, and then kisses all the way up to {B}\'s mouth.', ANY2, 2, 2, ['kissing'], ['drink']],
    ['chain', 'Tug', '{A} puts the nipple clamps on {B}, then kisses {B} deeply, giving the chain a tiny tug every time {B} moans.', ANY2, 2, 2, ['hands'], ['nipple-clamps']],
    ['watchyourself', 'Watch Yourself', '{A} stands behind {B} in front of the mirror and runs {A:their} hands slowly over {B}\'s body in underwear. {B} has to keep watching the whole time.', ANY2, 2, 2, ['hands'], [], { places: ['mirror'] }],
    ['s-remote', 'Remote Control', '{B.spouse} gives the instructions: where to kiss, where to touch and how slowly. {A} does exactly that to {B}, nothing more.', ANY2, 2, 2, ['kissing', 'hands'], [], { rel: 'swap' }],
    ['s-spot', 'Spouse Picks the Spot', '{B.spouse} points to one spot on {B}\'s body. {A} may only kiss there, and only for as long as {B.spouse} allows.', ANY2, 2, 2, ['kissing'], [], { rel: 'swap' }],
    ['s-difference', 'Spot the Difference', '{A} kisses {B}\'s neck and runs {A:their} hands over {B}\'s underwear for one minute. Afterwards {B} has to tell {B.spouse} one thing {A} does differently.', ANY2, 2, 2, ['kissing', 'hands'], [], { rel: 'swap', secs: 60 }],
    ['g-unwrapped', 'Unwrapped by Her', '{A} undresses {B} down to her underwear, kissing every bit of skin she uncovers.', FF, 2, 1, ['kissing'], []],
    ['g-slippery', 'Slippery', '{A} and {B} rub massage oil into each other\'s breasts and stomachs while their husbands watch, hands firmly to themselves.', FF, 2, 2, ['hands'], ['oil']],
    ['g-herturn', 'Her Song', '{A} gives {B} a lap dance in her underwear to a song {B.spouse} picks.', FF, 2, 2, ['hands'], []],
    ['mmf-fourhands', 'Four Hands', '{B} lies face down in her underwear while {A} and {C} massage her with oil: {A} from the shoulders down, {C} from the feet up, until their hands meet.', MMF, 2, 2, ['hands'], ['oil'], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands'])] }],
    ['mmf-hands', 'Two Pairs of Hands', '{A} kisses {B} deeply while {C} stands behind her and slides his hands up over her bare breasts.', MMF, 2, 2, ['kissing', 'hands'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['hands'])] }],
    ['ffm-unwrap', 'Unwrap Him', '{A} and {C} undress {B} down to his underwear together, kissing every bit of skin they uncover, and each other in between.', FFM, 2, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing']), C('C', 'B', ['kissing']), C('A', 'C', ['kissing'])] }],
    ['ffm-tagteam', 'Tag Team', '{A} and {C} take turns giving {B} a lap dance, and kiss each other at every handover.', FFM, 2, 2, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands']), C('A', 'C', ['kissing'])] }],
    ['a-swapdance', 'Swap Dance', 'Both couples slow-dance to one song with the other couple\'s partner: {A} with {B}, {C} with {D}. Hands can wander over clothes, but nobody kisses until the last chorus.', MFMF, 2, 1, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands', 'kissing'], 'swap'), C('C', 'D', ['hands', 'kissing'], 'swap')], secs: 210 }],
    ['a-race', 'Couple Race', 'Couples race: {A} gets {B} down to her underwear using only his teeth, and {C} does the same with {D}. The losing couple does whatever the winners choose next.', MFMF, 2, 1, ['kissing'], [], { contacts: [C('A', 'B', ['kissing'], 'spouse'), C('C', 'D', ['kissing'], 'spouse')] }],
    ['a-laps', 'Mirror Lap Dance', 'Side by side: {B} gives {A} a lap dance while {D} gives {C} one. The men keep their hands on the armrests, and the first man to touch loses.', MFMF, 2, 2, ['hands'], [], { contacts: [C('B', 'A', ['hands'], 'swap'), C('D', 'C', ['hands'], 'swap')] }],

    // ================= LEVEL 3 · Foreplay (hands and toys on bare skin, kink) =================
    ['handinside', 'Hand Inside', '{A} slides one hand inside {B}\'s underwear and teases slowly while kissing {B}. The underwear stays on the whole time.', ANY2, 3, 2, ['hands', 'kissing'], []],
    ['fullbuzz', 'Full Buzz', '{A} holds the vibrator against {B} through {B:their} underwear and turns it up one notch every 20 seconds until {B} squirms.', ANY2, 3, 2, ['hands'], ['vibrator']],
    ['hotbreath', 'Hot Breath', '{A} kisses and breathes hot air over {B}\'s underwear, slowly and teasingly, but never pulls it aside.', ANY2, 3, 2, ['kissing', 'oral'], []],
    ['blindhands', 'Blind Hands', 'Blindfold {A}. {A} has to find {B} and undress {B:them} by touch alone, then use {A:their} hands on {B} until {B:they} says stop.', ANY2, 3, 2, ['hands'], ['blindfold']],
    ['edge3', 'Three Times', '{A} uses {A:their} hand on {B} and brings {B} right to the edge three times, stopping completely every time {B:they} gets close.', ANY2, 3, 3, ['hands'], []],
    ['showme', 'Show Me', '{B} takes {A}\'s hand and shows {A} exactly how {B:they} likes to be touched. Then {B:they} lets go, and {A} has to copy it perfectly.', ANY2, 3, 3, ['hands'], []],
    ['showtell', 'Show and Tell', '{B} touches {B:them}self while {A} watches from close up and isn\'t allowed to touch. After one minute {A} takes over and has to pick up exactly where {B} left off.', ANY2, 3, 3, ['hands'], [], { secs: 120 }],
    ['eyecontactvibe', 'Don\'t Look Away', '{A} holds the vibrator on {B} and turns it up every 20 seconds. {B} has to keep eye contact; if {B:they} looks away, it goes back down to the lowest setting.', ANY2, 3, 3, ['hands'], ['vibrator']],
    ['steadyhand', 'Steady Hand', '{B} holds a full drink while {A} presses the wand against {B}\'s clit. If she spills a drop, the wand comes off for ten seconds.', XF, 3, 3, ['hands'], ['wand', 'drink']],
    ['fireice', 'Fire and Ice', '{A} alternates an ice cube and {A:their} warm mouth down {B}\'s chest and stomach, stops just short, and finishes with {A:their} hand.', ANY2, 3, 3, ['sensation', 'hands', 'kissing'], ['ice']],
    ['drip', 'Drip', '{B} lies face down. {A} drips warm massage wax from a height onto {B}\'s back and the backs of {B:their} thighs, then rubs it in with slow, firm hands.', ANY2, 3, 3, ['sensation', 'hands'], ['wax']],
    ['ten', 'Ten', '{B} bends over the bed naked. {A} gives ten strokes of the crop, alternating soft and hard, and soothes each one with a warm hand.', ANY2, 3, 3, ['spanking'], ['crop']],
    ['paddle', 'Paddle & Kiss', '{A} gives {B} one paddle stroke, then one kiss wherever {B} chooses, back and forth ten times.', ANY2, 3, 3, ['spanking', 'kissing'], ['paddle']],
    ['stillhips', 'Don\'t Move', '{A} strokes {B}\'s cock slowly with oil. {B} isn\'t allowed to move his hips; if he does, {A} stops and starts again from the beginning.', XM, 3, 3, ['hands'], ['oil']],
    ['more', 'Say More', '{A} slides two fingers inside {B} and curls them slowly, watching her face. {A} only changes the pace when {B} says "more".', XF, 3, 3, ['hands'], []],
    ['between', 'Between', '{B} oils up her breasts and {A} slides his cock between them while she holds them together and looks up at him.', { A: 'M', B: 'F' }, 3, 3, ['hands'], ['oil']],
    ['tied3', 'Everywhere But There', '{A} ties {B}\'s wrists with a silk scarf, then touches {B} everywhere except where {B:they} wants it most, until {B:they} asks for it out loud.', ANY2, 3, 3, ['hands', 'restraint'], ['silk-scarf']],
    ['s-coach', 'Coach', '{B.spouse} sits right beside {B} and coaches {A} on exactly how to touch {B}: faster, slower, there.', ANY2, 3, 3, ['hands'], [], { rel: 'swap' }],
    ['s-holdhand', 'Hold My Hand', '{A} fingers {B} while {B} holds {B.spouse}\'s hand and keeps looking at {B.spouse} the whole time.', MF, 3, 3, ['hands'], [], { rel: 'swap' }],
    ['g-sharedbuzz', 'Shared Buzz', '{A} and {B} lie face to face and hold one vibrator between them, pressed against both, while they kiss.', FF, 3, 3, ['hands', 'kissing'], ['vibrator']],
    ['g-grind', 'Grind Together', '{A} and {B} grind their bare pussies together while their husbands watch from the end of the bed.', FF, 3, 3, ['hands'], []],
    ['g-fingers', 'Show Him', '{A} fingers {B} slowly while {B.spouse} watches from close up and tells {A} when to go faster.', FF, 3, 3, ['hands'], []],
    ['mmf-guess', 'Guess Whose Hand', 'Blindfold {B}. {A} and {C} take turns touching her between the legs, and she has to guess whose hand it is each time. Every right guess earns her a kiss from both.', MMF, 3, 3, ['hands'], ['blindfold'], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands'])] }],
    ['mmf-attention', 'Double Attention', '{A} fingers {B} while {C} kisses her and plays with her nipples.', MMF, 3, 3, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['kissing', 'hands'])] }],
    ['mmf-handsfull', 'Both Hands Full', '{B} strokes {A} and {C} at the same time, one in each hand, and has to keep the same rhythm on both.', MMF, 3, 3, ['hands'], [], { contacts: [C('B', 'A', ['hands']), C('B', 'C', ['hands'])] }],
    ['mmf-inside', 'His Hand, His Mouth', '{A} slips a hand inside {B}\'s underwear while {C} kisses her neck and breasts.', MMF, 3, 2, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['kissing'])] }],
    ['ffm-race', 'Stroke Race', '{A} and {C} take turns stroking {B} for 30 seconds each. Whoever is stroking when he begs them to stop wins a favour from the other.', FFM, 3, 3, ['hands'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands'])] }],
    ['ffm-shared', 'Shared', '{A} and {C} stroke {B} together, four hands on him, while they kiss each other.', FFM, 3, 3, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands']), C('A', 'C', ['kissing'])] }],
    ['ffm-inside', 'Both Hands In', '{A} and {C} each slip a hand inside {B}\'s underwear while kissing each other.', FFM, 3, 2, ['hands', 'kissing'], [], { contacts: [C('A', 'B', ['hands']), C('C', 'B', ['hands']), C('A', 'C', ['kissing'])] }],
    ['a-copy', 'Copy Her', 'Side by side: {B} strokes {A} while {D} strokes {C}. The women have to match each other\'s rhythm exactly, and the men can call out "faster" only once each.', MFMF, 3, 3, ['hands'], [], { contacts: [C('B', 'A', ['hands'], 'swap'), C('D', 'C', ['hands'], 'swap')] }],
    ['a-handinhand', 'Hand in Hand', 'Side by side on the bed: {A} fingers {B} while {C} fingers {D}, and the women hold hands the whole time.', MFMF, 3, 3, ['hands'], [], { contacts: [C('A', 'B', ['hands'], 'swap'), C('C', 'D', ['hands'], 'swap'), C('B', 'D', ['hands'])] }],

    // ================= LEVEL 4 · Intimate (oral, toys inside, edging) =================
    ['tasting', 'Tasting Menu', '{A} goes down on {B} with three different moves for 30 seconds each: slow licks, quick flicks and deep kisses. {B} picks the winner, and {A} does that one until the timer runs out.', ANY2, 4, 3, ['oral'], [], { secs: 180 }],
    ['nohandsoral', 'Hands Behind Your Back', '{A} goes down on {B} with {A:their} hands clasped behind {A:their} back, while {B} sets the pace with a hand in {A}\'s hair.', ANY2, 4, 3, ['oral'], []],
    ['notyet4', 'Not Yet', '{A} goes down on {B} and stops completely every time {B:they} gets close. After three stops, {B:they} decides whether to finish now or save it for later.', ANY2, 4, 3, ['oral'], []],
    ['blindtaste', 'Blind Taste', 'Blindfold {B}. {A} switches between {A:their} tongue, fingers and an ice cube on {B}, and {B} has to guess which is which. Every wrong guess means another ten seconds of {A}\'s tongue.', ANY2, 4, 3, ['oral', 'hands', 'sensation'], ['blindfold', 'ice']],
    ['coldhot', 'Cold & Hot', '{A} holds ice in {A:their} mouth until it\'s cold, then takes {B}\'s cock deep and lets it warm up slowly.', XM, 4, 3, ['oral'], ['ice']],
    ['kneel', 'Kneel', '{B} stands against the wall while {A} kneels and goes down on {B:them}, hands on {B:their} hips, eyes up the whole time.', ANY2, 4, 3, ['oral'], [], { places: ['wall'] }],
    ['throne', 'Throne', '{B} sits on {A}\'s face and sets the pace. {A}\'s hands stay on {B}\'s hips and only move when {B} moves them.', XF, 4, 3, ['oral'], []],
    ['sixtynine', 'Sixty-Nine', '{A} and {B} go down on each other in a 69. Whoever makes the other stop to catch their breath first wins.', ANY2, 4, 3, ['oral'], []],
    ['tiponly', 'Tip Only', '{A} licks only the head of {B}\'s cock, slowly and wetly, and isn\'t allowed any deeper until {B:they} begs.', XM, 4, 3, ['oral'], []],
    ['buzzinside', 'Fill Up', '{A} slides the vibrator inside {B} and works it slowly while kissing {B:them} deeply.', XF, 4, 3, ['penetration'], ['vibrator']],
    ['tonguebuzz', 'Tongue & Buzz', '{A} goes down on {B} while holding the vibrator on her clit, and only stops when her legs start shaking.', XF, 4, 3, ['oral'], ['vibrator']],
    ['tiptease', 'Tip Tease', '{A} rubs the tip of his cock up and down {B}, teasing her clit, but isn\'t allowed to slip inside however much she asks.', MF, 4, 3, ['hands'], []],
    ['tiedtease', 'Tied & Teased', '{A} ties {B}\'s wrists to the headboard with a silk scarf, then gives {B:them} a slow blowjob that {B} can\'t do anything about.', { A: 'any', B: 'M' }, 4, 3, ['oral', 'restraint'], ['silk-scarf']],
    ['backdoor', 'All of Her', '{A} licks {B}\'s pussy and then her ass while she bends forward over the sofa arm, moving back and forth as she asks.', XF, 4, 3, ['oral', 'anal'], []],
    ['s-time', 'On the Clock', '{A} goes down on {B}. {B.spouse} decides how long and calls time, and can add extra time whenever they like.', ANY2, 4, 3, ['oral'], [], { rel: 'swap' }],
    ['s-direct', 'Directed', '{B} gives {A} a blowjob while {B.spouse} watches and gives every instruction: deeper, slower, use your hand.', FM, 4, 3, ['oral'], [], { rel: 'swap' }],
    ['s-ringside', 'Ringside', '{A} goes down on {B} while {B} holds {B.spouse}\'s hand and describes out loud exactly how it feels.', ANY2, 4, 3, ['oral'], [], { rel: 'swap' }],
    ['g-coached', 'Coached', '{A} goes down on {B} while {B.spouse} tells {A} exactly what {B} likes.', FF, 4, 3, ['oral'], []],
    ['g-lesson', 'The Lesson', '{A} goes down on {B} while both husbands watch closely. Afterwards each husband has to show his own wife what he learned.', FF, 4, 3, ['oral'], []],
    ['g-69', 'Her Turn, Her Turn', '{A} and {B} go down on each other in a 69 while their husbands watch from the end of the bed.', FF, 4, 3, ['oral'], []],
    ['mmf-giveandtake', 'Give & Take', '{B} goes down on {A} while {C} goes down on her. She can only use her hands to tell {C} what she wants.', MMF, 4, 3, ['oral'], [], { contacts: [C('B', 'A', ['oral']), C('C', 'B', ['oral'])] }],
    ['mmf-turns', 'Taking Turns', '{B} kneels between {A} and {C} and switches her mouth from one to the other every 30 seconds, using her hand on whoever is waiting.', MMF, 4, 3, ['oral', 'hands'], [], { contacts: [C('B', 'A', ['oral', 'hands']), C('B', 'C', ['oral', 'hands'])] }],
    ['mmf-doubletease', 'Double Tease', '{A} goes down on {B} while {C} kisses her and plays with her nipples. She can only kiss {C} back when {A} gets it exactly right.', MMF, 4, 3, ['oral', 'kissing', 'hands'], [], { contacts: [C('A', 'B', ['oral']), C('C', 'B', ['kissing', 'hands'])] }],
    ['ffm-relay', 'Relay', '{A} and {C} take turns going down on {B}, switching every 20 seconds and kissing each other at every handover.', FFM, 4, 3, ['oral', 'kissing'], [], { contacts: [C('A', 'B', ['oral']), C('C', 'B', ['oral']), C('A', 'C', ['kissing'])] }],
    ['ffm-faceandmouth', 'Face & Mouth', '{A} sits on {B}\'s face while {C} goes down on him, and the two women kiss over him.', FFM, 4, 3, ['oral', 'kissing'], [], { contacts: [C('A', 'B', ['oral']), C('C', 'B', ['oral']), C('A', 'C', ['kissing'])] }],
    ['a-swapback', 'Swap Back', 'Side by side on the bed: {B} goes down on {A} while {D} goes down on {C}. Halfway through, the women swap back to their own husbands.', MFMF, 4, 3, ['oral'], [], { contacts: [C('B', 'A', ['oral'], 'swap'), C('D', 'C', ['oral'], 'swap'), C('B', 'C', ['oral'], 'spouse'), C('D', 'A', ['oral'], 'spouse')] }],
    ['a-daisy', 'Daisy Chain', 'Daisy chain on the bed: {A} goes down on {B}, {B} on {C}, {C} on {D} and {D} on {A}. Nobody stops until everyone has been asked "more?"', MFMF, 4, 3, ['oral'], [], { contacts: [C('A', 'B', ['oral']), C('B', 'C', ['oral']), C('C', 'D', ['oral']), C('D', 'A', ['oral'])] }],

    // ================= LEVEL 5 · Full on (intercourse) =================
    ['slowmo', 'Slow Motion', '{A} fucks {B} in slow motion, one stroke every three seconds for a full minute. After that, {B} sets the speed for the rest.', MF, 5, 3, ['penetration'], [], { secs: 240 }],
    ['threepositions', 'Three Positions', '{A} and {B} have sex in three positions for one minute each. {B} picks them, and they finish in the last one.', MF, 5, 3, ['penetration'], [], { secs: 240 }],
    ['handsup', 'Hands Up', '{B} rides {A} while holding his wrists above his head. He only gets his hands back when she places them where she wants them.', MF, 5, 3, ['penetration', 'restraint'], []],
    ['reflection', 'Reflection', 'In front of the mirror, {A} takes {B} from behind while she watches herself, and he has to hold her eyes in the reflection the whole time.', MF, 5, 3, ['penetration'], [], { places: ['mirror'] }],
    ['notyet5', 'Not Yet', '{A} fucks {B}, but has to stop and pull out every time she says "not yet". She decides when it\'s finally allowed.', MF, 5, 3, ['penetration'], []],
    ['cuffed', 'Cuffed', '{A} cuffs {B}\'s wrists behind her back, spanks her twice, then takes her from behind.', MF, 5, 3, ['penetration', 'restraint', 'spanking'], ['cuffs']],
    ['counter', 'Counter Top', '{A} lifts {B} onto the kitchen counter and she wraps her legs around him. He fucks her slowly and doesn\'t stop kissing her.', MF, 5, 3, ['penetration', 'kissing'], [], { places: ['kitchen'] }],
    ['blindride', 'Blind Ride', 'Blindfold {A}. {B} climbs on and rides him, changing pace without warning. He can\'t touch her until she places his hands.', MF, 5, 3, ['penetration'], ['blindfold']],
    ['plusone', 'Plus One', '{A} fucks {B} while she holds the vibrator on her clit, and he isn\'t allowed to come before she does.', MF, 5, 3, ['penetration'], ['vibrator']],
    ['stairs5', 'The Stairs', '{B} kneels on the stairs, leaning forward, while {A} takes her from behind, one hand on her hip and one in her hair.', MF, 5, 3, ['penetration'], [], { places: ['stairs'] }],
    ['s-position', 'Spouse\'s Choice', '{A} fucks {B} while {B.spouse} watches from close by and chooses every position change.', MF, 5, 3, ['penetration'], [], { rel: 'swap' }],
    ['s-frontrow', 'Front Row', '{A} fucks {B} while {B.spouse} sits close enough to kiss {B}, and does so whenever they like.', MF, 5, 3, ['penetration'], [], { rel: 'swap' }],
    ['s-pace', 'Spouse Sets the Pace', '{A} fucks {B} while {B.spouse} claps out the rhythm, and {A} has to match it exactly, however slow or fast it goes.', MF, 5, 3, ['penetration'], [], { rel: 'swap' }],
    ['mmf-bothends', 'Both Ends', '{A} takes {B} from behind while she goes down on {C}, and the men aren\'t allowed to rush her.', MMF, 5, 3, ['penetration', 'oral'], [], { contacts: [C('A', 'B', ['penetration']), C('B', 'C', ['oral'])] }],
    ['mmf-ridereach', 'Ride & Reach', '{B} rides {A} while stroking and kissing {C}, never breaking the kiss.', MMF, 5, 3, ['penetration', 'hands', 'kissing'], [], { contacts: [C('A', 'B', ['penetration']), C('B', 'C', ['hands', 'kissing'])] }],
    ['mmf-herrules', 'Her Rules', '{A} and {C} take turns fucking {B}, switching every minute, and she decides who finishes.', MMF, 5, 3, ['penetration'], [], { contacts: [C('A', 'B', ['penetration']), C('C', 'B', ['penetration'])] }],
    ['ffm-ridesit', 'Ride & Sit', '{A} rides {B} while {C} sits on his face, and the two women kiss each other over him.', FFM, 5, 3, ['penetration', 'oral', 'kissing'], [], { contacts: [C('A', 'B', ['penetration']), C('C', 'B', ['oral']), C('A', 'C', ['kissing'])] }],
    ['ffm-turns', 'Two Minutes Each', '{A} and {C} take turns riding {B}, two minutes each, while whoever is waiting kisses and touches whoever is riding.', FFM, 5, 3, ['penetration', 'kissing', 'hands'], [], { contacts: [C('A', 'B', ['penetration']), C('C', 'B', ['penetration']), C('A', 'C', ['kissing', 'hands'])] }],
    ['ffm-watchher', 'While She Watches', '{B} fucks {A} while {A} goes down on {C}.', FFM, 5, 3, ['penetration', 'oral'], [], { contacts: [C('B', 'A', ['penetration']), C('A', 'C', ['oral'])] }],
    ['a-switch', 'Switch!', 'Side by side: {A} fucks {B} while {C} fucks {D}. Whenever either woman says "switch", both pairs swap partners.', MFMF, 5, 3, ['penetration'], [], { contacts: [C('A', 'B', ['penetration'], 'swap'), C('C', 'D', ['penetration'], 'swap'), C('A', 'D', ['penetration'], 'spouse'), C('C', 'B', ['penetration'], 'spouse')] }],
    ['a-holdhands', 'Across the Bed', 'Both couples have sex side by side, {A} with {B} and {C} with {D}, and the women hold hands across the gap. The first woman to let go picks the next dare.', MFMF, 5, 3, ['penetration'], [], { contacts: [C('A', 'B', ['penetration']), C('C', 'D', ['penetration']), C('B', 'D', ['hands'])] }],
  ].map(([id, title, text, roles, intensity, clothing, tags, props, extra = {}]) => ({ id, title, text, roles, intensity, clothing, tags, props, noTwist: true, noPlace: true, ...extra }));

  const GEN_PLACES = [
    ['sofa', 'On the sofa'], ['bed', 'On the bed'], ['armchair', 'In the armchair'],
    ['kitchen', 'At the kitchen counter'], ['dining-table', 'On the edge of the dining table'],
    ['rug', 'Down on the rug'], ['wall', 'Up against the wall'], ['doorframe', 'In a doorway'],
    ['mirror', 'In front of a mirror'], ['stairs', 'On the stairs'], ['desk', 'On the desk chair'],
    ['ottoman', 'On the ottoman'], ['coffee-table', 'Over the coffee table'],
    [null, ''],
  ].map(([id, phrase]) => ({ id, phrase }));

  // Twists only apply to two-role acts.
  const TWISTS = [
    { id: 'none', text: '' },
    { id: 'blind', text: 'while {B} is blindfolded and has to guess what is coming next', props: ['blindfold'], tags: ['blindfold'] },
    { id: 'eyes', text: 'and {B} must keep eye contact the whole time' },
    { id: 'silent', text: 'and {B} is not allowed to make a sound' },
    { id: 'beg', text: 'and only stops when {B} asks nicely' },
    { id: 'nohands', text: 'and {B} has to keep both hands behind {B:their} back', tags: ['restraint'] },
    { id: 'icefirst', text: 'starting with an ice cube in {A}\'s mouth', props: ['ice'], tags: ['sensation'], fits: ['oral', 'kissing'] },
    { id: 'feather', text: 'after first teasing {B} all over with a feather', props: ['feather'], tags: ['sensation'], minLevel: 2 },
    // couple-aware
    { id: 'sp-watch', text: 'while {B.spouse} watches from close by', rel: 'swap' },
    { id: 'sp-call', text: 'and {B.spouse} decides exactly when it ends', rel: 'swap' },
    { id: 'sp-ask', text: 'but first {A} has to ask {B.spouse} for permission, out loud', rel: 'swap' },
    { id: 'others', text: 'while the other couple watches', rel: 'spouse' },
    { id: 'others-pick', text: 'and the other couple picks the pace', rel: 'spouse' },
    // a third player joins
    { id: 'watch', text: 'while {C} watches up close and calls out instructions', roles: { C: 'any' }, tags: ['group'] },
    { id: 'neck3', text: 'while {C} kisses {B}\'s neck', roles: { C: 'any' }, contacts: [C('C', 'B', ['kissing'])], tags: ['group', 'kissing'], minLevel: 2 },
    { id: 'hands3', text: 'while {C} caresses {B}\'s breasts', roles: { C: 'any' }, rolesNeed: { B: 'F' }, contacts: [C('C', 'B', ['hands'])], tags: ['group', 'hands'], minLevel: 2 },
    { id: 'hold3', text: 'while {C} holds {B}\'s wrists', roles: { C: 'any' }, contacts: [C('C', 'B', ['restraint'])], tags: ['group', 'restraint'], minLevel: 3 },
    { id: 'bj3', text: 'while {B} gives {C} a blowjob', roles: { C: 'M' }, contacts: [C('B', 'C', ['oral'])], tags: ['group', 'oral'], minLevel: 4, only: ['cunni', 'rim', 'doggy', 'sex', 'toyin'] },
  ];

  function placeFits(act, place) {
    if (!place.id) return true;
    if (act.noPlace) return false;
    const multi = Object.keys(act.roles).length > 2;
    const lying = ['sixtynine', 'facesit', 'tribbing', 'g-69', 'ride', 'ffm-face', 'ffm-ride', 'mmf-choose', 'mmf-ride'];
    if (lying.includes(act.id)) return ['sofa', 'bed', 'rug'].includes(place.id);
    const seated = { clothedlap: ['sofa', 'armchair', 'desk'], 'ffm-lap': ['sofa', 'armchair'], lapsit: ['sofa', 'armchair', 'ottoman', 'desk', 'bed'], grind: ['sofa', 'armchair', 'ottoman', 'desk', 'bed'], grindhard: ['sofa', 'armchair', 'ottoman', 'desk', 'bed'] };
    if (seated[act.id]) return seated[act.id].includes(place.id);
    if (multi && ['wall', 'doorframe', 'stairs', 'desk', 'coffee-table', 'mirror', 'kitchen'].includes(place.id)) return false;
    if (place.id === 'stairs' || place.id === 'coffee-table') return ['doggy', 'rim', 'spank3', 'crop', 'oilback', 'wax'].includes(act.id);
    if (place.id === 'wall' || place.id === 'doorframe') return !['sixtynine', 'facesit', 'tribbing', 'ride', 'oilback', 'wax', 'tits', 'g-69', 's-spot'].includes(act.id);
    if (place.id === 'mirror') return ['standing', 'doggy', 'breasts', 'finger', 'neck', 'slowkiss', 'cuffedsex'].includes(act.id);
    if (place.id === 'desk' || place.id === 'armchair' || place.id === 'ottoman') return !['sixtynine', 'tribbing', 'facesit', 'standing', 'doggy', 'g-69', 'mmf-choose'].includes(act.id);
    if (act.id === 'standing') return ['wall', 'doorframe', 'kitchen'].includes(place.id);
    return true;
  }

  function twistFits(act, tw) {
    if (tw.id === 'none') return true;
    if (act.noTwist || Object.keys(act.roles).length > 2) return false;
    if (tw.fits && !tw.fits.some((t) => act.tags.includes(t))) return false;
    if (tw.only && !tw.only.includes(act.id)) return false;
    if (tw.minLevel && act.intensity < tw.minLevel) return false;
    if (tw.rolesNeed) for (const k in tw.rolesNeed) if (act.roles[k] !== 'any' && act.roles[k] !== tw.rolesNeed[k]) return false;
    if (tw.id === 'nohands' && act.tags.includes('restraint')) return false;
    if (tw.id === 'blind' && act.tags.includes('blindfold')) return false;
    if (tw.rel && act.rel && tw.rel !== act.rel) return false;
    if (tw.rel && (spouseSlots(act.text).length || act.id.startsWith('g-'))) return false; // already couple-aware
    if (tw.roles && spouseSlots(act.text).length) return false;
    return true;
  }

  function compose(act, place, tw) {
    const roles = { ...act.roles, ...(tw.roles || {}) };
    if (tw.rolesNeed) Object.assign(roles, tw.rolesNeed);
    let text = place.phrase ? place.phrase + ', ' + act.text : act.text;
    if (tw.text) {
      let t = tw.text;
      if (t.startsWith('while ') && / while /.test(act.text)) t = 'and meanwhile ' + t.slice(6);
      text += (/^(and|after|starting|but)/.test(t) ? ', ' : ' ') + t;
    }
    if (!/[.!?"”]$/.test(text)) text += '.';
    const rel = tw.rel || act.rel;
    const base = act.contacts
      ? act.contacts.filter(([a, b]) => roles[a] && roles[b]).map(([a, b, tags, r]) => ({ a, b, tags, rel: r }))
      : [{ a: 'A', b: 'B', tags: act.tags, rel }];
    const contacts = [...base, ...(tw.contacts || []).map(([a, b, tags, r]) => ({ a, b, tags, rel: r }))];
    // contacts against {X.spouse} in s-hold are spouse-to-spouse by construction; drop the placeholder pair
    const real = contacts.filter((c) => roles[c.a] && roles[c.b]);
    const intensity = act.intensity;
    const fCount = Object.values(roles).filter((g) => g === 'F').length;
    return {
      id: `g-${act.id}-${place.id || 'any'}-${tw.id}`,
      act: act.id,
      title: act.title + (tw.roles ? ' (Trio)' : ''),
      text, roles, everyone: false, contacts: real,
      intensity, clothing: act.clothing,
      props: uniq([...act.props, ...(tw.props || [])]),
      places: act.places ? act.places.slice() : place.id ? [place.id] : [],
      tags: uniq([...act.tags, ...(tw.tags || []), ...(Object.keys(roles).length > 2 ? ['group'] : []),
        ...(real.some((c) => roles[c.a] === 'F' && roles[c.b] === 'F') || (fCount >= 2 && act.roles.A === 'F' && act.roles.B === 'F') ? ['same-sex'] : [])]),
      duration: act.secs || defaultDuration(intensity),
      source: 'generated',
      warnings: [],
    };
  }

  /** opts: { intensity, clothing, count, kit, players, rules, kind, exclude:Set } */
  function generate(opts) {
    const { intensity, clothing = 3, count = 10, kit, players, rules, kind, exclude = new Set() } = opts;
    const out = [];
    const seen = new Set(exclude);
    const acts = ACTS.filter((a) => a.intensity === intensity && a.clothing <= clothing);
    for (let tries = 0; tries < 900 && out.length < count && acts.length; tries++) {
      const act = pick(acts);
      const places = GEN_PLACES.filter((p) => placeFits(act, p));
      const place = pick(places);
      const twists = TWISTS.filter((t) => twistFits(act, t));
      const tw = Math.random() < 0.4 || twists.length < 2 ? TWISTS[0] : pick(twists);
      const d = compose(act, place, tw);
      if (seen.has(d.id)) continue;
      if (kit && !kitAllows(d, kit)) continue;
      if (players) {
        const cs = castings(d, players, null, rules);
        if (!cs.length) continue;
        if (kind && !cs.some((c) => kindOf(d, c, rules) === kind)) continue;
      }
      seen.add(d.id);
      out.push(d);
    }
    return out;
  }

  function generateAll() {
    const all = [];
    for (const act of ACTS) for (const place of GEN_PLACES) if (placeFits(act, place))
      for (const tw of TWISTS) if (twistFits(act, tw)) all.push(compose(act, place, tw));
    return all;
  }

  // ---------- the night: stages + party picker ----------
  const DEFAULT_STAGES = [
    { id: 'warm', name: 'Warm-up', min: 1, max: 2, clothing: 1, dares: 6, mix: { spouse: 3, girls: 2, swap: 1, mmf: 0, ffm: 1, all: 1 } },
    { id: 'heat', name: 'Heating up', min: 2, max: 3, clothing: 2, dares: 8, mix: { spouse: 2, girls: 2, swap: 3, mmf: 1, ffm: 1, all: 1 } },
    { id: 'swap', name: 'Swap', min: 3, max: 4, clothing: 3, dares: 10, mix: { spouse: 1, girls: 1, swap: 4, mmf: 2, ffm: 2, all: 1 } },
    { id: 'finale', name: 'Finale', min: 4, max: 5, clothing: 3, dares: 5, mix: { spouse: 1, girls: 0, swap: 2, mmf: 1, ffm: 1, all: 2 } },
  ];

  /**
   * Pick the next dare for a stage.
   * o: { stage, done (dares played in this stage), used:Set, stats, stageKinds:{kind:count}, kit, rules, cap (max intensity override) }
   */
  function partyNext(pool, players, o) {
    const { stage, done = 0, used = new Set(), stats = emptyStats(), stageKinds = {}, kit, rules } = o;
    const max = Math.min(stage.max, o.cap || 5);
    const min = Math.min(stage.min, max);
    const progress = Math.min(1, done / Math.max(1, stage.dares - 1));
    const target = min + (max - min) * progress;
    const byKind = {};
    for (const d of pool) {
      if (used.has(d.id) || d.intensity < min || d.intensity > max || d.clothing > stage.clothing || !kitAllows(d, kit)) continue;
      const cs = castings(d, players, stats, rules);
      const seenKind = new Set();
      for (const c of cs) {
        const k = kindOf(d, c, rules);
        if (seenKind.has(k)) continue;
        seenKind.add(k);
        const fit = c.score + 1.5 * Math.abs(d.intensity - target) + (d.clothing < stage.clothing ? 1 : 0);
        (byKind[k] = byKind[k] || []).push({ dare: d, casting: c, kind: k, fit });
      }
    }
    const kinds = Object.keys(byKind).filter((k) => (stage.mix[k] || 0) > 0);
    if (!kinds.length) return null;
    const weights = kinds.map((k) => stage.mix[k] / (1 + 1.5 * (stageKinds[k] || 0)));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0), k = kinds[0];
    for (let i = 0; i < kinds.length; i++) { r -= weights[i]; if (r <= 0) { k = kinds[i]; break; } }
    const opts = byKind[k].sort((a, b) => a.fit - b.fit).slice(0, 4);
    return pick(opts);
  }

  /** Fresh generated dares covering a stage's range and kinds, for mixing into play. */
  function stagePool(stage, players, kit, rules, exclude) {
    const out = [];
    for (let lvl = stage.min; lvl <= stage.max; lvl++)
      for (const kind of Object.keys(stage.mix)) if (stage.mix[kind] > 0)
        out.push(...generate({ intensity: lvl, clothing: stage.clothing, count: 3, kit, players, rules, kind, exclude }));
    return out;
  }

  /** A whole night's worth of generated dares (roughly 2x what each stage needs). */
  function generateNight(stages, players, kit, rules) {
    const seen = new Set(), out = [];
    for (const st of stages) {
      const total = Object.values(st.mix).reduce((a, b) => a + b, 0) || 1;
      for (const [kind, w] of Object.entries(st.mix)) {
        if (!w) continue;
        const want = Math.ceil((st.dares * 2 * w) / total);
        for (let i = 0; i < want; i++) {
          const lvl = st.min + Math.round(((st.max - st.min) * i) / Math.max(1, want - 1));
          for (const d of generate({ intensity: lvl, clothing: st.clothing, count: 1, kit, players, rules, kind, exclude: seen })) { seen.add(d.id); out.push(d); }
        }
      }
    }
    return out;
  }

  // ---------- dealing a balanced night ----------
  let _allGen = null;
  const allGenerated = () => (_allGen = _allGen || generateAll());

  /** Every playable (dare, casting) at one level. */
  function levelCandidates(level, o) {
    const { players, rules, kit, deck = [], source = 'both', clothingMax = [1, 2, 3, 3, 3] } = o;
    const pool = (source === 'gen' ? [] : deck).concat(source === 'deck' ? [] : allGenerated());
    const out = [];
    for (const d of pool) {
      if (d.intensity !== level || d.clothing > clothingMax[level - 1] || !kitAllows(d, kit)) continue;
      for (const c of castings(d, players, null, rules)) {
        const cts = c.cast ? normContacts(d) : [];
        const pairs = uniq(cts.map((x) => pairKey(c.cast[x.a].name, c.cast[x.b].name)));
        // "active" = people who actually do something physical; watchers and callers don't use up a turn
        const active = c.cast ? uniq(cts.flatMap((x) => [c.cast[x.a].name, c.cast[x.b].name])) : c.people.map((p) => p.name);
        out.push({
          dare: d, casting: c, kind: kindOf(d, c, rules), level,
          people: c.people.map((p) => p.name), active, pairs,
          lead: c.cast ? c.cast[Object.keys(d.roles)[0]].name : null,
          act: d.act || d.id,
        });
      }
    }
    return out;
  }

  /**
   * Deal a fixed set of cards for the night.
   * o: { perLevel: [n1..n5] dares per player at each level, players, rules, kit, deck, source, clothingMax }
   * Goals, in order: everyone gets exactly n dares at each level; each player's interactions are spread
   * evenly across everyone they're up for (over the whole night); no act repeats; variety of kinds;
   * everyone leads about as often as they receive.
   * Levels are dealt from 5 down to 1, so the most constrained level is fixed first and the
   * easier levels even out whatever it couldn't.
   */
  function dealNight(o) {
    const { perLevel, players } = o;
    const recent = new Set(o.recent || []); // act ids played on recent nights
    const names = players.map((p) => p.name);
    const cum = { pairs: {}, leads: {}, acts: {}, kinds: {} };
    const pools = {};
    const dealt = [];
    const shortfalls = [];

    for (let level = 5; level >= 1; level--) {
      const N = perLevel[level - 1] || 0;
      if (!N) continue;
      const cands = levelCandidates(level, o);
      pools[level] = cands;
      // who can actually pair with whom at this level. Evenness is measured across a player's
      // opposite-gender partners (each man equally with each woman: spouse and swap alike).
      // Same-gender pairs (the women together) are allowed but not forced to match: with equal
      // turns for everyone, forcing that too would only be possible with a night of threesomes.
      const gender = Object.fromEntries(players.map((p) => [p.name, p.gender]));
      const feas = {};
      names.forEach((n) => (feas[n] = new Set()));
      cands.forEach((c) => c.pairs.forEach((k) => { const [a, b] = k.split('|'); if (gender[a] !== gender[b]) { feas[a].add(k); feas[b].add(k); } }));
      const feasArr = Object.fromEntries(names.map((n) => [n, [...feas[n]]]));

      // kinds variety is judged within the level (cumulative counts would snowball towards rare kinds)
      const st = { plays: {}, pairs: { ...cum.pairs }, leads: { ...cum.leads }, acts: { ...cum.acts }, kinds: {}, ids: new Set(), chosen: [] };
      const apply = (c, s) => {
        c.active.forEach((n) => (st.plays[n] = (st.plays[n] || 0) + s));
        c.pairs.forEach((k) => (st.pairs[k] = (st.pairs[k] || 0) + s));
        if (c.lead) st.leads[c.lead] = (st.leads[c.lead] || 0) + s;
        st.acts[c.act] = (st.acts[c.act] || 0) + s;
        st.kinds[c.kind] = (st.kinds[c.kind] || 0) + s;
        if (s > 0) { st.ids.add(c.dare.id); st.chosen.push(c); } else { st.ids.delete(c.dare.id); st.chosen.splice(st.chosen.indexOf(c), 1); }
      };
      const cost = (noPlays) => {
        let c = 0;
        for (const n of names) {
          const d = (st.plays[n] || 0) - N; if (!noPlays) c += 40 * d * d;
          const ks = feasArr[n];
          if (ks.length > 1 && !noPlays) {
            const v = ks.map((k) => st.pairs[k] || 0), m = v.reduce((a, b) => a + b, 0) / v.length;
            v.forEach((x) => { c += 6 * (x - m) * (x - m); });
          }
        }
        const ld = names.map((n) => st.leads[n] || 0), lm = ld.reduce((a, b) => a + b, 0) / ld.length;
        ld.forEach((x) => { c += 0.4 * (x - lm) * (x - lm); });
        for (const v of Object.values(st.acts)) if (v > 1) c += 5 * (v - 1);
        // variety of kinds
        for (const v of Object.values(st.kinds)) c += 0.3 * v * v;
        // mostly two-person dares; threesomes and all-four as occasional extras;
        // avoid what you've played on recent nights; lean towards the written scenes over the old deck
        for (const ch of st.chosen) {
          c += ch.active.length <= 2 ? 0 : ch.active.length === 3 ? 3 : 8;
          if (recent.has(ch.act)) c += 4;
          if (ch.dare.source !== 'generated') c += 1;
        }
        return c;
      };
      const tryBest = (list, noPlays) => {
        let best = null, bc = Infinity;
        for (const c of list) { apply(c, 1); const v = cost(noPlays) + Math.random() * 0.01; apply(c, -1); if (v < bc) { bc = v; best = c; } }
        return [best, bc];
      };
      // random sample without scanning/shuffling the whole pool
      const sample = (filter, k) => {
        const got = new Set();
        for (let t = 0; t < k * 6 && got.size < k && cands.length; t++) { const c = cands[(Math.random() * cands.length) | 0]; if (filter(c)) got.add(c); }
        return [...got];
      };
      const short = () => names.filter((n) => (st.plays[n] || 0) < N);
      const over = () => names.filter((n) => (st.plays[n] || 0) > N);

      // greedy fill without overshooting anyone
      for (;;) {
        let open = sample((c) => !st.ids.has(c.dare.id) && c.active.every((n) => (st.plays[n] || 0) < N), 300);
        if (!open.length) open = cands.filter((c) => !st.ids.has(c.dare.id) && c.active.every((n) => (st.plays[n] || 0) < N)).slice(0, 300);
        if (!open.length) break;
        apply(tryBest(open, true)[0], 1); // rank on pairing/variety; every option here makes progress
      }
      // local search: swap one card for another, aiming at whoever is short or over
      for (let it = 0; it < 700 && st.chosen.length; it++) {
        const before = cost();
        const s = short(), o2 = over();
        const out = o2.length ? pick(st.chosen.filter((c) => c.active.some((n) => o2.includes(n))) || st.chosen) || pick(st.chosen) : pick(st.chosen);
        apply(out, -1);
        const want = s.length || o2.length ? short() : null;
        const filt = want && want.length
          ? (c) => !st.ids.has(c.dare.id) && c !== out && c.active.some((n) => want.includes(n))
          : (c) => !st.ids.has(c.dare.id) && c !== out;
        const [b] = tryBest(sample(filt, 150));
        const added = [];
        if (b) { apply(b, 1); added.push(b); }
        // one card can be worth two (e.g. an all-four card -> two pair dares)
        const still = short();
        if (still.length) {
          const [b2] = tryBest(sample((c) => !st.ids.has(c.dare.id) && c !== out && c.active.every((n) => still.includes(n)), 150));
          if (b2) { apply(b2, 1); added.push(b2); }
        }
        if (cost() >= before) { added.reverse().forEach((c) => apply(c, -1)); apply(out, 1); }
        if (!s.length && !o2.length && it > 150) break;
      }
      names.forEach((n) => { if ((st.plays[n] || 0) !== N) shortfalls.push(`${n} has ${st.plays[n] || 0} instead of ${N} at level ${level}`); });
      Object.assign(cum, { pairs: st.pairs, leads: st.leads, acts: st.acts, kinds: st.kinds });
      dealt.push(...st.chosen);
    }
    polishPairs(dealt, pools, players);
    dealt.sort((a, b) => a.level - b.level || a.dare.clothing - b.dare.clothing);
    return { cards: reorder(dealt), pools, report: dealReport(dealt, players), shortfalls };
  }

  /**
   * Final pass over the whole night: take two man-woman pair cards at the same level with four
   * different people (e.g. Tim-Emma and Troy-Rachel) and trade them for cards pairing them the
   * other way round (Tim-Rachel and Troy-Emma) when that evens out the night's totals.
   * Everyone keeps exactly the same number of turns at every level.
   */
  function polishPairs(dealt, pools, players) {
    const g = Object.fromEntries(players.map((p) => [p.name, p.gender]));
    const isMF = (c) => c.active.length === 2 && c.pairs.length === 1 && g[c.active[0]] !== g[c.active[1]];
    const men = players.filter((p) => p.gender === 'M').map((p) => p.name);
    const women = players.filter((p) => p.gender === 'F').map((p) => p.name);
    const count = {};
    dealt.forEach((c) => c.pairs.forEach((k) => (count[k] = (count[k] || 0) + 1)));
    const spread = () => {
      let s = 0;
      for (const m of men) {
        const v = women.map((w) => count[pairKey(m, w)] || 0), avg = v.reduce((a, b) => a + b, 0) / v.length;
        v.forEach((x) => (s += (x - avg) * (x - avg)));
      }
      return s;
    };
    const used = new Set(dealt.map((c) => c.dare.id)), acts = new Set(dealt.map((c) => c.act));
    // index each level's pool by exactly who takes a turn, so replacements keep everyone's counts
    const key = (names) => names.slice().sort().join('+');
    const index = {};
    for (const [lvl, list] of Object.entries(pools)) {
      index[lvl] = {};
      for (const c of list) (index[lvl][key(c.active)] = index[lvl][key(c.active)] || []).push(c);
    }
    const free = (c) => !used.has(c.dare.id) && !acts.has(c.act);
    const shift = (cards, d) => cards.forEach((c) => c.pairs.forEach((k) => (count[k] = (count[k] || 0) + d)));
    const swapIn = (olds, news) => {
      olds.forEach((o) => { used.delete(o.dare.id); acts.delete(o.act); });
      news.forEach((n, i) => { used.add(n.dare.id); acts.add(n.act); dealt[dealt.indexOf(olds[i])] = n; });
    };
    for (let it = 0; it < 600; it++) {
      const before = spread();
      if (before < 0.01) break;
      const x = pick(dealt); if (!x || !x.casting.cast) continue;
      const lvl = x.level;
      if (Math.random() < 0.4) {
        // one-for-one: same people, different pairings (e.g. which man has which woman in an MMF)
        const opts = (index[lvl][key(x.active)] || []).filter((c) => c !== x && free(c));
        const n = pick(opts); if (!n) continue;
        shift([x], -1); shift([n], 1);
        if (spread() < before - 1e-9) swapIn([x], [n]); else { shift([n], -1); shift([x], 1); }
        continue;
      }
      // two-for-two at the same level, same turns overall
      const y = pick(dealt.filter((c) => c !== x && c.level === lvl && c.casting.cast)); if (!y) continue;
      const U = {}; [...x.active, ...y.active].forEach((n) => (U[n] = (U[n] || 0) + 1));
      const pool = (pools[lvl] || []).filter(free);
      for (let t = 0; t < 40; t++) {
        const nx = pick(pool); if (!nx) break;
        const R = { ...U }; let ok = true;
        nx.active.forEach((n) => { R[n] = (R[n] || 0) - 1; if (R[n] < 0) ok = false; });
        if (!ok) continue;
        const rest = Object.entries(R).flatMap(([n, v]) => Array(v).fill(n));
        if (rest.some((n, i) => rest.indexOf(n) !== i)) continue; // nobody twice in one card
        const ny = pick((index[lvl][key(rest)] || []).filter((c) => free(c) && c.act !== nx.act && c !== nx));
        if (!ny) continue;
        shift([x, y], -1); shift([nx, ny], 1);
        if (spread() < before - 1e-9) { swapIn([x, y], [nx, ny]); break; }
        shift([nx, ny], -1); shift([x, y], 1);
      }
    }
  }

  // Order within each level/clothing group so the same people don't go twice in a row.
  function reorder(cards) {
    const out = [];
    const groups = [];
    cards.forEach((c) => { const g = groups[groups.length - 1]; if (g && g.key === c.level + '-' + c.dare.clothing) g.items.push(c); else groups.push({ key: c.level + '-' + c.dare.clothing, items: [c] }); });
    for (const g of groups) {
      let rest = shuffle(g.items);
      while (rest.length) {
        const prev = out[out.length - 1];
        rest.sort((a, b) => overlap(prev, a) - overlap(prev, b));
        out.push(rest.shift());
      }
    }
    return out;
  }
  const overlap = (a, b) => (a ? b.people.filter((n) => a.people.includes(n)).length + (a.kind === b.kind ? 0.5 : 0) : 0);

  function dealReport(cards, players) {
    const plays = {}, pairs = {}, perLevel = {}, kinds = {};
    cards.forEach((c) => {
      (c.active || c.people).forEach((n) => { plays[n] = (plays[n] || 0) + 1; perLevel[n] = perLevel[n] || [0, 0, 0, 0, 0]; perLevel[n][c.level - 1]++; });
      c.pairs.forEach((k) => (pairs[k] = (pairs[k] || 0) + 1));
      kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    });
    const partnersOf = {};
    players.forEach((p) => { partnersOf[p.name] = Object.entries(pairs).filter(([k]) => k.split('|').includes(p.name)).map(([k, v]) => [k.split('|').find((x) => x !== p.name), v]); });
    return { total: cards.length, plays, perLevel, pairs, kinds, partnersOf };
  }

  /** A like-for-like replacement for a passed card: same level, same pairs, else same people. */
  function substitute(card, pools, usedIds) {
    const pool = (pools[card.level] || []).filter((c) => !usedIds.has(c.dare.id) && c.dare.clothing <= card.dare.clothing);
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const exact = pool.filter((c) => same(c.pairs, card.pairs) && same(c.people, card.people));
    if (exact.length) return pick(exact);
    const people = pool.filter((c) => same(c.people, card.people));
    return people.length ? pick(people) : null;
  }

  const api = {
    PROPS: Object.keys(PROPS), PLACES: Object.keys(PLACES), TAGS: [...Object.keys(TAGS), 'same-sex', 'group'], TOY_PROPS, ACTS, TWISTS,
    SWAP_LEVELS, KINDS, DEFAULT_STAGES,
    migrateV1, normalizeDeck, toV1, v1Compatible, normContacts, rulesFromCouples, relationOk,
    castings, kindOf, spouseCheck, recordPlay, undoPlay, emptyStats, nextDare, partyNext, stagePool,
    blocker, kitAllows, render, generate, generateAll, generateNight, esc, defaultDuration,
    dealNight, substitute, levelCandidates, dealReport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DareEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
