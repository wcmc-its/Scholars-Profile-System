/**
 * Common English given-name equivalences ("Rob" = "Robert"), shared by the
 * deterministic name matchers: news tags (etl/news/names.ts), honors rosters
 * (etl/honors/lists/match.ts) and Faculty Review mentees (lib/frt/mentee-name.ts).
 *
 * A FIXED table, not a fuzzy rule, and deliberately conservative. Each group is a
 * formal name plus the diminutives that almost always mean it. Left out on
 * purpose:
 *   - cross-gender diminutives ("Chris", "Alex", "Sam", "Pat", "Terry", "Jess",
 *     "Kim", "Jackie", "Charlie"): one token, two unrelated formal names;
 *   - names that are their own name, not a short form ("Lisa", "Liam", "Nora");
 *   - transliteration short forms ("Effie"/"Eftychia", "Amir"/"Amirhossein"),
 *     which no table can enumerate safely.
 *
 * Equivalence is PAIRWISE WITHIN A GROUP, never transitive across groups: "Ted"
 * sits in both the Edward and the Theodore group, so Ted ~ Edward and Ted ~
 * Theodore, but Edward is not ~ Theodore.
 *
 * Every caller still gates a nickname hit harder than an exact one (unique on
 * the roster, capped confidence, or labelled as a nickname match for a human).
 */
const GROUPS: readonly (readonly string[])[] = [
  // Male
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "willie", "willy"],
  ["richard", "rich", "rick", "ricky", "richie", "dick"],
  ["james", "jim", "jimmy", "jimmie"],
  ["john", "jack", "johnny"],
  ["jonathan", "jon", "jonny"],
  ["joseph", "joe", "joey"],
  ["thomas", "tom", "tommy"],
  ["michael", "mike", "mikey", "mick"],
  ["charles", "chuck", "chas"],
  ["david", "dave", "davey"],
  ["daniel", "dan", "danny"],
  ["matthew", "matt", "matty"],
  ["anthony", "tony"],
  ["stephen", "steve"],
  ["steven", "steve"],
  ["edward", "ed", "eddie", "ted", "ned"],
  ["theodore", "ted", "teddy", "theo"],
  ["timothy", "tim", "timmy"],
  ["kenneth", "ken", "kenny"],
  ["ronald", "ron"],
  ["donald", "don", "donny"],
  ["douglas", "doug"],
  ["gregory", "greg"],
  ["jeffrey", "jeff"],
  ["geoffrey", "geoff", "jeff"],
  ["benjamin", "ben", "benny", "benji"],
  ["nicholas", "nick"],
  ["peter", "pete"],
  ["lawrence", "larry"],
  ["laurence", "larry"],
  ["raymond", "ray"],
  ["gerald", "gerry", "jerry"],
  ["jerome", "jerry"],
  ["leonard", "len", "lenny"],
  ["frederick", "fred", "freddie", "freddy"],
  ["alfred", "alfie", "fred"],
  ["francis", "frank"],
  ["franklin", "frank"],
  ["henry", "hank", "harry"],
  ["harold", "hal", "harry"],
  ["walter", "walt", "wally"],
  ["eugene", "gene"],
  ["philip", "phil"],
  ["phillip", "phil"],
  ["nathaniel", "nate"],
  ["nathan", "nate"],
  ["zachary", "zach", "zack", "zak"],
  ["joshua", "josh"],
  ["jacob", "jake"],
  ["andrew", "andy"],
  ["vincent", "vince", "vinny"],
  ["victor", "vic"],
  ["gabriel", "gabe"],
  ["mitchell", "mitch"],
  ["russell", "russ"],
  ["stanley", "stan"],
  ["howard", "howie"],
  ["herbert", "herb"],
  ["abraham", "abe"],
  ["salvatore", "sal"],
  ["dominic", "dom"],
  ["dominick", "dom"],
  ["bradley", "brad"],
  ["randall", "randy"],
  ["randolph", "randy"],
  ["rodney", "rod"],
  ["roderick", "rod"],
  ["reginald", "reggie"],
  ["clifford", "cliff"],
  ["oliver", "ollie"],
  ["maximilian", "max"],
  ["maxwell", "max"],
  ["bartholomew", "bart"],
  ["montgomery", "monty"],
  // Female
  ["elizabeth", "liz", "lizzie", "lizzy", "beth", "betsy", "betty", "eliza", "libby", "liza"],
  ["margaret", "maggie", "peggy", "meg", "marge", "margie"],
  ["katherine", "kate", "katie", "kathy", "kat", "kitty"],
  ["catherine", "cate", "kate", "katie", "cathy", "cat"],
  ["kathryn", "kate", "katie", "kathy", "kat"],
  ["kathleen", "kate", "katie", "kathy"],
  ["jennifer", "jen", "jenn", "jenny"],
  ["patricia", "patty", "patti", "trish", "tricia"],
  ["susan", "sue", "susie", "suzy"],
  ["suzanne", "sue", "susie", "suzy"],
  ["deborah", "deb", "debbie", "debby"],
  ["debra", "deb", "debbie"],
  ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "vicki", "tori"],
  ["barbara", "barb"],
  ["pamela", "pam"],
  ["cynthia", "cindy"],
  ["melissa", "missy"],
  ["abigail", "abby", "abbie"],
  ["amanda", "mandy"],
  ["dorothy", "dot", "dottie"],
  ["judith", "judy"],
  ["theresa", "tess", "tessa"],
  ["teresa", "tess", "tessa"],
  ["eleanor", "ellie", "nell", "nellie"],
  ["gabrielle", "gabby"],
  ["gabriela", "gabby"],
  ["gabriella", "gabby"],
  ["stephanie", "steph"],
  ["virginia", "ginny"],
  ["penelope", "penny"],
  ["madeline", "maddie", "maddy"],
  ["madeleine", "maddie", "maddy"],
  ["gwendolyn", "gwen"],
  ["cassandra", "cassie"],
  ["lillian", "lily", "lil"],
  ["evelyn", "evie"],
  ["mary", "molly", "polly"],
  ["sarah", "sally", "sadie"],
  ["rosemary", "rosie"],
  ["antonia", "toni"],
  ["josephine", "josie"],
  ["natasha", "tasha"],
  ["nicole", "nikki"],
  ["caroline", "carrie"],
  ["carolyn", "carrie"],
  ["florence", "flo"],
  ["harriet", "hattie"],
];

/** Folded name -> indices of every group it belongs to. */
const GROUPS_OF: ReadonlyMap<string, readonly number[]> = (() => {
  const m = new Map<string, number[]>();
  GROUPS.forEach((g, i) => {
    for (const n of g) m.set(n, [...(m.get(n) ?? []), i]);
  });
  return m;
})();

/** Lowercase ASCII letters only, accents stripped — the table's own spelling. */
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * True when two DIFFERENT given names are equivalent under the table ("Bob",
 * "Robert"). Identical names return false: an exact match is the caller's
 * stronger rule, and a nickname hit must stay distinguishable from it.
 */
export function nicknamesEquivalent(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb || fa === fb) return false;
  const ga = GROUPS_OF.get(fa);
  const gb = GROUPS_OF.get(fb);
  return !!ga && !!gb && ga.some((i) => gb.includes(i));
}

/** Every OTHER name equivalent to `name` (folded), for keyed lookups. Empty
 *  when the name is not in the table. */
export function nicknameVariants(name: string): string[] {
  const f = fold(name);
  const out = new Set<string>();
  for (const i of GROUPS_OF.get(f) ?? []) for (const n of GROUPS[i]) if (n !== f) out.add(n);
  return [...out];
}
