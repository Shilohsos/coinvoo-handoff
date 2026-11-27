-- Phase 13: the ad platform's ids for a click, from the compact ?m=<ad.id>|<adset.id>|<campaign.id>|<placement>
-- parameter on /c/<code>. Names keep arriving in campaign/adset/ad; ids are what reports group by. Additive only.
ALTER TABLE clicks ADD COLUMN ad_id TEXT;
ALTER TABLE clicks ADD COLUMN adset_id TEXT;
ALTER TABLE clicks ADD COLUMN campaign_id TEXT;
ALTER TABLE clicks ADD COLUMN placement TEXT;
