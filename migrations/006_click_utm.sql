-- Phase 7 Part F: the UTM parameters an ad appends to its link, kept on the click like fbclid/ttclid/gclid
-- and sub1..sub3. Additive: existing rows keep NULL.

ALTER TABLE clicks ADD COLUMN utm_source TEXT;
ALTER TABLE clicks ADD COLUMN utm_medium TEXT;
ALTER TABLE clicks ADD COLUMN utm_campaign TEXT;
ALTER TABLE clicks ADD COLUMN utm_content TEXT;
ALTER TABLE clicks ADD COLUMN utm_term TEXT;
