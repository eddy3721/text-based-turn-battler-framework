# Opt-in protection and effect removal (1.0.13)

Buff fields: `polarity: 'positive' | 'negative' | 'neutral'` (default neutral),
`dispellable: boolean` (default false), `invincible: boolean` (default false).
`entity.removeBuffs('positive' | 'negative')` returns removed buffs; it removes
only explicitly dispellable matching effects. The game owns logs and legacy
classification. Unknown effects are protected; duration alone does not determine
removability. Do not mark resource counters or permanent equipment effects.

Invincibility reduces DAMAGE actions to zero after BEFORE_DAMAGE passives.
It does not stop DOT, direct environmental damage, status application or counters.
A DAMAGE action with `ignoreInvincible: true` skips the evasion roll and ignores
these invincibility buffs. It still runs counters, defense and BEFORE_DAMAGE
reduction. Legacy custom passives do not automatically become invincibility.

`damageMultiplier` on DAMAGE defaults to no change. A finite nonnegative value
scales calculated damage after defense, combo decay and critical damage, before
BEFORE_DAMAGE reactions, with floor rounding. This supports split hits without
subtracting defense extra times. It does not change hit count or SP.

All fields are opt-in; pre-existing skills keep their RNG sequence and behavior.
Tests: `node --test tests/protection.test.js`, and the full `npm test` suite.
