import type { ProductBrief } from '@ios/content';

export const KIT = { bg: '#F6F1E7', ink: '#1F2A44', accent: '#C2562B', accent2: '#5A8F7B' } as const;

export const BRIEF: ProductBrief = {
  name: 'Sunday Reset Planner',
  promise: 'Plan your week in one 20-minute sitting and keep it running in minutes a day.',
  audience: 'Busy people who say: my week runs me; I never know what is for dinner',
  outline: ['Start here: how to use this in 10 minutes', 'Part 1: Clear the decks', 'Part 2: Plan the week', 'Part 3: Fix what slips', 'Worked example', 'Your one-page summary'],
  format: 'Printable PDF planner + Google Sheets template',
  page_count: 12,
  bonuses: ['Meal grid', 'Errand list'],
  price_cents: 1900,
  ladder_rung: 'entry',
  upsell_pairing: 'the Monthly Reset bundle',
  cta_keyword: 'RESET',
  validation: 'test',
};

export const MANUSCRIPT = `---
title: The Calm Budget Workbook
subtitle: Give every dollar a job in one evening
slug: calm-budget
rung: entry
price: 17
sections: Start here; The three buckets; Weekly money check; Bonus: Bill calendar
templates: sheets, notion
---

# Ignored when front matter has a title

## Start here

This workbook takes one evening. Read a page, then fill it in.

- Get your last month's statement
- Find a quiet hour

## The three buckets

### Rule: Bills before fun

Pay the fixed bills first, then split what's left between saving and spending.

### Example: Maya's month

Maya earns $2,400. Bills take $1,500, so $900 is split three ways.

Fill in (5): Your monthly take-home and your fixed bills

- [ ] Listed every fixed bill
- [ ] Picked a saving amount

## Weekly money check

### Tracker: Weekly check

Rows: Checked balance; Logged spending; Moved savings
Columns: Wk 1; Wk 2; Wk 3; Wk 4

> Ten minutes a week keeps the plan honest.

## Bonus: Bill calendar

| Bill | Due | Amount |
| --- | --- | --- |
| Rent | 1st | $1,100 |
| Phone | 15th | $40 |

Read more at [the CFPB budget guide](https://www.consumerfinance.gov/).
`;
