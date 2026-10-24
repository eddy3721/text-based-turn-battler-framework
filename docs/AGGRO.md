# 仇恨值

`targetType: 'ENEMY_SINGLE'` 的技能抽目標時，以候選人的 `aggro` 為權重加權抽籤。
刻度就是倍率：`aggro` 3 的人被選中的機率是 `aggro` 1 的三倍。

全員預設 1，所以什麼都不設定的戰鬥跟加入這個屬性之前完全一樣——權重相等時
選到的索引就是 `floor(random × 人數)`，跟原本的均勻抽一致，也同樣只消耗一次亂數。

```js
new Entity({ id: 'tank', name: '坦克', team: 'A', stats: { hp: 200, aggro: 2 } });
```

## 用技能改變仇恨

`aggro` 跟其他能力值一樣走 `getEffectiveStats()`，所以調整它不需要任何專用欄位，
`type: 'STAT'` 的 Buff 就夠了。乘除比加減好用：效果不隨場上人數或隊伍強度漂移。

```js
// 嘲諷：四個行動槽內，敵方的單體技能有四倍機率選到自己。
const taunt = {
  type: 'BUFF', targetType: 'SELF',
  buffs: [{ id: 'taunt', name: '挑釁', type: 'STAT', duration: 4, polarity: 'neutral',
    effect: stats => { stats.aggro *= 4; } }]
};

// 隱蔽：反過來把自己的權重壓到四分之一。
const vanish = { id: 'vanish', name: '隱蔽', type: 'STAT', duration: 3,
  effect: stats => { stats.aggro *= 0.25; } };
```

Buff 到期自動還原，`dispellable: true` 也照常被驅散——框架不維護任何仇恨表，
每次抽選都是現算，所以不會有「解除了嘲諷但仇恨還留著」這種狀態殘留。

打出傷害就累積仇恨這類動態設計不在框架裡，但用既有的鉤子就寫得出來：
在 `AFTER_ATTACK_DEALT`（見 [DAMAGE_REACTIONS.md](DAMAGE_REACTIONS.md)）裡給自己附加
一個短期的 `aggro` Buff 即可。

## 邊界

- **只作用在 `ENEMY_SINGLE`。** `ENEMY_ALL` 打全體，沒有選擇問題；`ALLY_SINGLE`
  維持均勻抽——仇恨的語意是「敵人想打誰」，拿它決定補師補誰會讓嘲諷坦克
  順便變成補血磁鐵，那應該是另一條獨立的權重。
- **反擊與 `options.targets` 指定的目標不受影響**，它們打的是特定對象，不是抽出來的。
- **`aggro: 0` 等於在還有別人可打的時候不會被選中。** 但如果場上所有候選人的權重
  都是 0（全員隱蔽，或用 `lockedStats` 鎖掉 `aggro`），會退回均勻抽——否則單體技能
  永遠選不到目標，雙方互相打不到，戰鬥只能卡到 `maxTurns`。
- **疲勞不影響仇恨。** 力竭會削弱 atk/def/spd 那一排，但不會讓你比較不引人注意。
- 建構 Entity 時 `aggro` 必須是有限的非負數，否則直接拋錯（跟 `skillCastRate` 同樣嚴格）。
