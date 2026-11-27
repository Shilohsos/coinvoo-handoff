-- Leave-then-rejoin is one member with a counter, never a second member row. left_at is set when the gate bot reports
-- a leave and cleared by the next join, which is what makes that join a rejoin (an approved join request also
-- reaches the bot as a left -> member transition, so the transition alone cannot tell a first join from a rejoin).
ALTER TABLE members ADD COLUMN rejoins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN left_at INTEGER;
