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

## Untouchable (1.0.24)

`untouchable: boolean` (default false) on a Buff makes every DAMAGE hit against
its holder miss **without rolling**: no `hitResolver`, no `Formulas.isHit`, so a
battle without untouchable buffs keeps its RNG sequence. It is the evasion-side
twin of `invincible`: invincible means "hit, but no damage" (BLOCK log,
`blockMethod`); untouchable means "never touched" (MISS log). The miss runs the
normal evasion path, so `ON_EVADE` can write `evadeMethod`/`evadeMessage` and
`AFTER_EVADE` reacts; `evasion.untouchable` is the buff that caused it (null on an
ordinary rolled miss). Because it is a miss, no counter check happens.

Same exemptions as invincibility: `ignoreInvincible: true` actions and counter
replies skip the check and hit normally; DOT and direct `takeDamage` are not
attacks and are unaffected. Sure-hit effects built from hit bonuses do not pierce
it, since the roll never happens.

`damageMultiplier` on DAMAGE defaults to no change. A finite nonnegative value
scales calculated damage after defense, combo decay and critical damage, before
BEFORE_DAMAGE reactions, with floor rounding. This supports split hits without
subtracting defense extra times. It does not change hit count or SP.

All fields are opt-in; pre-existing skills keep their RNG sequence and behavior.
Tests: `node --test tests/protection.test.js`, and the full `npm test` suite.
