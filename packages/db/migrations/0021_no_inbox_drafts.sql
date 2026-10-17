-- Zernio audit: inbox drafts are never sent (a TikTok draft drops every post_info field, the AI disclosure included),
-- and the live adapter refuses them. Posts created before 6417f32 with meta.mode 'draft_inbox' that haven't reached
-- the vendor yet publish directly instead (the Sound Engine adds the music).
UPDATE post
   SET meta = jsonb_set(meta, '{mode}', '"publish"'), updated_at = now()
 WHERE meta->>'mode' = 'draft_inbox'
   AND (status IN ('draft', 'awaiting_approval', 'scheduled') OR (status = 'publishing' AND external_id IS NULL));
