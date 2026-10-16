# The 2075 Calculator: lead magnet, ready to render

**Persona:** Margot from 2075 · **Keyword:** FUTURE · **Type:** free, email-gated web calculator (not a PDF) · **Live:** Sun 1 Nov 2026
**Matches:** bible §14.1 (inputs, the "Letter from Old You" email, the +1% table, the frank, the three next steps, the "never" list) and the build route (Tally → Vercel function → Supabase log → Resend), with the Google Sheet fallback.
**Spelling:** Margot's voice uses Irish/UK spelling ("apologise", "colour"). Amounts are bare numbers with no currency symbol, so they work in $, £, C$ and A$.

This file holds every word the user sees, in render order, plus the maths spec, the fallback sheet and the QA cases. Merge fields are in `{{double_braces}}`.

**Contents**
- A. The form page (Tally)
- B. The thank-you screen
- C. The maths (what the Vercel function computes)
- D. The email: "A Letter from Old You"
- E. Worked example (how D renders for a sample entry)
- F. The three next steps (the linked one-page guides)
- G. Fallback: the copyable Google Sheet
- H. QA: the test entries and expected outputs
- I. Companion freebie for keyword RAISE: the pay-meeting email

---

## A. The form page (Tally, on Margot's subdomain)

**Page title (browser tab):** The 2075 Calculator · Margot from 2075

**Header image:** the cream card with the rust Tempo Office frank in the top-right corner (`ILLUSTRATIVE · TEMPO OFFICE · 2075`), rotated −8°. Fraunces heading, DM Sans body, cream `#F3EDE1` background, deep-teal `#1F5C5A` text, rust `#B5562F` accents.

### Heading
**The 2075 Calculator**

### Subheading
Put in what you set aside now. I'll write back with what Old You is working with, on paper, franked and honest.

### Intro (3 short lines)
Five questions. No bank linking. No photos. No questions about your pay.
It takes about a minute, and the letter lands in your inbox straight away.
The numbers are illustrative. The Office makes me say that, and the Office is right.

### Field 1: Your age now
- **Label:** How old are you now?
- **Help text:** Whole years. I know the answer already, but the form doesn't.
- **Type:** number · **Required** · **Min** 18 · **Max** 79
- **Error (under 18):** This one's for grown-ups, a stór. Come back when you're 18.
- **Error (80 or over):** You're nearly me. Write to me instead; the calculator isn't built for that stretch.

### Field 2: What you set aside each month
- **Label:** Roughly how much do you set aside each month?
- **Help text:** Savings, workplace pension or retirement plan, anything you don't spend. A bare number, no currency sign. Zero is allowed. Zero is where most of us started.
- **Type:** number · **Required** · **Min** 0 · **Max** 20,000

### Field 3: What you've saved so far
- **Label:** What have you saved so far, all in?
- **Help text:** A rough number is grand. Zero is allowed.
- **Type:** number · **Required** · **Min** 0 · **Max** 5,000,000

### Field 4: Assumed yearly return
- **Label:** Assumed yearly return, after fees
- **Type:** slider · **Range** 2% to 7% · **Step** 0.5% · **Default** 5%
- **Text under the slider (always visible):** Illustrative assumption, after fees, not a promise. Real returns vary and can be negative. 5% is a middling guess for long-term, diversified money, not a forecast.

### Field 5: Inflation
- **Label:** Show it in today's money?
- **Type:** toggle · **Default** off
- **Help text:** On: I shrink the future numbers by an assumed 2.5% a year of rising prices, so they read like today's money. Off: the plain numbers, before inflation. Both are illustrative.

### Field 6: Your one percent (optional)
- **Label:** Optional: what's 1% of your monthly take-home, roughly?
- **Help text:** Leave it blank and I'll use 32 (1% of a 3,200 take-home). I don't need your pay and I don't store it; this one number just sizes the "one percent more" table.
- **Type:** number · **Optional** · **Min** 1 · **Max** 2,000 · **Blank →** 32

### Field 7: Email
- **Label:** Where shall I send the letter?
- **Type:** email · **Required**
- **Help text:** The letter comes from Margot from 2075. Then a handful of short letters over ten days. Unsubscribe any time with one click.

### Field 8: Consent (checkboxes)
- [ ] **Required:** Send me the letter and Margot's emails. I can unsubscribe any time. (Links: Privacy notice · Terms)
- [ ] **Shown to EU/EEA/UK visitors (geo-IP), required for them:** I confirm I'd like to receive these emails. (Double opt-in: the letter is sent after the confirm click.)

### Small print above the button
Margot is a fictional AI character. The maths is real, and the postmark means illustrative. This is general information, not advice for your situation. We never ask for bank details, statements or photos.

### Submit button
**Send it through the tube**

---

## B. The thank-you screen

**Heading:** It's in the tube.
**Body:** Your letter's on its way. Check your inbox in a minute or two (and the Promotions or Spam folder, because the Office's post is sometimes rude to filters).
If you're in the EU, EEA or UK, click the confirm link first. Then the letter comes.
**Line under it:** While you wait: open your banking app and look for any pot you can rename "Old Me". That's step one, and it takes forty seconds.
**Small print:** Illustrative maths. General info, not advice for your situation.

---

## C. The maths (spec for the Vercel function)

**Inputs:** `age` (A), `monthly` (P), `savings` (S), `rate` (r, as a decimal), `inflation_on` (bool), `one_pct` (Q, default 32).

**Constants:**
- Compounding: monthly. Monthly rate `m = r / 12`.
- Contributions continue until **age 67**, or for **5 years** if the person is already 62 or older. So `stop_age = max(67, A + 5)`.
- After `stop_age`: no contributions **and no withdrawals** (the table shows the shape on paper; in real life Old You spends some of it, which is the point of it).
- Inflation (when on): 2.5% a year. Deflator = `(1.025)^(years)`.

**Milestone ages:** 45, 55, 67 and 84. Show only the ages **greater than** A.

**Formula (loop, month by month, so the stop age is exact):**
```
balance = S
for k in 0 .. (target_age - A) * 12 - 1:
    balance = balance * (1 + m)
    if A + k/12 < stop_age:
        balance = balance + P
if inflation_on:
    balance = balance / (1.025 ^ (target_age - A))
display = round(balance, nearest 100)
```
The **+1% table** uses `P + Q` in place of `P`. Everything else is identical.

**Also computed:**
- `paid_in_67` = S + P × 12 × (years contributing up to 67): shown so people see how much is theirs vs growth.
- `gap_67` = the +1% balance at 67 minus the plain balance at 67 (or at the first milestone if they are 67 or older).
- If P = 0: the plain table still renders (savings growing alone) and line 2 of the letter switches to the zero version (see D).

**Validation and safety:**
- Reject non-numeric input server-side. Round everything to the nearest 100 for display; never show cents.
- No currency symbol anywhere.
- Log to Supabase: timestamp, the inputs, country (geo-IP, two letters), consent flags. **Not stored:** IP address, the one-percent figure (it is used for the sum and discarded).
- The formula is checked against the Investor.gov compound interest calculator before launch, using test case H1 with inflation off and the contributions stop disabled (the stop rule is our own).

**After computing:** add the contact to Margot's Resend audience with tag `calc`, send email D, and start the welcome sequence (`welcome-sequence.md`, email 2 onward).

---

## D. The email: "A Letter from Old You"

**From:** Margot from 2075
**Subject:** A letter from Old You
**Preview text:** Your sums, franked. Read it with the kettle on.

---

Dear you,

It's me. You. From 2075. The Office let this one through, so here are your sums, done properly, on paper.

You told me you're **{{age}}**, you set aside about **{{monthly}}** a month, and you've **{{savings}}** put by so far. I've assumed **{{rate}}%** a year after fees{{#if inflation_on}}, and shrunk everything into today's money at an assumed 2.5% a year of rising prices{{/if}}.

{{#if monthly_is_zero}}You put zero a month. That's not a telling-off, a stór. Zero is where we started too. Look at the second table; that's the one I care about.{{/if}}

**What Old You is working with (on paper)**

| At age | What you'd have, roughly |
|---|---|
{{#each milestones}}| {{age}} | {{plain}} |
{{/each}}

**What one percent more does (on paper)**
The same, with **{{one_pct}}** more a month: that's about one percent of a take-home{{#if one_pct_default}} of 3,200 (you can change it when you run it again){{/if}}.

| At age | With one percent more |
|---|---|
{{#each milestones}}| {{age}} | {{plus}} |
{{/each}}

That one percent is worth about **{{gap_67}}** by {{gap_age}}, on paper. It's the cheapest thing on this page.

Of the {{plain_67}} at 67, about **{{paid_in_67}}** is money you put in yourself. The rest is time doing the work. Time's the bit you can't buy later, which is why I'm writing now and not in 2060.

`[Footer image: the rust Tempo Office frank, ILLUSTRATIVE · TEMPO OFFICE · 2075]`

<small>Illustrative. Assumes {{rate}}% a year after fees, compounded monthly; contributions stop at {{stop_age}}; no withdrawals assumed after that{{#if inflation_on}}; adjusted for an assumed 2.5% a year of inflation{{else}}; not adjusted for inflation{{/if}}. Real returns vary and can be negative. Not a promise, and not advice for your situation.</small>

**Three things to do before your next payday**

1. **Set up the Three-Transfer Payday.** Three automatic transfers on payday, before you can see the money: Cushion, Old Me and Joy. [The one-page guide →]({{link_step1}})
2. **Check the match.** If your employer adds money when you do, make sure you're taking all of it. It's part of your pay. [What it's called where you are →]({{link_step2}})
3. **Hold a Subscription Funeral.** Last Sunday of the month: list every recurring charge, cancel the ones you wouldn't sign up for today, and send the freed money to Old Me the same day. [How to run one →]({{link_step3}})

Nobody can do it from 2075, a stór. Only you can, on payday.

I'm not cross. I'm just older.

Pay me first. I'm still here.
**Margot** (you, 84, Galway)

P.S. I'll write again in two days with the payday set-up, step by step. It takes about ten minutes once.

<small>Margot is a fictional AI character. The maths is real, and the postmark means illustrative. You're getting this because you asked for the 2075 Calculator. [Unsubscribe]({{unsubscribe}}) · Margot from 2075, {{postal_address}}</small>

---

## E. Worked example (how D renders)

**Sample entry:** age 31 · 150 a month · 2,000 saved · 5% · inflation off · one percent left blank (32).

| At age | What you'd have, roughly |
|---|---|
| 45 | 40,400 |
| 55 | 89,900 |
| 67 | 193,000 |
| 84 | 450,800 |

| At age | With one percent more (182 a month) |
|---|---|
| 45 | 48,200 |
| 55 | 107,600 |
| 67 | 231,600 |
| 84 | 541,000 |

- One percent more is worth about **38,600** by 67, on paper.
- Paid in by 67: 2,000 + 150 × 12 × 36 = **66,800**.
- Same entry with inflation **on**: 28,600 / 49,700 / 79,400 / 121,800, and with one percent more 34,100 / 59,500 / 95,200 / 146,200.

*Franked: ILLUSTRATIVE · TEMPO OFFICE · 2075. Assumes 5% a year after fees, compounded monthly; contributions stop at 67; no withdrawals after. Real returns vary and can be negative. Not a promise.*

---

## F. The three next steps (one-page guides linked from the letter)

Each is a plain web page on Margot's subdomain, same palette, printable. No sign-up wall (they've already given their email).

### F1. The Three-Transfer Payday (one page)

**Pay Old Me First. Ten minutes, once.**

Willpower is for people with more time than us. So we take it out of the decision: three transfers, set to go on payday, before you see the money.

**Step 1. Make three pots** in your banking app (or three savings accounts, if your bank doesn't do pots). Name them:
- **Cushion:** emergency cash. Boring, easy to reach.
- **Old Me:** long-term money. For most people this means your workplace plan first (see F2), then long-term savings.
- **Joy:** guilt-free spending money. Yes, it gets its own pot.

**Step 2. Pick starting amounts that don't sting.** A starting shape (change it to suit you):

| Pot | Starting point | Example on a 3,200 take-home |
|---|---|---|
| Cushion | 3% | 96 |
| Old Me | Enough to get any full employer match (through payroll), plus whatever you can | 128 |
| Joy | 2% | 64 |
| Left for life | | 2,912 |

"Feels like nothing. That's the point."

**Step 3. Schedule them** for payday, or the day after if your pay lands late in the day. Repeating, automatic, no reminders needed.

**Step 4. Ratchet.** Put a reminder in your calendar every six months: add 1% to Old Me. And every time your pay goes up, split the after-tax increase half to Old Me, half to you.

**Step 5. The 48-Hour Hold for withdrawals.** If you want to take money out of Old Me, wait 48 hours first. If you still need it after two days, take it without guilt. That's what it's for.

**Order of play, if you're juggling:** a one-month Cushion → take any employer match → clear high-interest debt (card-type rates) → build Old Me.

- [ ] Three pots made and named
- [ ] Three transfers scheduled for payday
- [ ] Six-month "add 1%" reminder in the calendar

<small>General info, not advice for your situation. If you're struggling with debt, free non-profit help: NFCC (US), StepChange or MoneyHelper (UK), Credit Counselling Canada, National Debt Helpline 1800 007 007 (AU).</small>

### F2. Check the match: what it's called where you are (one page)

**The match is part of your pay. We left it on the table for three years.**

Find the plan details in your benefits portal, your staff handbook or your payslip, or ask HR one question: *"Does the company add money to my retirement plan, and what do I have to put in to get all of it?"*

| Where you are | What to look for | The question to answer |
|---|---|---|
| **US** | 401(k) or 403(b) "employer match"; vesting schedule | What percentage do I need to put in to get the full match? Am I putting in at least that? |
| **UK** | Workplace pension (auto-enrolment). The legal minimum is 8% of qualifying earnings in total, with at least 3% from your employer. Some employers add more if you do | Will my employer add more if I put more in? Am I opted in? |
| **Canada** | Group RRSP or pension plan "employer match" or "DPSP" | Is there a match, and am I enrolled at the level that gets all of it? |
| **Australia** | Super. Your employer pays it anyway (paid with your pay under Payday Super since 1 Jul 2026; check the ATO for the current rules) | Is it arriving, and which fund is it going into? Check your payslip and your fund's app |

- [ ] Found my plan details
- [ ] I know what it takes to get the full employer contribution
- [ ] I'm at (or have scheduled a change to reach) that level

<small>Rules differ by country and by employer, and they change. Check your plan documents and your official government source (IRS, GOV.UK/MoneyHelper, CRA, ATO/Moneysmart). General info, not advice for your situation.</small>

### F3. The Subscription Funeral (one page)

**Last Sunday of every month. Twenty minutes. Bring tea.**

1. **List every recurring charge.** Go through last month's bank and card statements and your phone's app-store subscriptions.
2. **Ask each one:** "Would I sign up today, at this price?"
3. **Cancel every no.** Read each one a one-line eulogy. ("Here lies the yoga app, opened twice in 2026. You were a lovely idea.")
4. **Send the freed money to Cushion or Old Me the same day.** Then raise that transfer by the same amount so it keeps happening.

| Charge | Monthly cost | Would I sign up today? (Y/N) | Cancelled (date) | Eulogy |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| **Freed this month** | | | | |

- [ ] Freed money moved the same day
- [ ] Transfer to Old Me or Cushion raised by the same amount
- [ ] Next funeral in the calendar (last Sunday of next month)

---

## G. Fallback: the copyable Google Sheet

Used if the Vercel function breaks. The FUTURE DM link swaps to a plain Tally email-capture form whose thank-you page links this sheet ("File → Make a copy"). The swap is a single config change in the Zernio DM automation and is triggered automatically by the uptime check on the function (two failed checks in a row).

**Sheet name:** The 2075 Calculator (make a copy)
**Tab 1: "Your sums"**

| Cell | Label (column A) | Value (column B) |
|---|---|---|
| A1 / B1 | **The 2075 Calculator** · Margot from 2075 | |
| A3 / B3 | Your age now | *(input, e.g. 31)* |
| A4 / B4 | Set aside each month | *(input, e.g. 150)* |
| A5 / B5 | Saved so far | *(input, e.g. 2000)* |
| A6 / B6 | Assumed yearly return after fees (2%–7%) | *(input, default 5%)* |
| A7 / B7 | Show in today's money? (TRUE/FALSE) | *(checkbox, default FALSE)* |
| A8 / B8 | Your one percent (1% of monthly take-home) | *(input, default 32)* |
| A9 / B9 | Contributions stop at age | `=MAX(67, B3+5)` |

**Results block (rows 12–16).** Column A = milestone age; B = plain; C = with one percent more.

| Cell | Formula |
|---|---|
| A13–A16 | 45, 55, 67, 84 |
| B13 (copy down to B16) | `=IF(A13<=$B$3,"—",ROUND(( $B$5*(1+$B$6/12)^((A13-$B$3)*12) + IF($B$4=0,0,$B$4*((1+$B$6/12)^((MIN(A13,$B$9)-$B$3)*12)-1)/($B$6/12))*(1+$B$6/12)^((A13-MIN(A13,$B$9))*12) ) / IF($B$7,1.025^(A13-$B$3),1),-2))` |
| C13 (copy down to C16) | Same as B13 with `($B$4+$B$8)` in place of `$B$4` |

**Frank and small print (row 18, merged A–C):** the frank image, then: "Illustrative. Assumes the yearly return in B6 after fees, compounded monthly; contributions stop at the age in B9; no withdrawals assumed after. Real returns vary and can be negative. Not a promise, and not advice for your situation. Margot is a fictional AI character."

**Tab 2: "Three next steps"** reproduces F1–F3 as text with tick boxes.

The sheet formula gives the same results as the loop in C to within rounding; check with H1–H5.

---

## H. QA: test entries and expected outputs

Run all of these through the Tally form → function → email path before Wed 28 Oct (the plan calls for 10 entries across 3 countries; run H1–H5 twice, once from a US, once from a UK or IE address, with H1 also run inflation-on). Expected values are rounded to the nearest 100.

| # | Age | Monthly | Saved | Rate | Inflation | One % | Plain (by milestone) | With one percent more |
|---|---|---|---|---|---|---|---|---|
| H1 | 31 | 150 | 2,000 | 5% | off | 32 | 45: 40,400 · 55: 89,900 · 67: 193,000 · 84: 450,800 | 48,200 · 107,600 · 231,600 · 541,000 |
| H1i | 31 | 150 | 2,000 | 5% | on | 32 | 28,600 · 49,700 · 79,400 · 121,800 | 34,100 · 59,500 · 95,200 · 146,200 |
| H2 | 45 | 300 | 10,000 | 5% | on | 32 | 55: 49,300 · 67: 100,900 · 84: 154,900 | 53,100 · 109,900 · 168,600 |
| H3 | 26 | 50 | 0 | 2% | off | 32 | 13,900 · 23,600 · 38,100 · 53,500 | 22,700 · 38,600 · 62,400 · 87,700 |
| H4 | 70 | 100 | 5,000 | 7% | off | 32 | 84 only: 26,700 (contributions to 75) | 31,000 |
| H5 | 38 | 0 | 15,000 | 5% | off | 32 | 21,300 · 35,000 · 63,800 · 148,900 (zero-a-month line shown) | 24,500 · 45,300 · 88,700 · 207,200 |

**Pass checks for every test email**
- [ ] Only milestone ages above the entered age appear (H2 starts at 55; H4 shows 84 only)
- [ ] The frank image loads, and the small print shows the right rate, stop age and inflation wording
- [ ] No currency symbols; no cents
- [ ] Contact added to Resend with tag `calc`; welcome email 2 scheduled for day 2
- [ ] EU/UK entries receive the confirm email first, then the letter
- [ ] Supabase row has no IP address and no one-percent figure

---

## I. Companion freebie for keyword RAISE: the pay-meeting email

The RAISE DM sends a short page with this script and one line linking the $15 pack. Same email capture (Resend tag `raise`). Contacts tagged `raise` enter the welcome sequence on the **RAISE path**, the primary route into the pack (see `welcome-sequence.md`, "Two paths").

**Title:** The email that asks for the pay meeting
**Intro:** Not the ask. Just the meeting. Send it before next year's budget is set; in a lot of companies that's the autumn. Timing varies, so if you're not sure, ask HR when pay budgets are decided.

> **Subject:** Twenty minutes to talk about my pay
>
> Hi [Manager's name],
>
> Thanks again for [one specific recent thing: the feedback on X / the support on Y]. Before next year's budgets are set, I'd like to book twenty minutes to talk about my pay and how my role has grown this year.
>
> Would [day] or [day] work? I'll bring a short summary of the year so we can keep it focused.
>
> Thanks,
> [Your name]

**Why it's built this way**
- It asks for a meeting, not a number. The number is for the room (or the call), said once, then hush.
- "Before budgets are set" tells them why now, without pressure.
- "A short summary of the year" tells them you'll be prepared, which makes the meeting easier to say yes to.

**After you send it:** the reply goes in your calendar, and then you need three receipts, a researched number and three rehearsals. The Raise Script Pack has the worksheets and 14 scripts for the rest of it: what to say in the room, when they say "no budget", when they say "let's revisit", and the follow-up email. $15. [Get the pack →]({{pack_link}})

<small>Scripts, not promises. What you get depends on your job, your market and your manager. Margot is a fictional AI character; this is general information, not advice for your situation.</small>
