# Inanimate entities and complete-attack reactions (1.0.3)

`Entity({ actionDisabled: true })` forbids normal attacks, skills (including
direct execute calls), opening skills and counters. It does not disable luck
events, damage, buff ticking or defeat checks. `lockedStats: ['atk', 'spd']`
forces the named effective stats to zero after all STAT buffs.

`AFTER_ATTACK_RECEIVED` runs once per target after a skill execution finishes,
aggregating actual HP lost across its DAMAGE actions and combo hits. The context
contains the first qualifying hit with `actualDamage` replaced by the sum.
Only hostile, non-counter damage qualifies. Child CAST_SKILL executions count
separately. Receivers must check survival before reacting. DOT, luck and direct
reflection never produce this hook. Existing per-hit hooks retain their timing.

`AFTER_ATTACK_DEALT` (1.0.5) is the attacker-side mirror: the same aggregate and
the same one call per target, but run against the caster's passives and skipped
when the caster is dead. Per target the receiver hook fires first, matching the
finishDamage ordering. Use it for "once per complete attack" attacker reactions —
follow-up damage, on-hit resource gain, stacking marks.

The per-hit `AFTER_DAMAGE_DEALT` stays correct when a reaction genuinely belongs
to each individual hit. It is the wrong tool for once-per-attack reactions:
deriving the end of an attack from `hitIndex === hits` breaks on multi-action
skills, because every DAMAGE action restarts the index, and it forces each
consumer to rebuild the aggregation the framework already performs here.
