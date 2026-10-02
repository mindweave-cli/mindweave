/**
 * workingVerb.ts — the word the status line shows while a turn runs.
 *
 * `Working…` on every turn of every session is a label, not a signal: it says the thing the spinner
 * already says. A word that changes tells you at a glance that the agent is still moving, and a
 * different one each turn tells you this is a NEW turn and not the last one still going.
 *
 * It swaps every few seconds while a turn runs, walking a shuffled order of a big pool so it does
 * not repeat for a very long time. The order is fixed by the turn's start time and the word by the
 * seconds elapsed, so the once-a-render clock cannot make it flicker between words: it is the same
 * answer for any frame inside the same few seconds. Pure, so the choice is testable without a clock.
 */

/** How long one word stays on the line. */
export const VERB_SWAP_MS = 4000;

/**
 * Present participles only, silly on purpose, and none that claim progress the harness cannot see
 * ("Almost done", "Finishing"): those would be a guess dressed as a status.
 */
const VERBS = [
  "Scampering", "Tinkering", "Rummaging", "Untangling", "Puzzling", "Burrowing", "Whirring", "Pondering",
  "Noodling", "Sifting", "Weaving", "Chewing", "Jokering", "Webbing", "Swimming", "Dumbing",
  "Noideawhatshappening", "Willy-nillying", "Dilly-dallying", "Shilly-shallying", "Hobnobbing", "Bamboozling",
  "Discombobulating", "Flibbertigibbeting", "Gallivanting", "Lollygagging", "Skedaddling", "Zigzagging",
  "Hullabalooing", "Kerfuffling", "Rigmaroling", "Snickerdoodling", "Wibbling", "Wobbling", "Bumbling",
  "Fumbling", "Stumbling", "Mumbling", "Grumbling", "Rumbling", "Tumbling", "Jumbling", "Crumbling",
  "Doodling", "Dawdling", "Fiddling", "Piddling", "Twiddling", "Muddling", "Puttering",
  "Pottering", "Faffing", "Fussing", "Futzing", "Mucking", "Messing", "Monkeying", "Horsing",
  "Clowning", "Goofing", "Larking", "Frolicking", "Cavorting", "Capering", "Prancing",
  "Waddling", "Toddling", "Shuffling", "Scuttling", "Skittering", "Scurrying", "Hustling", "Bustling",
  "Meandering", "Ambling", "Sauntering", "Strolling", "Wandering", "Roaming", "Drifting", "Floating",
  "Bobbing", "Paddling", "Splashing", "Sploshing", "Squelching", "Squishing", "Squashing", "Squeezing",
  "Wiggling", "Jiggling", "Giggling", "Wriggling", "Squirming", "Spinning", "Twirling", "Swirling",
  "Whirling", "Zooming", "Zipping", "Zapping", "Zonking", "Boinging", "Bouncing", "Pouncing",
  "Sneaking", "Creeping", "Tiptoeing", "Prowling", "Lurking", "Skulking", "Snooping", "Sleuthing",
  "Detectiving", "Investigating", "Inspecting", "Squinting", "Peering", "Peeking", "Gawking", "Ogling",
  "Contemplating", "Ruminating", "Cogitating", "Mulling", "Musing", "Brooding", "Dreaming", "Daydreaming",
  "Woolgathering", "Brainstorming", "Brain-wrangling", "Thinkering", "Overthinking", "Underthinking",
  "Cooking", "Simmering", "Stewing", "Brewing", "Baking", "Toasting", "Marinating", "Sautéing",
  "Whisking", "Kneading", "Frosting", "Sprinkling", "Seasoning", "Garnishing", "Plating", "Buttering",
  "Juggling", "Wrangling", "Herding", "Shepherding", "Corralling", "Lassoing", "Wielding", "Brandishing",
  "Polishing", "Buffing", "Burnishing", "Sanding", "Scrubbing", "Dusting", "Sweeping", "Mopping",
  "Knitting", "Crocheting", "Stitching", "Sewing", "Darning", "Patching", "Mending", "Stapling",
  "Hammering", "Bolting", "Riveting", "Welding", "Soldering", "Gluing", "Taping", "Duct-taping",
  "Cranking", "Tweaking", "Twisting", "Winding", "Unwinding", "Rewinding", "Spooling", "Unspooling",
  "Shimmying", "Shaking", "Boogieing", "Grooving", "Jiving", "Waltzing", "Tangoing", "Moonwalking",
  "Yodeling", "Humming", "Whistling", "Warbling", "Chirping", "Twittering", "Squawking", "Honking",
  "Quacking", "Waddling", "Hooting", "Purring", "Meowing", "Barking", "Howling", "Yapping",
  "Nibbling", "Munching", "Crunching", "Gnawing", "Nuzzling", "Snuffling", "Sniffing", "Snorting",
  "Foraging", "Scavenging", "Hoarding", "Stockpiling", "Gathering", "Collecting", "Accumulating", "Amassing",
  "Untying", "Unknotting", "Unraveling", "Unfurling", "Unfolding", "Unpacking", "Unboxing", "Unscrambling",
  "Decoding", "Deciphering", "Decrypting", "Translating", "Interpreting", "Divining", "Conjuring", "Summoning",
  "Spellcasting", "Enchanting", "Bewitching", "Hexing", "Alchemizing", "Transmuting", "Levitating",
  "Pirouetting", "Somersaulting", "Cartwheeling", "Backflipping", "Tightroping", "Unicycling", "Stilt-walking", "Trampolining",
  "Gardening", "Pruning", "Planting", "Watering", "Weeding", "Composting", "Pollinating", "Sprouting",
  "Stargazing", "Moonbathing", "Cloud-watching", "Sunbathing", "Beachcombing", "Rockpooling", "Treasure-hunting", "Mapmaking",
  "Sherlocking", "Spelunking", "Orienteering", "Pathfinding", "Trailblazing", "Wayfinding", "Compass-reading",
  "Gobbledygooking", "Balderdashing", "Poppycocking", "Codswalloping", "Flummoxing", "Befuddling", "Perplexing", "Confuzzling",
  "Hootenannying", "Razzle-dazzling", "Higgledy-piggledying", "Topsy-turvying", "Helter-skeltering", "Hodgepodging", "Pell-melling", "Rumpus-making",
  "Schlepping", "Plodding", "Trudging", "Slogging", "Toiling", "Labouring", "Grinding", "Chugging",
  "Percolating", "Fermenting", "Incubating", "Gestating", "Hatching", "Germinating", "Blossoming", "Ripening",
];

/** A small deterministic generator, so the same turn always walks the same order. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pool without repeats, in a fixed order that depends only on the turn's start time. */
function orderFor(startedAt: number): string[] {
  const pool = [...new Set(VERBS)];
  const rand = mulberry32(Math.abs(Math.floor(startedAt)) % 2147483647);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool;
}

let cached: { key: number; order: string[] } | null = null;

/**
 * The word for the turn that began at `startedAt`, `elapsedMs` into it. The same inside any
 * VERB_SWAP_MS window, a different one in the next, and no word twice until the whole pool has gone by.
 */
export function workingVerb(startedAt: number, elapsedMs = 0): string {
  const key = Math.abs(Math.floor(startedAt));
  if (!cached || cached.key !== key) cached = { key, order: orderFor(startedAt) };
  const step = Math.max(0, Math.floor(elapsedMs / VERB_SWAP_MS));
  return cached.order[step % cached.order.length]!;
}

/** Exposed for the test: the pool must stay free of progress claims. */
export const WORKING_VERBS: readonly string[] = [...new Set(VERBS)];
