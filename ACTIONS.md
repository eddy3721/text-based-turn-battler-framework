# 行動後事件（`AFTER_ACTION`，1.0.25）

一個行動槽**真的出手**之後，引擎對場上**所有存活單位**（兩隊都算，出手者自己也算）
執行 `trigger: 'AFTER_ACTION'` 的被動，簽名與傷害側鉤子相同：

```js
{
  id: 'affirm', trigger: 'AFTER_ACTION',
  // 只對隊友的行動反應
  enabled: (self, action) => action.actor !== self && action.actor.team === self.team,
  action: (self, { actor, skill }, logger, engine) => {
    actor.addBuff({ id: 'affirmed', name: '肯定', type: 'STAT', duration: 3,
      effect: stats => { stats.atk *= 1.1; } }, engine);
  }
}
```

## 時點

- 在該槽的技能執行完、`settleDeaths()`／`checkWinCondition()` 之後，`tickBuffs()` 之前。
  所以出手者這一槽打死的人已經宣告倒下；掛在**出手者**身上的 buff 會在同一槽被扣一次持續時間。
- 出手者可能在自己的行動中被反擊打倒，仍然會通知（`action.actor.isAlive` 為 false）。
- 被動跑完後引擎會再結算一次死亡與勝負；戰鬥已分出結果時不再通知其他人。

## 什麼算出手

算：普通攻擊、抽到的技能、開場技能、被 `skillSelectionResolver` 換掉後實際執行的技能
（`action.skill` 是實際執行的那一個）。

不算：暈眩、疲勞動不了、恐慌、`actionDisabled`、喘息、幸運事件、沒有技能可用而略過。
反擊與 `CAST_SKILL`／`BEFORE_ACTION` 觸發的技能不是獨立的行動槽，不另外通知。

## 與 `AFTER_SKILL_CAST` 的差別

| | `AFTER_SKILL_CAST` | `AFTER_ACTION` |
| --- | --- | --- |
| 單位 | 每一次 `Skill.execute` 完成（含子技能、反擊技能） | 每一個出手的行動槽一次 |
| 誰收到 | 只有施放者的**敵方** | 兩隊所有存活單位 |
| 用途 | 觀察對手的招式（模仿、看破） | 對「有人行動了」做反應（鼓舞、跟進） |
