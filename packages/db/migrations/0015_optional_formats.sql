-- 0015 (16 Oct, PRD §3.12 step 4): two optional content formats. "product_in_hand" (the persona holding our own
-- product, from its cover as a second reference, for sell slots) and "trend_reenactment" (Kling 3.0 motion transfer
-- from a reference movement clip). Both are off until the Owner sets a weekly count (studio settings.formats).
-- Additive only; runs on PGlite and Supabase Postgres.
ALTER TABLE idea DROP CONSTRAINT IF EXISTS idea_format_check;
ALTER TABLE idea ADD CONSTRAINT idea_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment'));
ALTER TABLE calendar_slot DROP CONSTRAINT IF EXISTS calendar_slot_format_check;
ALTER TABLE calendar_slot ADD CONSTRAINT calendar_slot_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment'));
ALTER TABLE post DROP CONSTRAINT IF EXISTS post_format_check;
ALTER TABLE post ADD CONSTRAINT post_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment'));
ALTER TABLE script DROP CONSTRAINT IF EXISTS script_format_check;
ALTER TABLE script ADD CONSTRAINT script_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment'));
ALTER TABLE media_render DROP CONSTRAINT IF EXISTS media_render_format_check;
ALTER TABLE media_render ADD CONSTRAINT media_render_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment'));
