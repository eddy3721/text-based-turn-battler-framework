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

## Forced miss from the hit resolver (1.0.42)

`hitResolver` may return `{ forceMiss: true }` (optionally with `evadeMessage`).
That hit misses without calling `Formulas.isHit`, so no hit roll is drawn; the
miss runs the normal evasion path and `evasion.forcedMiss` is true for
`ON_EVADE`/`AFTER_EVADE`. Use it when "this hit cannot touch" depends on the
caster, target and skill of the hit itself, which a buff on the defender cannot
know in advance. `hitRateModifier` cannot express it: hit rate never drops below
10%. Same exemptions as untouchable: counter replies and `ignoreInvincible`
actions never ask the resolver.

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

## Heal taken multiplier (1.0.33)

`healTaken: { multiplier }` on a Buff scales every heal its holder receives:
HEAL actions, HOT ticks and game-layer calls to `entity.heal()`. Several
matching buffs multiply together and the result is floored; a holder without
such a buff gets the amount back untouched, not even rounded. HOT logs the
scaled amount. `entity.scaleHealing(amount)` exposes the same math, and a
caller that already scaled may pass `heal(amount, logger, { scaled: true })`.
This is the heal-side twin of `damageTaken`, for anti-heal and aging effects
that used to wrap `entity.heal` per encounter.

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

**Its log lines come after the hit (1.0.39).** The `logger` a `LAST_STAND`
action receives is a holding buffer: whatever it logs is kept on
`hit.pendingLogs` and written by `finishDamage`, after the hit's own line
(DAMAGE/BLOCK, the DOT line, the luck event line), shield breaks and part
breaks, and before `AFTER_DAMAGE_RECEIVED`. Before this the line was written
inside `takeDamage`, so "survived at 1 HP" printed ahead of the damage that
nearly killed. Anything the action triggers through that logger (a heal,
sanity change) is held in the same order. A hit clamped to 0 damage with no
deferred caller is settled in `takeDamage` so the held lines still print.
Logging through `engine.logger` instead bypasses the buffer.
`BEFORE_DAMAGE` keeps the real logger: its lines describe why the hit changes
("the guard is pried open") and read correctly before it.

Applies to attacks, DOT, luck events and direct `takeDamage` alike. Code that
sets `hp = 0` directly bypasses it, as it bypasses every damage hook.

## Shield (1.0.38)

`shield: amount` on a Buff gives its holder a pool that absorbs damage before
HP. It runs after `damageTaken`, every `BEFORE_DAMAGE` passive and
invincibility, and before `LAST_STAND`, so it soaks up what would really be
deducted. Several shields drain in the order they were added. The remaining
pool lives in `buff.shield.value` (`buff.shield.max` keeps the original); a
shield emptied by a hit is removed from the holder at once and its name goes
into `hit.shieldsBroken`, which `finishDamage` logs as `SHIELD_BREAK`
("X 的護盾碎掉了！") after the hit's own line.

Absorbing counts as a block: the hit gets `blocked: true`, `blockMethod` is the
first shield's name, and `hit.shieldAbsorbed` is the total soaked. The default
text therefore reads "但是被 X 用護盾擋下了！" for a fully absorbed hit and
"……用護盾抵擋，造成了 N 點傷害！" for a partial one; DAMAGE logs carry
`shieldAbsorbed`. Shields absorb attacks, DOT, luck events and direct
`takeDamage`; an action with `ignoreShield: true` passes through. An attack the
shield soaked completely still counts as received: `AFTER_ATTACK_RECEIVED` and
`AFTER_ATTACK_DEALT` run with `actualDamage: 0` and the aggregated
`shieldAbsorbed` (per-hit `AFTER_DAMAGE_RECEIVED` still needs HP lost). The buff's
`duration` still expires it like any other buff.

Before 1.0.38 a shield had to be a `BEFORE_DAMAGE` passive per encounter, which
runs in array order with the attacker's temporary amplifiers and cannot report
the break after the hit line. Tests: `node --test tests/shieldAndInsertAction.test.js`.

All fields are opt-in; pre-existing skills keep their RNG sequence and behavior.
Tests: `node --test tests/protection.test.js`, and the full `npm test` suite.
