/**
 * Common English given-name equivalences ("Rob" = "Robert"), shared by the
 * deterministic name matchers: news tags (etl/news/names.ts), honors rosters
 * (etl/honors/lists/match.ts) and Faculty Review mentees (lib/frt/mentee-name.ts).
 *
 * A FIXED table, not a fuzzy rule, and deliberately conservative. Each group is a
 * formal name (first) plus the diminutives that almost always mean it. Left out
 * on purpose:
 *   - cross-gender diminutives ("Chris", "Alex", "Sam", "Pat", "Terry", "Jess",
 *     "Kim", "Jackie", "Charlie"): one token, two unrelated formal names;
 *   - short forms that are now mostly given names in their own right ("Jack",
 *     "Max", "Theo", "Tessa", "Lily", "Eliza", "Molly", "Sally", "Sadie",
 *     "Tori", "Evie"), and names that never were one ("Lisa", "Liam", "Nora");
 *   - transliteration short forms ("Effie"/"Eftychia", "Amir"/"Amirhossein"),
 *     which no table can enumerate safely.
 *
 * Equivalence is FORMAL <-> DIMINUTIVE only: one side must be the group's formal
 * name. Two diminutives never match each other ("Hank" is not "Harry", "Ned" is
 * not "Ted"), and nothing is transitive across groups: "Ted" sits in both the
 * Edward and the Theodore group, so Ted ~ Edward and Ted ~ Theodore, but Edward
 * is not ~ Theodore. A spelling variant of the formal name is listed as one of
 * its forms ("Steven" under "Stephen").
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
  ["john", "johnny"],
  ["jonathan", "jon", "jonny"],
  ["joseph", "joe", "joey"],
  ["thomas", "tom", "tommy"],
  ["michael", "mike", "mikey", "mick"],
  ["charles", "chuck", "chas"],
  ["david", "dave", "davey"],
  ["daniel", "dan", "danny"],
  ["matthew", "matt", "matty"],
  ["anthony", "tony"],
  ["stephen", "steven", "steve"],
  ["steven", "steve"],
  ["edward", "ed", "eddie", "ted", "ned"],
  ["theodore", "ted", "teddy"],
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
  ["bartholomew", "bart"],
  ["montgomery", "monty"],
  // Female
  ["elizabeth", "liz", "lizzie", "lizzy", "beth", "betsy", "betty", "libby"],
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
  ["victoria", "vicky", "vicki"],
  ["barbara", "barb"],
  ["pamela", "pam"],
  ["cynthia", "cindy"],
  ["melissa", "missy"],
  ["abigail", "abby", "abbie"],
  ["amanda", "mandy"],
  ["dorothy", "dot", "dottie"],
  ["judith", "judy"],
  ["theresa", "tess"],
  ["teresa", "tess"],
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
  ["lillian", "lil"],
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

/** Folded name -> every name it is equivalent to: a formal name maps to its
 *  diminutives, a diminutive to its formal name(s). Never diminutive -> diminutive. */
const EQUIVALENTS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  for (const [formal, ...short] of GROUPS) {
    for (const n of short) {
      link(formal, n);
      link(n, formal);
    }
  }
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
  return EQUIVALENTS.get(fa)?.has(fb) ?? false;
}

/** Every name equivalent to `name` (folded), for keyed lookups — the same
 *  relation as `nicknamesEquivalent`. Empty when the name is not in the table. */
export function nicknameVariants(name: string): string[] {
  return [...(EQUIVALENTS.get(fold(name)) ?? [])];
}
