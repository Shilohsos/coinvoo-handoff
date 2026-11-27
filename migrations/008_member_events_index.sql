-- Phase 10: every member page, the member list's non-USD column and v_member_value look events up by the member
-- they matched. Without this index each of those reads scans the whole events table. Additive only.
CREATE INDEX idx_events_member ON events(matched_member_id);
