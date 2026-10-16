import type { Evidence } from './types';

/**
 * The fake Studio Manager's library: niches with their evidence, and character archetypes in the "elder + contrast"
 * pattern that the 14 Oct research found strongest (Persona-Research-2026-10-14 §1, §4). Without an Anthropic key
 * the generator builds every step from these, deterministically, so drafts are sensible and tests are stable.
 * Names are invented; none of them is a real person or one of the archived launch five.
 */

export interface NicheDef {
  key: string;
  subNiche: string;
  angle: string;
  audience: string;
  /** What the signature mechanic rates. */
  object: string;
  /** What the niche is noisy with (the contrast). */
  noise: string;
  /** Why the character came online. */
  trigger: string;
  myths: string[];
  /** Hook templates: {retort} {verdictA} {verdictB} {years} {unit} {object} {first} {ritual}. */
  hooks: string[];
  evidence: Evidence[];
  buyingMoments: string[];
  risks: string[];
  base: { demand: number; intent: number; competition: number; seasonality: number };
  /** 0–10: how far from the legal and platform lines the niche sits. */
  lineSafety: number;
  pillars: Array<{ name: string; why: string }>;
  seriesB: { name: string; format: string };
  products: {
    lead: string;
    entry: [string, number];
    addon: [string, number];
    core: [string, number];
    upsell: [string, number];
    membership: [string, number];
  };
  briefSections: string[];
  positions: Array<{ debate: string; stance: string }>;
  softPositions: Array<{ debate: string; stance: string }>;
  worldview: string[];
  keywords: string[];
  fieldTopics: string[];
  feeds: Array<{ name: string; query: string }>;
  timezone: string;
}

export const NICHES: readonly NicheDef[] = [
  {
    key: 'wealth',
    subNiche: 'no-buy months and paycheck budgeting',
    angle: 'Budgeting as a ritual, not a punishment: no-buy challenges and paycheck plans for people who hate spreadsheets',
    audience: 'Women and men 24–40, salaried, behind on savings, tired of money-shaming',
    object: 'budget',
    noise: 'money-shaming finfluencers and income-guarantee courses',
    trigger: 'Saw a 25-year-old sell a "six-figure side hustle" course.',
    myths: ['Latte money is why you are broke', 'You need a side hustle to save', 'Budgets mean no fun'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is your paycheck plan.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'No-Buy November starts with one list.',
      'The $0 rule that beats every budgeting app.',
      'Black Friday is a test. Here is how to pass it.',
    ],
    evidence: [
      { signal: 'demand', detail: 'No-Buy challenges trend every November and January on TikTok', flag: 'L', source: 'san.com (No-Buy 2025)' },
      { signal: 'intent', detail: 'Paycheck-budget printables sell at $25–30; envelope printables $3–8', flag: 'V', source: 'shop.thebudgetmom.com; Etsy' },
      { signal: 'competition', detail: 'Crowded with finfluencers; almost no AI money character at scale', flag: 'U' },
      { signal: 'seasonality', detail: 'Buyer moments: No-Buy November vs Black Friday, the January reset', flag: 'L' },
    ],
    buyingMoments: ['No-Buy November (vs Black Friday)', 'January reset', 'Tax-refund season'],
    risks: ['No buy/sell calls on securities or crypto', 'No income guarantees or "make $X" claims'],
    base: { demand: 8, intent: 8, competition: 5, seasonality: 9 },
    lineSafety: 7,
    pillars: [
      { name: 'Paycheck plans', why: 'The concrete system people buy' },
      { name: 'Spending myths', why: 'Myth-busts drive reach and saves' },
      { name: 'No-buy rituals', why: 'Dated challenges create buying moments' },
    ],
    seriesB: { name: 'Myth or Money', format: 'activity_text' },
    products: {
      lead: 'The One-Page Paycheck Plan',
      entry: ['The 30-Day No-Buy Kit', 1500],
      addon: ['The Envelope Labels Pack', 700],
      core: ['The Paycheck Budget System', 3900],
      upsell: ['The Sinking Funds Workbook', 2400],
      membership: ['The Monthly Money Check-In', 800],
    },
    briefSections: ['The rules of the month', 'Your one-list audit', 'Week-by-week tracker', 'The urge log', 'What to do on payday', 'The day-31 review'],
    positions: [
      { debate: 'Lattes vs big wins', stance: 'Fix rent, car and subscriptions first; small treats stay.' },
      { debate: 'Side hustles', stance: 'Optional. A plan for the pay you have comes first.' },
      { debate: 'Credit cards', stance: 'A tool if paid in full; a trap if not. No shame either way.' },
      { debate: 'Investing', stance: 'General education only: index-fund basics, never picks.' },
    ],
    softPositions: [
      { debate: 'Lattes vs big wins', stance: 'Keep the treat, cut the leak you never notice.' },
      { debate: 'Side hustles', stance: 'Fine if you want one; never required.' },
      { debate: 'Credit cards', stance: 'Pay in full or park it in a drawer.' },
      { debate: 'Investing', stance: 'Learn the basics; we never name what to buy.' },
    ],
    worldview: ['Money is a tool, not a moral score', 'A plan beats willpower', 'Small rules, kept, beat big rules, broken', 'Nobody gets shamed here', 'Spend on purpose, then stop thinking about it', 'Typical results, never promises'],
    keywords: ['PLAN', 'NOBUY', 'PAYDAY'],
    fieldTopics: ['Zero-based budgeting', 'Paycheck-to-paycheck budgeting', 'Sinking funds', 'No-buy challenges and behaviour', 'Emergency funds', 'Debt avalanche vs snowball', 'Index funds (general education)', 'Consumer psychology of sales', 'Subscription creep', 'Financial-promotion rules (FCA/FTC)'],
    feeds: [
      { name: 'Personal finance news', query: 'personal finance budgeting' },
      { name: 'No-buy trend', query: 'no-buy challenge' },
    ],
    timezone: 'America/New_York',
  },
  {
    key: 'dating',
    subNiche: 'situationship exits and texting scripts',
    angle: 'Scripts for the hard texts: ending situationships, asking where it is going, holding the line',
    audience: 'Women 22–38 stuck in situationships; heavy texters; cuffing-season searchers',
    object: 'text thread',
    noise: '"make him chase" manipulation coaches',
    trigger: 'Read a 41-message thread that ended in "u up?".',
    myths: ['Wait three days to text back', 'If he wanted to, he would (always)', 'Closure has to come from him'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is how to end it in one text.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'The 9-word text that ends a situationship.',
      'He came back. Here is exactly what to say.',
      'Cuffing season rule number one.',
    ],
    evidence: [
      { signal: 'demand', detail: '"Bird Theory" and situationship content: one video hit 56M views', flag: 'L', source: 'fastcompany.com' },
      { signal: 'intent', detail: 'Couples-card and script PDFs sell at $3–16; workbooks to $27', flag: 'V', source: 'Gumroad; Etsy' },
      { signal: 'competition', detail: 'No AI dating persona at scale; human coaches crowd "get your ex back"', flag: 'U' },
      { signal: 'seasonality', detail: 'Cuffing season Oct–Feb; Valentine\'s Day', flag: 'L' },
    ],
    buyingMoments: ['Cuffing season (Oct–Feb)', "Valentine's Day", 'New Year resolutions'],
    risks: ['No manipulation tactics', 'Romance-scam awareness, never victim-blaming', 'No personal counselling'],
    base: { demand: 9, intent: 7, competition: 6, seasonality: 8 },
    lineSafety: 8,
    pillars: [
      { name: 'Exact words', why: 'Scripts are what people save and buy' },
      { name: 'Read the thread', why: 'Rating real situations drives comments' },
      { name: 'Self-respect rules', why: 'The values that make the character trusted' },
    ],
    seriesB: { name: 'Read It Back', format: 'activity_text' },
    products: {
      lead: 'The 5 Texts That End It',
      entry: ['The Situationship Exit Kit', 1500],
      addon: ['The Lock-Screen Rules Pack', 500],
      core: ['The Dating Standards System', 3500],
      upsell: ['The First-Date Script Book', 1900],
      membership: ['The Sunday Debrief Club', 800],
    },
    briefSections: ['Decide: the scorecard', 'Ask first (if you want to)', 'The exit scripts', 'When he comes back', 'The 72-hour plan', 'The urge log'],
    positions: [
      { debate: 'Ghosting', stance: 'Rude after a date or two; a clean text costs nothing.' },
      { debate: 'Texting first', stance: 'Text when you want to. Games waste months.' },
      { debate: 'Closure', stance: 'You give it to yourself, in writing.' },
      { debate: 'Dating apps', stance: 'Fine as a door; never as the whole house.' },
    ],
    softPositions: [
      { debate: 'Ghosting', stance: 'Understandable when you feel unsafe; otherwise send the text.' },
      { debate: 'Texting first', stance: 'Nothing to lose but the waiting.' },
      { debate: 'Closure', stance: 'Nice when it comes; not required to move on.' },
      { debate: 'Dating apps', stance: 'Use them with rules, not hope.' },
    ],
    worldview: ['Clarity is kind', 'Your time is the price; spend it on purpose', 'No games, no chasing', 'Exits are a skill', 'Safety first, always', 'Opinion and entertainment, not counselling'],
    keywords: ['EXIT', 'SCRIPT', 'READ'],
    fieldTopics: ['Attachment styles (evidence and limits)', 'Situationships', 'Breakup recovery', 'Texting norms', 'Romance scams', 'First dates', 'Boundaries', 'Dating-app behaviour research'],
    feeds: [
      { name: 'Dating news', query: 'dating trends' },
      { name: 'Romance scams', query: 'romance scam FTC' },
    ],
    timezone: 'America/New_York',
  },
  {
    key: 'food',
    subNiche: 'cheap proper meals and food myths',
    angle: 'Real food on a budget, and the myths that cost you money',
    audience: 'Busy adults 25–50 feeding themselves or a family on a budget; myth-tired scrollers',
    object: '"what I eat in a day"',
    noise: 'powders, "cortisol cocktails" and supplement-linked guides',
    trigger: 'Watched a "cortisol cocktail" get two million likes.',
    myths: ['You need protein powder', 'Frozen veg is worse', 'Eating late makes you gain'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is a proper breakfast.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'The $3 lunch that beats your powder.',
      'Cook once, eat three times.',
      'The shopping list I would give my own kids.',
    ],
    evidence: [
      { signal: 'demand', detail: '"What I eat in a day" and myth-bust formats are evergreen reach', flag: 'L' },
      { signal: 'intent', detail: 'Meal-plan and batch-cook PDFs sell at $10–35', flag: 'L' },
      { signal: 'competition', detail: 'The AI "wise elder heals you" lane is crowded (250-profile network): stay with food, not cures', flag: 'V', source: 'maldita.es' },
      { signal: 'seasonality', detail: 'January reset; back-to-school lunches', flag: 'L' },
    ],
    buyingMoments: ['January reset', 'Back to school (Aug–Sep)', 'Spring reset'],
    risks: ['No claims to treat or cure', 'Every myth-bust must be accurate and cited', 'No supplement efficacy claims'],
    base: { demand: 8, intent: 6, competition: 5, seasonality: 7 },
    lineSafety: 7,
    pillars: [
      { name: 'Myth-busts', why: 'Reach: the trend gets a verdict' },
      { name: 'Cheap proper meals', why: 'Saves and the product promise' },
      { name: 'Old-ways food', why: 'The character\'s authority' },
    ],
    seriesB: { name: 'Proper or Pricey', format: 'voiceover' },
    products: {
      lead: 'The £1 Shopping List',
      entry: ['The 30-Day Proper Food Reset', 1500],
      addon: ['The Batch-Cook Labels', 500],
      core: ['The Cook Once Eat Twice Book', 3500],
      upsell: ['The Lunchbox Year', 1900],
      membership: ['The Weekly Menu Club', 700],
    },
    briefSections: ['The plate rules', 'The shopping list', 'Four weeks of dinners', 'Batch-cook Sundays', 'Lunches that travel', 'The myth sheet'],
    positions: [
      { debate: 'Protein powder', stance: 'Fine if you like it; beans and eggs do the job for less.' },
      { debate: 'Frozen food', stance: 'Frozen veg is proper veg.' },
      { debate: 'Ultra-processed food', stance: 'Cook more where you can; no shame for the rest.' },
      { debate: 'Diet trends', stance: 'Rate the trend, not the person.' },
    ],
    softPositions: [
      { debate: 'Protein powder', stance: 'A convenience, not a necessity.' },
      { debate: 'Frozen food', stance: 'Cheaper, wastes less, just as good.' },
      { debate: 'Ultra-processed food', stance: 'Swap one meal a week and see.' },
      { debate: 'Diet trends', stance: 'Try it if you want; here is what it costs.' },
    ],
    worldview: ['Proper food is cheap food', 'No food is evil', 'Cook once, eat twice', 'Trends get rated, people do not', 'General information, never treatment', 'Waste nothing'],
    keywords: ['LIST', 'PLATE', 'RESET'],
    fieldTopics: ['Protein needs (general guidance)', 'Frozen vs fresh nutrition', 'Ultra-processed food evidence', 'Food budgeting', 'Batch cooking and food safety', 'Fibre', 'Hydration myths', 'Diet-trend debunks'],
    feeds: [
      { name: 'Nutrition news', query: 'nutrition study diet' },
      { name: 'Food prices', query: 'food prices grocery' },
    ],
    timezone: 'Europe/London',
  },
  {
    key: 'fitness',
    subNiche: 'strength and balance after 50',
    angle: 'Strength after 50 without a gym: getting up, carrying, balancing, walking',
    audience: 'Adults 45–70 and their grown children; walkers; people told to "take it easy"',
    object: 'workout',
    noise: 'chair yoga for everyone and 25-year-old trainers',
    trigger: 'Was offered chair yoga by a trainer half her age.',
    myths: ['After 60 you should rest', 'Strength training is for the young', 'Walking is not exercise'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Getting off the floor is a skill.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'Japanese interval walking, done properly.',
      'Carry your shopping like this.',
      'Three moves before your coffee.',
    ],
    evidence: [
      { signal: 'trend', detail: 'Interval walking went viral (Fortune, 2025)', flag: 'V', source: 'fortune.com' },
      { signal: 'intent', detail: '30-day challenge PDFs and trackers sell at $12–19', flag: 'L' },
      { signal: 'competition', detail: 'Elder fitness accounts exist but few with a character premise', flag: 'U' },
      { signal: 'seasonality', detail: 'January reset; spring', flag: 'L' },
    ],
    buyingMoments: ['January reset', 'Spring', "Mother's and Father's Day gifts"],
    risks: ['No medical advice; "check with your doctor" for conditions', 'No dangerous practices', 'No cure claims'],
    base: { demand: 7, intent: 7, competition: 6, seasonality: 7 },
    lineSafety: 7,
    pillars: [
      { name: 'Everyday strength', why: 'Getting up, carrying, stairs: the promise' },
      { name: 'Balance', why: 'Fear of falling is the buying trigger' },
      { name: 'Walking', why: 'The trend that brings reach' },
    ],
    seriesB: { name: 'Myth or Muscle', format: 'activity_text' },
    products: {
      lead: 'The 3-Move Morning Card',
      entry: ['The 30-Day Get-Up Challenge', 1500],
      addon: ['The Walking Log', 500],
      core: ['The Strong at Any Age System', 3900],
      upsell: ['The Balance Builder', 1900],
      membership: ['The Monday Moves Club', 800],
    },
    briefSections: ['Before you start', 'The three moves', 'Week-by-week plan', 'The walking intervals', 'The balance ladder', 'The progress log'],
    positions: [
      { debate: 'Rest after 60', stance: 'Rest is part of training, not a replacement for it.' },
      { debate: 'Gyms', stance: 'Nice, never needed: the floor and a bag of shopping do it.' },
      { debate: 'Step counts', stance: '10,000 is a slogan; more than yesterday is a plan.' },
      { debate: 'Pain', stance: 'Discomfort is fine; pain means stop and ask a professional.' },
    ],
    softPositions: [
      { debate: 'Rest after 60', stance: 'Move a little, often.' },
      { debate: 'Gyms', stance: 'Go if you like it; home works too.' },
      { debate: 'Step counts', stance: 'Count if it helps you; ignore it if it nags.' },
      { debate: 'Pain', stance: 'Never push through pain.' },
    ],
    worldview: ['Bones are for using', 'Strength is independence', 'Start where you are', 'Little and often beats heroic', 'General fitness, never medical advice', 'Nobody is too old to start'],
    keywords: ['MOVES', 'WALK', 'STRONG'],
    fieldTopics: ['Sarcopenia (general)', 'Balance and falls (general)', 'Interval walking', 'Resistance training basics', 'Recovery', 'Bone density (general)', 'Habit formation', 'Mobility'],
    feeds: [
      { name: 'Healthy ageing news', query: 'strength training older adults study' },
      { name: 'Walking trend', query: 'interval walking' },
    ],
    timezone: 'America/Chicago',
  },
  {
    key: 'sleep',
    subNiche: 'calm bedtimes without sleepmaxxing',
    angle: 'Plain sleep habits for anxious scrollers, against the gadget-and-supplement sleepmaxxing trend',
    audience: 'Adults 22–45 who scroll at night, shift workers, new parents',
    object: 'bedtime routine',
    noise: 'gadget-selling sleepmaxxers and 11-supplement stacks',
    trigger: 'Saw a "sleepmaxxing" stack with eleven supplements and a mouth tape.',
    myths: ['You need eight hours exactly', 'Mouth tape fixes sleep', 'Melatonin is harmless candy'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is your wind-down.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'The 20-minute rule nobody told you.',
      'Your phone goes to bed first.',
      'Sleepmaxxing, rated.',
    ],
    evidence: [
      { signal: 'trend', detail: 'Sleepmaxxing is a live trend, with experts warning it can worsen insomnia', flag: 'L', source: 'malaymail.com' },
      { signal: 'intent', detail: 'Sleep trackers, journals and 14-day resets sell as printables at $9–19', flag: 'U' },
      { signal: 'competition', detail: 'Mostly gadget and supplement sellers; a calm anti-hype character is a gap', flag: 'U' },
      { signal: 'seasonality', detail: 'The dark months (Nov–Feb); clocks changing; January', flag: 'L' },
    ],
    buyingMoments: ['Clocks changing', 'The dark months', 'January reset'],
    risks: ['No treatment claims for insomnia or apnoea', 'No supplement efficacy claims', 'Refer real sleep problems to a doctor'],
    base: { demand: 7, intent: 6, competition: 7, seasonality: 7 },
    lineSafety: 8,
    pillars: [
      { name: 'Wind-down rituals', why: 'The routine people buy' },
      { name: 'Trend ratings', why: 'Reach from the sleepmaxxing debate' },
      { name: 'Night-shift wisdom', why: 'The character\'s lived authority' },
    ],
    seriesB: { name: 'Lights Out', format: 'voiceover' },
    products: {
      lead: 'The Wind-Down Card',
      entry: ['The 14-Night Wind-Down Reset', 1500],
      addon: ['The Bedside Notebook Pages', 500],
      core: ['The Calm Nights System', 3500],
      upsell: ['The Shift-Worker Sleep Planner', 1900],
      membership: ['The Sunday Night Club', 700],
    },
    briefSections: ['How the reset works', 'The wind-down card', 'Fourteen nights, one change each', 'The worry page', 'Mornings that help nights', 'When to see a doctor'],
    positions: [
      { debate: 'Eight hours', stance: 'A range, not a rule; how you feel matters more.' },
      { debate: 'Sleep trackers', stance: 'Useful until they keep you awake.' },
      { debate: 'Supplements', stance: 'Not our department: ask a pharmacist.' },
      { debate: 'Naps', stance: 'Short and early, or not at all.' },
    ],
    softPositions: [
      { debate: 'Eight hours', stance: 'Most adults need seven to nine; find yours.' },
      { debate: 'Sleep trackers', stance: 'Glance in the morning, never at night.' },
      { debate: 'Supplements', stance: 'We stick to habits.' },
      { debate: 'Naps', stance: 'Twenty minutes, before three.' },
    ],
    worldview: ['Calm is a skill', 'Habits before gadgets', 'Nobody sleeps perfectly', 'Your phone is not a nightlight', 'General habits, never treatment', 'Boring is beautiful at bedtime'],
    keywords: ['CALM', 'NIGHT', 'RESET'],
    fieldTopics: ['Sleep hygiene evidence', 'CBT-I (general awareness)', 'Light and circadian rhythm', 'Caffeine timing', 'Shift work and sleep', 'Sleep trackers', 'Naps', 'When to see a doctor'],
    feeds: [
      { name: 'Sleep research news', query: 'sleep study research' },
      { name: 'Sleepmaxxing', query: 'sleepmaxxing' },
    ],
    timezone: 'America/New_York',
  },
  {
    key: 'career',
    subNiche: 'raises, negotiation and work scripts',
    angle: 'The exact words for asking for a raise, saying no and leaving well',
    audience: 'Employees 24–40, under-paid or over-loaded, conflict-avoidant',
    object: 'raise request',
    noise: 'hustle-culture CEOs and quit-your-job courses',
    trigger: 'Heard a 30-year-old say "I could never ask for more money".',
    myths: ['Asking for a raise is rude', 'Loyalty gets rewarded', 'Never say no to your boss'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is how you ask for more.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'The one sentence that gets you a raise meeting.',
      'Say no to your boss in nine words.',
      'Performance review season: bring this.',
    ],
    evidence: [
      { signal: 'demand', detail: 'Raise scripts and salary-negotiation content trend at review season', flag: 'L' },
      { signal: 'intent', detail: 'Script packs and career workbooks sell at $9–29', flag: 'U' },
      { signal: 'competition', detail: 'Human coaches and LinkedIn creators; no character-led account', flag: 'U' },
      { signal: 'seasonality', detail: 'Review season (Dec–Mar); graduation May–Jun', flag: 'L' },
    ],
    buyingMoments: ['Performance-review season', 'Graduation (May–Jun)', 'January job moves'],
    risks: ['No individual legal or employment advice', 'No income guarantees'],
    base: { demand: 7, intent: 7, competition: 6, seasonality: 6 },
    lineSafety: 9,
    pillars: [
      { name: 'Exact words', why: 'Scripts get saved and bought' },
      { name: 'Power moves', why: 'Reach from confident takes' },
      { name: 'Leaving well', why: 'Trust and long-term loyalty' },
    ],
    seriesB: { name: 'Say It Back', format: 'activity_text' },
    products: {
      lead: 'The Raise Request Email',
      entry: ['The Raise Conversation Kit', 1500],
      addon: ['The Wins Log', 500],
      core: ['The Career Negotiation System', 3900],
      upsell: ['The Interview Answer Bank', 2400],
      membership: ['The Monday Career Club', 800],
    },
    briefSections: ['Know your number', 'The wins log', 'The request scripts', 'Handling "not now"', 'Saying no', 'Leaving well'],
    positions: [
      { debate: 'Loyalty', stance: 'Be loyal to people, not to pay bands.' },
      { debate: 'Job hopping', stance: 'Fine with a story; stay long enough to finish something.' },
      { debate: 'Salary transparency', stance: 'Share numbers with peers; it helps everyone.' },
      { debate: 'Hustle culture', stance: 'Work hard, then go home.' },
    ],
    softPositions: [
      { debate: 'Loyalty', stance: 'Loyalty is earned both ways.' },
      { debate: 'Job hopping', stance: 'Move when you stop learning.' },
      { debate: 'Salary transparency', stance: 'Know the market before you ask.' },
      { debate: 'Hustle culture', stance: 'Rest is part of performance.' },
    ],
    worldview: ['Asking is a skill, not a sin', 'Write your wins down', 'Calm beats clever in a negotiation', 'Leave well, always', 'General guidance, not legal advice', 'Your time has a price'],
    keywords: ['RAISE', 'SCRIPT', 'WINS'],
    fieldTopics: ['Salary negotiation research', 'Pay transparency laws (general)', 'Performance reviews', 'Burnout', 'Job search', 'Workplace communication', 'Resignation etiquette', 'Interview technique'],
    feeds: [
      { name: 'Workplace news', query: 'salary raise workplace survey' },
      { name: 'Pay transparency', query: 'pay transparency law' },
    ],
    timezone: 'America/New_York',
  },
  {
    key: 'study',
    subNiche: 'study systems and exam calm',
    angle: 'Old-school study systems for distracted students and adult learners',
    audience: 'Students 16+ (adult-facing), university students, adults retraining',
    object: 'study plan',
    noise: 'aesthetic study vlogs and productivity apps',
    trigger: 'Watched a "study with me" video with no studying in it.',
    myths: ['Highlighting is studying', 'Cramming works', 'You need the perfect app'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is how memory actually works.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'The 25-minute rule, done properly.',
      'Close the app. Open a card.',
      'Exam week, rated.',
    ],
    evidence: [
      { signal: 'demand', detail: 'Study-with-me and study-tips content is evergreen; peaks at exams', flag: 'L' },
      { signal: 'intent', detail: 'Study planners on Etsy sell at $8–30', flag: 'L' },
      { signal: 'competition', detail: 'Aesthetic study creators crowd it; few teach retrieval practice plainly', flag: 'U' },
      { signal: 'seasonality', detail: 'Back to school Aug–Sep; exam seasons', flag: 'L' },
    ],
    buyingMoments: ['Back to school (Aug–Sep)', 'January exams', 'May–Jun exams'],
    risks: ['Audience must be adult-facing (no content targeting under-18s)', 'No credential claims'],
    base: { demand: 6, intent: 6, competition: 6, seasonality: 8 },
    lineSafety: 9,
    pillars: [
      { name: 'How memory works', why: 'The authority' },
      { name: 'Study systems', why: 'The product promise' },
      { name: 'Exam calm', why: 'The buying trigger' },
    ],
    seriesB: { name: 'Overdue', format: 'activity_text' },
    products: {
      lead: 'The One-Week Revision Grid',
      entry: ['The Active Recall Card Kit', 1200],
      addon: ['The Exam Countdown Sheet', 500],
      core: ['The Study System Planner', 2900],
      upsell: ['The Essay Plan Pack', 1900],
      membership: ['The Sunday Study Hall', 700],
    },
    briefSections: ['How the cards work', 'Making cards fast', 'The spacing calendar', 'Practice tests', 'The exam-week plan', 'Calm on the day'],
    positions: [
      { debate: 'Highlighting', stance: 'Feels like work, mostly is not.' },
      { debate: 'Music while studying', stance: 'Instrumental at most.' },
      { debate: 'Study apps', stance: 'Paper first; apps if they stay out of the way.' },
      { debate: 'All-nighters', stance: 'Sleep is part of revision.' },
    ],
    softPositions: [
      { debate: 'Highlighting', stance: 'Use it to find what to test yourself on.' },
      { debate: 'Music while studying', stance: 'Whatever keeps you at the desk, nothing with words.' },
      { debate: 'Study apps', stance: 'One app, not five.' },
      { debate: 'All-nighters', stance: 'Never before an exam.' },
    ],
    worldview: ['Testing beats rereading', 'Little and often', 'Boring systems win', 'Calm is preparation', 'Everyone can learn how to learn', 'No shortcuts, only methods'],
    keywords: ['CARDS', 'PLAN', 'EXAM'],
    fieldTopics: ['Retrieval practice', 'Spaced repetition', 'Interleaving', 'Sleep and memory', 'Exam anxiety (general)', 'Note-taking methods', 'Pomodoro', 'Procrastination'],
    feeds: [
      { name: 'Learning science news', query: 'learning science study memory' },
      { name: 'Exam news', query: 'exam season students' },
    ],
    timezone: 'Europe/London',
  },
  {
    key: 'home',
    subNiche: 'decluttering and home resets',
    angle: 'Weekly home resets and decluttering rules for small spaces and busy people',
    audience: 'Renters and parents 25–50 in small homes; overwhelmed tidiers',
    object: 'cupboard',
    noise: 'buy-more organising hauls and minimalist guilt',
    trigger: 'Saw a "declutter haul" of 40 new storage boxes.',
    myths: ['Organising means buying boxes', 'Minimalism means owning nothing', 'You need a whole weekend'],
    hooks: [
      '"{myth}"? {retort}',
      '{years} years of {unit}. Here is a ten-minute reset.',
      'Rating your {object}: {verdictA} or {verdictB}?',
      'One bag, one drawer, one rule.',
      'The Sunday reset in four moves.',
      'Before you buy another box.',
    ],
    evidence: [
      { signal: 'demand', detail: 'Reset and declutter content peaks with spring and January resets', flag: 'L' },
      { signal: 'intent', detail: 'Cleaning schedules and declutter checklists sell at $5–20', flag: 'L' },
      { signal: 'competition', detail: 'Crowded with haul creators; anti-haul characters are rare', flag: 'U' },
      { signal: 'seasonality', detail: 'January and spring resets; moving season', flag: 'L' },
    ],
    buyingMoments: ['January reset', 'Spring reset (Mar)', 'Moving season (summer)'],
    risks: ['No product claims without disclosure', 'Affiliate links always disclosed'],
    base: { demand: 7, intent: 6, competition: 5, seasonality: 8 },
    lineSafety: 10,
    pillars: [
      { name: 'Ten-minute resets', why: 'Saves and repeat views' },
      { name: 'Declutter rules', why: 'The system people buy' },
      { name: 'Anti-haul takes', why: 'Reach from contrast' },
    ],
    seriesB: { name: 'Keep or Go', format: 'activity_text' },
    products: {
      lead: 'The Ten-Minute Reset Card',
      entry: ['The 30-Day Declutter Plan', 1200],
      addon: ['The Label Pack', 500],
      core: ['The Whole-Home Reset System', 2900],
      upsell: ['The Moving House Planner', 1900],
      membership: ['The Sunday Reset Club', 700],
    },
    briefSections: ['The rules', 'One room a week', 'The keep-or-go test', 'The ten-minute reset', 'Maintenance', 'The donation list'],
    positions: [
      { debate: 'Storage boxes', stance: 'Declutter first, buy boxes never (or last).' },
      { debate: 'Minimalism', stance: 'Keep what you use and love; that is the whole rule.' },
      { debate: 'Cleaning schedules', stance: 'Little and daily beats a lost Saturday.' },
      { debate: 'Sentimental items', stance: 'One box, chosen on purpose.' },
    ],
    softPositions: [
      { debate: 'Storage boxes', stance: 'Only for what is left after the cull.' },
      { debate: 'Minimalism', stance: 'Enough, not empty.' },
      { debate: 'Cleaning schedules', stance: 'Ten minutes a day.' },
      { debate: 'Sentimental items', stance: 'Photograph, then decide.' },
    ],
    worldview: ['Less stuff, more life', 'Ten minutes counts', 'Systems beat motivation', 'No guilt, only next steps', 'Do not buy your way tidy', 'A home is for living'],
    keywords: ['RESET', 'KEEP', 'TIDY'],
    fieldTopics: ['Decluttering methods', 'Habit stacking', 'Small-space storage', 'Cleaning routines', 'Donation and resale', 'Clutter and stress (general)', 'Moving house', 'Sentimental items'],
    feeds: [
      { name: 'Home trends', query: 'decluttering home organisation trend' },
      { name: 'Spring cleaning', query: 'spring cleaning reset' },
    ],
    timezone: 'America/Chicago',
  },
];

export interface Archetype {
  key: string;
  role: string;
  pronoun: 'she' | 'he';
  years: number;
  age: number;
  unit: string;
  ritual: string;
  verdicts: [string, string];
  retort: string;
  retorts: string[];
  signOff: string;
  authority: string;
  anchors: string[];
  wardrobe: string[];
  settings: string[];
  palette: Array<{ name: string; hex: string }>;
  hue: number;
  voice: string;
  voiceAlts: [string, string];
  personality: string[];
  personalityAlt: string[];
  lore: string;
  loreAlt: string;
  homeBases: string[];
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    key: 'atc',
    role: 'air-traffic controller',
    pronoun: 'she',
    years: 34,
    age: 72,
    unit: 'night shifts in the tower',
    ritual: 'Clearance Check',
    verdicts: ['cleared to land', 'holding pattern'],
    retort: 'Not on my runway.',
    retorts: ['Go around, love.', 'Negative. Try again.', 'Say again? No.'],
    signOff: 'Wheels down, lights off.',
    authority: 'calm under pressure from keeping hundreds of planes apart',
    anchors: ['headset round her neck', 'aviator reading glasses', 'laminated checklist'],
    wardrobe: ['navy cardigan over a white shirt', 'grey fleece with a faded tower badge', 'striped pyjama shirt for night posts'],
    settings: ['kitchen table set like a radar desk', 'armchair by a window at dusk', 'bedside with a reading lamp'],
    palette: [{ name: 'Tower navy', hex: '#1F3A5F' }, { name: 'Runway amber', hex: '#E0A030' }, { name: 'Chalk', hex: '#F2EFE8' }, { name: 'Slate', hex: '#5B6770' }],
    hue: 212,
    voice: 'low, unhurried, clipped radio calm',
    voiceAlts: ['warmer and slower, a grandmother at bedtime', 'drier and faster, a supervisor on a busy night'],
    personality: ['unflappable', 'precise', 'dry', 'protective'],
    personalityAlt: ['warm under the procedure', 'nosy', 'competitive about checklists', 'secretly sentimental'],
    lore: 'Worked nights at a regional airport tower for 34 years and retired the month the night shift was automated. Still wakes at 3 a.m. to check the weather. A running storyline: she is "re-certifying" her own sleep, one checklist at a time.',
    loreAlt: 'Ran the tower at a small island airport; the islanders still call her when a storm comes. Running storyline: her grandson set up the account and she has opinions about the algorithm.',
    homeBases: ['a bungalow under the flight path, Ohio', 'a seaside flat near a small airfield, Maine'],
  },
  {
    key: 'croupier',
    role: 'casino croupier',
    pronoun: 'he',
    years: 38,
    age: 70,
    unit: 'nights dealing blackjack',
    ritual: 'The House Always Knows',
    verdicts: ['the house wins', 'you win this hand'],
    retort: 'The house thanks you.',
    retorts: ['Place your bets elsewhere.', 'That is a sucker bet.', 'The odds just laughed.'],
    signOff: 'Cash out while you are ahead.',
    authority: 'four decades of watching people lose money on hope',
    anchors: ['green dealer visor', 'sleeve garters', 'a deck of cards always in hand'],
    wardrobe: ['black waistcoat and white shirt', 'burgundy cardigan', 'casino-floor bow tie for Fridays'],
    settings: ['green-felt card table at home', 'late-night diner booth', 'study with a ledger and a lamp'],
    palette: [{ name: 'Felt green', hex: '#1E5631' }, { name: 'Chip red', hex: '#B3262E' }, { name: 'Ivory', hex: '#F4EFE3' }, { name: 'Brass', hex: '#B08D57' }],
    hue: 145,
    voice: 'smooth, low, a little gravel, never rushed',
    voiceAlts: ['lighter, a showman calling the table', 'quieter, a confidant after the shift'],
    personality: ['wry', 'observant', 'honest about odds', 'old-school gentleman'],
    personalityAlt: ['theatrical', 'sentimental about regulars', 'pedantic about maths', 'kind to losers'],
    lore: 'Dealt blackjack on the night shift for 38 years and watched every system fail. Retired, he deals one hand a day to himself to stay sharp. Running storyline: he is "auditing" the viewers\' choices like a pit boss.',
    loreAlt: 'Spent his career on cruise-ship casinos; has a story for every port. Running storyline: he is teaching his niece to read odds before she reads ads.',
    homeBases: ['an apartment off the old strip, Atlantic City', 'a condo near the river, New Orleans'],
  },
  {
    key: 'judge',
    role: 'family-court clerk',
    pronoun: 'she',
    years: 36,
    age: 74,
    unit: 'hearings in a busy courtroom',
    ritual: 'Order in the Comments',
    verdicts: ['sustained', 'overruled'],
    retort: 'Overruled.',
    retorts: ['The court is not amused.', 'Strike that from the record.', 'Objection noted. Denied.'],
    signOff: 'Court is adjourned. Drink some water.',
    authority: 'decades of hearing every excuse and every apology',
    anchors: ['half-moon reading glasses', 'wooden gavel', 'pearl necklace'],
    wardrobe: ['black cardigan with a lace collar', 'plum blazer', 'reading shawl'],
    settings: ['wood-panelled study', 'kitchen table "bench"', 'porch rocking chair'],
    palette: [{ name: 'Gavel walnut', hex: '#5A3A22' }, { name: 'Robe black', hex: '#1B1B1E' }, { name: 'Pearl', hex: '#EEE9E0' }, { name: 'Plum', hex: '#6B2D5C' }],
    hue: 300,
    voice: 'measured, crisp, the occasional dry pause',
    voiceAlts: ['warmer, a favourite aunt', 'sharper, cross-examination pace'],
    personality: ['fair', 'unshockable', 'deadpan', 'secretly romantic'],
    personalityAlt: ['impatient with nonsense', 'generous with second chances', 'nosy', 'theatrical when it counts'],
    lore: 'Clerked in a busy family court for 36 years (fictional; never a judge or a lawyer). Has heard every excuse. Running storyline: she has opened "the court of the comments" and hears one case a day.',
    loreAlt: 'Kept the records office of a small-town courthouse and knows every story in town. Running storyline: her book club thinks she should write a memoir; she is drafting it on camera.',
    homeBases: ['a brownstone apartment, Philadelphia', 'a clapboard house near the courthouse, Georgia'],
  },
  {
    key: 'lighthouse',
    role: 'lighthouse keeper',
    pronoun: 'he',
    years: 31,
    age: 76,
    unit: 'winters keeping the light',
    ritual: 'Safe Harbour',
    verdicts: ['safe harbour', 'rocks ahead'],
    retort: 'Rocks ahead, friend.',
    retorts: ['Turn the ship.', 'That is a fog bank.', 'Not in this weather.'],
    signOff: 'Keep a light on.',
    authority: 'decades of patience, routine and watching the weather',
    anchors: ['white beard', 'brass pocket compass', 'knitted watch cap'],
    wardrobe: ['navy fisherman jumper', 'yellow oilskin', 'flannel shirt'],
    settings: ['lighthouse kitchen with a kettle', 'rocky shore at dusk', 'study with charts'],
    palette: [{ name: 'Sea navy', hex: '#1D3557' }, { name: 'Oilskin yellow', hex: '#F2C14E' }, { name: 'Foam', hex: '#F1FAEE' }, { name: 'Rust', hex: '#A8552C' }],
    hue: 205,
    voice: 'deep, slow, a soft coastal burr',
    voiceAlts: ['brighter, a storyteller at the pub', 'whispered, a late-night shipping forecast'],
    personality: ['patient', 'ritual-loving', 'dry humour', 'quietly stubborn'],
    personalityAlt: ['sentimental', 'gruff then gentle', 'precise about routines', 'a terrible singer'],
    lore: 'Kept a remote light for 31 years until it was automated, and never lost the habit of a nightly round. Running storyline: the light still blinks from his window and viewers ask what it means.',
    loreAlt: 'Ran a harbour light and the tea room beside it; knows every fisherman\'s superstition. Running storyline: he is writing a "keeper\'s log" for the internet.',
    homeBases: ['a cottage on the Cornish coast', 'a keeper\'s house on the Maine coast'],
  },
  {
    key: 'pitcrew',
    role: 'motor-racing pit-crew chief',
    pronoun: 'she',
    years: 29,
    age: 66,
    unit: 'race weekends in the pit lane',
    ritual: 'Box Box',
    verdicts: ['box box', 'stay out'],
    retort: 'Box, box. Now.',
    retorts: ['That is a slow stop.', 'Tyres are gone, love.', 'Wrong strategy.'],
    signOff: 'Lights out and away we go.',
    authority: 'split-second routines and engineering checklists',
    anchors: ['team radio headset', 'stopwatch on a lanyard', 'grease-mark on one cheek'],
    wardrobe: ['team-colour fire-proof jacket', 'black polo with a stopwatch', 'garage overalls'],
    settings: ['garage with a tool wall', 'kitchen with a stopwatch on the counter', 'trackside bench'],
    palette: [{ name: 'Pit orange', hex: '#E8590C' }, { name: 'Carbon', hex: '#212529' }, { name: 'Steel', hex: '#ADB5BD' }, { name: 'Flag white', hex: '#F8F9FA' }],
    hue: 22,
    voice: 'fast, clear, engineer\'s brevity with a laugh',
    voiceAlts: ['calmer, a debrief after the race', 'louder, race-day adrenaline'],
    personality: ['decisive', 'system-obsessed', 'cheeky', 'team-first'],
    personalityAlt: ['impatient', 'generous with credit', 'superstitious', 'loves a spreadsheet'],
    lore: 'Ran pit stops for 29 seasons and still times her morning kettle. Running storyline: she is "running strategy" for viewers\' lives one stop at a time.',
    loreAlt: 'Started as the only woman on a rally service crew; ended up running it. Running storyline: she is restoring an old hatchback on camera between takes.',
    homeBases: ['a terraced house near a race circuit, Northamptonshire', 'a ranch house outside Indianapolis'],
  },
  {
    key: 'shipcook',
    role: 'merchant-navy ship\'s cook',
    pronoun: 'he',
    years: 33,
    age: 71,
    unit: 'voyages feeding a crew of forty',
    ritual: 'Galley Inspection',
    verdicts: ['shipshape', 'walk the plank'],
    retort: 'Not in my galley.',
    retorts: ['That would not last a day at sea.', 'Mutiny, that.', 'Overboard.'],
    signOff: 'Eat well, sail far.',
    authority: 'feeding forty people on a budget for months at sea',
    anchors: ['white galley cap', 'anchor tattoo on the forearm', 'battered tin mug'],
    wardrobe: ['white galley jacket', 'striped Breton top', 'navy pea coat'],
    settings: ['small galley kitchen', 'harbour wall', 'allotment shed'],
    palette: [{ name: 'Galley white', hex: '#F5F5F0' }, { name: 'Breton blue', hex: '#264653' }, { name: 'Tomato', hex: '#E76F51' }, { name: 'Hull grey', hex: '#6C757D' }],
    hue: 195,
    voice: 'booming, cheerful, a sailor\'s swing',
    voiceAlts: ['softer, a story by the stove', 'gruffer, the bosun\'s bark'],
    personality: ['generous', 'loud', 'thrifty', 'superstitious'],
    personalityAlt: ['proud of leftovers', 'gentle with beginners', 'pun-addicted', 'stubborn about salt'],
    lore: 'Cooked on cargo ships for 33 years, feeding forty on a budget for months at a time. Running storyline: he is "provisioning" viewers for the week, one tin at a time.',
    loreAlt: 'Ran the galley on a research ship and cooked through two storms a season. Running storyline: he is trying to recreate every port\'s dish with supermarket basics.',
    homeBases: ['a terrace in a port town, Liverpool', 'a house on the harbour, Halifax'],
  },
  {
    key: 'guard',
    role: 'museum night guard',
    pronoun: 'she',
    years: 27,
    age: 68,
    unit: 'nights guarding paintings in the dark',
    ritual: 'Lights-Out Patrol',
    verdicts: ['all clear', 'alarm'],
    retort: 'Step away from the exhibit.',
    retorts: ['That sets off the alarm.', 'No flash photography, please.', 'Back behind the rope.'],
    signOff: 'Doors locked. Goodnight.',
    authority: 'decades of quiet nights, routines and noticing everything',
    anchors: ['big ring of keys', 'flashlight', 'navy guard cap'],
    wardrobe: ['navy guard uniform', 'oversized grey cardigan', 'silk scarf from the museum shop'],
    settings: ['gallery corridor at night', 'small flat with prints on the wall', 'security desk with monitors'],
    palette: [{ name: 'Gallery navy', hex: '#22223B' }, { name: 'Lamp gold', hex: '#C9A227' }, { name: 'Marble', hex: '#EDEDE9' }, { name: 'Velvet red', hex: '#9D0208' }],
    hue: 240,
    voice: 'hushed, amused, museum-quiet',
    voiceAlts: ['brighter, a tour guide on a good day', 'slower, a bedtime story'],
    personality: ['observant', 'calm', 'mischievous', 'loves rules'],
    personalityAlt: ['art-obsessed', 'gentle', 'a little spooky', 'fiercely loyal'],
    lore: 'Guarded a city museum at night for 27 years; knows which painting creaks. Running storyline: she does her "patrol" of viewers\' habits after the doors lock.',
    loreAlt: 'Worked nights at a natural-history museum and named every dinosaur. Running storyline: she claims the exhibits talk after midnight.',
    homeBases: ['a rent-controlled flat, Chicago', 'an apartment above a bakery, Boston'],
  },
  {
    key: 'auctioneer',
    role: 'livestock auctioneer',
    pronoun: 'he',
    years: 40,
    age: 73,
    unit: 'market days calling bids',
    ritual: 'Going Once',
    verdicts: ['sold', 'no sale'],
    retort: 'No sale.',
    retorts: ['I have heard better bids from a goat.', 'Going once, going nowhere.', 'Pass.'],
    signOff: 'Sold, and good luck to you.',
    authority: 'forty years of knowing what things are really worth',
    anchors: ['wide-brim hat', 'auction gavel', 'bolo tie'],
    wardrobe: ['tweed jacket and checked shirt', 'denim work shirt', 'market-day waxed coat'],
    settings: ['auction-ring podium', 'farmhouse kitchen', 'truck bench seat'],
    palette: [{ name: 'Tweed brown', hex: '#6F4E37' }, { name: 'Market red', hex: '#A4161A' }, { name: 'Hay', hex: '#E9C46A' }, { name: 'Denim', hex: '#3D5A80' }],
    hue: 30,
    voice: 'rapid when he wants it, slow and folksy when he does not',
    voiceAlts: ['faster, the full auction chant, then a grin', 'quieter, porch-talk slow'],
    personality: ['quick', 'shrewd', 'folksy', 'fair-dealing'],
    personalityAlt: ['showman', 'soft for animals', 'tight with money', 'storyteller'],
    lore: 'Called bids at county markets for 40 years and can price anything at a glance. Running storyline: he "auctions" viewers\' purchases to see what they were really worth.',
    loreAlt: 'Ran the family sale barn until it closed; now he auctions for charity. Running storyline: he is trying to sell his old truck and nobody will meet his price.',
    homeBases: ['a farmhouse outside Amarillo, Texas', 'a farm town in Iowa'],
  },
  {
    key: 'signal',
    role: 'railway signalwoman',
    pronoun: 'she',
    years: 30,
    age: 69,
    unit: 'shifts in the signal box',
    ritual: 'Green Light',
    verdicts: ['green light', 'red signal'],
    retort: 'Red signal. Stop there.',
    retorts: ['Points are wrong.', 'That train has left.', 'Wrong line, pet.'],
    signOff: 'Right away, driver.',
    authority: 'thirty years of timetables and nobody getting hurt',
    anchors: ['signal-box lever with a brass plate', 'pocket watch on a chain', 'orange hi-vis tabard'],
    wardrobe: ['orange hi-vis over a cardigan', 'railway-issue navy jumper', 'tartan scarf'],
    settings: ['signal box with levers', 'station café table', 'garden with a model railway'],
    palette: [{ name: 'Signal red', hex: '#C1121F' }, { name: 'Line green', hex: '#2D6A4F' }, { name: 'Hi-vis', hex: '#FB8500' }, { name: 'Cream', hex: '#FDF0D5' }],
    hue: 355,
    voice: 'Northern, brisk, kind',
    voiceAlts: ['slower, a station announcement', 'cheekier, a tea break'],
    personality: ['punctual', 'kind', 'blunt', 'rule-proud'],
    personalityAlt: ['nostalgic', 'competitive at quizzes', 'nosy', 'calm in a crisis'],
    lore: 'Worked a mechanical signal box for 30 years until the line went digital. Running storyline: she runs viewers\' weeks like a timetable, and the trains are always late.',
    loreAlt: 'Ran a rural station alone for decades and knew every passenger by name. Running storyline: she is building the station in miniature in her garden.',
    homeBases: ['a terraced house in Yorkshire', 'a cottage by a branch line in Northumberland'],
  },
  {
    key: 'bouncer',
    role: 'nightclub doorman',
    pronoun: 'he',
    years: 32,
    age: 67,
    unit: 'Friday nights on the door',
    ritual: 'On the List',
    verdicts: ['you\'re in', 'not tonight'],
    retort: 'Not tonight, mate.',
    retorts: ['Name is not down.', 'Try the pub across the road.', 'Shoes, mate. Shoes.'],
    signOff: 'Get home safe.',
    authority: 'thirty years of reading people in two seconds',
    anchors: ['earpiece', 'black bomber jacket', 'clicker counter'],
    wardrobe: ['black bomber and roll-neck', 'grey suit with no tie', 'cardigan on his day off'],
    settings: ['club door under a neon sign', 'kitchen with a kettle', 'allotment bench'],
    palette: [{ name: 'Door black', hex: '#14141A' }, { name: 'Neon pink', hex: '#FF4D8D' }, { name: 'Brick', hex: '#9C4A3C' }, { name: 'Steel grey', hex: '#8D99AE' }],
    hue: 330,
    voice: 'deep, calm, few words, sudden laugh',
    voiceAlts: ['softer, a dad at the school gate', 'gruffer, the door at 2 a.m.'],
    personality: ['protective', 'calm', 'blunt', 'softer than he looks'],
    personalityAlt: ['funny', 'reads people instantly', 'old-fashioned manners', 'loves his allotment'],
    lore: 'Worked the door of the same club for 32 years; the regulars still bring him cake. Running storyline: he is "on the door" of viewers\' lives and some things are not getting in.',
    loreAlt: 'Ran security for touring bands and has a story about every one. Running storyline: he is learning to bake and judging himself harshly.',
    homeBases: ['a flat in Manchester', 'a semi in Glasgow'],
  },
];

export const NAMES: Record<'she' | 'he', string[]> = {
  she: ['Vera Hollis', 'Marlene Okafor', 'Peggy Thornbury', 'Ines Calloway', 'Bernadette Quill', 'Lorraine Achebe', 'Ruth Pemberton', 'Gloria Vance', 'Edith Marlowe', 'Constance Reyes', 'Maeve Fairburn', 'Odile Hargreave'],
  he: ['Clement Ashby', 'Desmond Kowalczyk', 'Horace Bellamy', 'Rupert Nwosu', 'Felix Abernathy', 'Augustin Rourke', 'Barnaby Sheel', 'Cyril Mbeki-Hart', 'Lionel Fairweather', 'Ezra Pennick', 'Otto Larkspur', 'Hamish Doyle'],
};

/** Deterministic PRNG (mulberry32 over a string hash). */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` distinct items of `xs`, shuffled by `r`. */
export function pick<T>(xs: readonly T[], n: number, r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

export const nicheByKey = (key: string): NicheDef | undefined => NICHES.find((n) => n.key === key.toLowerCase());
export const archetypeByKey = (key: string | undefined): Archetype | undefined => ARCHETYPES.find((a) => a.key === key);

/** The closest niche for free text (the Owner's own idea), by keyword. */
export function nicheForText(text: string): NicheDef {
  const t = text.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/money|budget|wealth|sav(e|ing)|debt|spend|finance|invest|frugal|no.?buy/, 'wealth'],
    [/dat(e|ing)|relationship|situationship|texting|love|romance|breakup|ex\b/, 'dating'],
    [/food|cook|meal|recipe|kitchen|eat|nutrition|grocer/, 'food'],
    [/fitness|strength|walk|exercise|workout|gym|balance|mobility/, 'fitness'],
    [/sleep|bedtime|insomnia|night|rest\b|nap/, 'sleep'],
    [/career|job|raise|salary|work|boss|interview|negotiat/, 'career'],
    [/study|exam|school|learn|revision|student/, 'study'],
    [/home|declutter|clean|tidy|organis|organiz|house/, 'home'],
  ];
  for (const [re, key] of rules) if (re.test(t)) return nicheByKey(key)!;
  return NICHES[0]!;
}

export const fill = (tpl: string, vars: Record<string, string | number>): string => tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
export const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
