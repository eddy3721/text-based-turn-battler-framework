# Skill modifiers (1.0.2)

## 技能施放率

`Entity.stats.skillCastRate` is a probability in [0, 1], defaulting to `0.35`.
Explicit zero is supported. Invalid base values fail at construction. It is a
battle stat, not part of the game's nine-stat growth budget.

Skills can modify it through ordinary `STAT` buffs, just like attack or defense:

```js
new Skill({
  id: 'concentration', name: '集中',
  actions: [{ type: 'BUFF', targetType: 'SELF', buffs: [{
    id: 'concentration', name: '集中', type: 'STAT', duration: 3,
    stackPolicy: 'refresh',
    effect: stats => { stats.skillCastRate += 0.15; } // 35% -> 50%
  }] }]
});
// Debuff example: stats.skillCastRate -= 0.10; // minus 10 percentage points
// Relative adjustment: stats.skillCastRate *= 0.75;
```

Effects run in buff order on a copy. After all STAT effects, the effective rate
is clamped to [0, 1]; nonfinite results throw. Expiring/removed buffs restore the
underlying rate without mutating the base stat. Durations count the affected
unit's actions, including the casting action for self buffs.

Living enemy auras below multiply this clamped effective rate afterward. Thus
35% plus 15 percentage points with a 0.75 aura yields 37.5%. Even at 100%, the
actor still needs a castable skill and enough SP; otherwise it uses its normal
attack. Opening skills, counters and triggered skills bypass this lottery.

## Defense bypass and enemy auras

`DAMAGE` actions accept `ignoreDefense: true`. This skips only the defender's
effective `def` in the formula. Accuracy, variance, critical hits, counters,
body parts and `BEFORE_DAMAGE` mitigation still run normally. The default is
false. Direct formula callers can pass `{ ignoreDefense: true }` as the fifth
argument to `Formulas.calculateDamage`.

A passive may declare `{ id: 'pressure', enemySkillCastMultiplier: 0.75 }`.
`BattleEngine.getSkillCastChance(actor)` multiplies the effective `skillCastRate` by
living enemies' modifiers. Multipliers must be finite numbers in [0, 1] and
require a nonempty string passive id. Identical ids apply once (the lowest
multiplier wins); different ids multiply. Dead sources stop contributing
immediately; revived or summoned living sources are considered dynamically.

Only the ordinary active-skill lottery uses this chance. A failed roll falls
back to normal attack. Opening skills, counters and triggered/called skills
keep their original behavior. No persistent debuff is applied to the target.
