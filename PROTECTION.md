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

## Damage taken multiplier (1.0.26)

`damageTaken: { multiplier, filter? }` on a Buff scales the damage its holder
receives, with floor rounding, **before** `BEFORE_DAMAGE` passives and
invincibility: a vulnerability enlarges the hit first, then blocks and
reductions work on the enlarged number. `filter(hit)` receives the same `hit`
object `BEFORE_DAMAGE` sees (`source`, `action`, `skill`, `caster`, `tags`, …)
and decides whether this buff applies; the framework does not know what
"magic" or "fire" means, so the game says it here (e.g.
`hit => hit.action?.stat === 'int'`). Without a filter only DAMAGE attacks
(`hit.source === 'ATTACK'`) are scaled; DOT and direct/environmental damage
are not. Several matching buffs multiply together. A multiplier below 1 is a
plain damage reduction. Buffs without the field change nothing and consume no
random numbers.

## Last stand (1.0.27)

A passive with `trigger: 'LAST_STAND'` runs **after** every other damage step —
`damageTaken`, all `BEFORE_DAMAGE` passives, invincibility and flooring — and
only when the hit would still kill its holder (`hit.damage >= hp`). It has the
same signature as `BEFORE_DAMAGE`, `(self, hit, logger)`, and lowers
`hit.damage` to survive, typically to `hp - 1`. The result is floored again.

Surviving at 1 HP used to be written as a `BEFORE_DAMAGE` passive, but those run
in array order. Attackers that amplify a single hit by pushing a temporary
`BEFORE_DAMAGE` passive onto the target append it **after** the holder's own
passives, so the amplifier re-multiplied the already-clamped damage and the
"cannot die" effect lost. `LAST_STAND` is a separate, final phase, so nothing
added later in the array can undo it. Mitigation (blocks, reductions) still
belongs in `BEFORE_DAMAGE`; only "this hit must not kill" belongs here.

Applies to attacks, DOT, luck events and direct `takeDamage` alike. Code that
sets `hp = 0` directly bypasses it, as it bypasses every damage hook.

All fields are opt-in; pre-existing skills keep their RNG sequence and behavior.
Tests: `node --test tests/protection.test.js`, and the full `npm test` suite.
