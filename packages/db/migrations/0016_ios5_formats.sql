-- 0016 (IOS-5 contracts, docs/IOS-5-CONTRACTS.md; PRD FR-4.3c format library): six more optional formats.
-- photo_dump (5–10 casual stills, IG carousel), text_note (text-on-image note / quote card), facecam_screen (the persona
-- in a corner over a generated screen recording or slides), reply_comment (an answer to a top comment, the handle
-- anonymised), news_greenscreen (the persona over a News Desk headline card, never a real outlet's logo) and meme
-- (a relatable text post). They stay off until a persona's Format Plan (stream L) turns them on; stream K renders them.
-- Additive only; runs on PGlite and Supabase Postgres.
ALTER TABLE idea DROP CONSTRAINT IF EXISTS idea_format_check;
ALTER TABLE idea ADD CONSTRAINT idea_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
   'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme'));
ALTER TABLE calendar_slot DROP CONSTRAINT IF EXISTS calendar_slot_format_check;
ALTER TABLE calendar_slot ADD CONSTRAINT calendar_slot_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
   'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme'));
ALTER TABLE post DROP CONSTRAINT IF EXISTS post_format_check;
ALTER TABLE post ADD CONSTRAINT post_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
   'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme'));
ALTER TABLE script DROP CONSTRAINT IF EXISTS script_format_check;
ALTER TABLE script ADD CONSTRAINT script_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
   'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme'));
ALTER TABLE media_render DROP CONSTRAINT IF EXISTS media_render_format_check;
ALTER TABLE media_render ADD CONSTRAINT media_render_format_check CHECK (format IN
  ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
   'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme'));
-- Story frames (stream L, FR-4.3d) pass QC and the Gate like posts: their reports are subject_type 'story_frame'.
ALTER TABLE gate_result DROP CONSTRAINT IF EXISTS gate_result_subject_type_check;
ALTER TABLE gate_result ADD CONSTRAINT gate_result_subject_type_check CHECK (subject_type IN ('script','asset','post','product','reply','story_frame'));
ALTER TABLE qc_report DROP CONSTRAINT IF EXISTS qc_report_subject_type_check;
ALTER TABLE qc_report ADD CONSTRAINT qc_report_subject_type_check CHECK (subject_type IN ('script','asset','post','product','story_frame'));
