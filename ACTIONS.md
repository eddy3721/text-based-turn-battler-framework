# 行動與回合事件（`AFTER_ACTION`／`ROUND_START`，1.0.25）

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

## 回合開始（`ROUND_START` 被動，1.0.25）

每回合開始時，引擎在遭遇戰的 `roundStart` 選項**之後**、疲勞同步與 `ROUND_START` Buff **之前**，
對每個存活單位執行 `trigger: 'ROUND_START'` 的被動，簽名是
`(self, { round }, logger, engine)`。跑完後結算死亡與勝負。

原本只有 Buff 能掛在回合開始（`trigger: 'ROUND_START'` 加 `skillIds`），而且必須透過一個技能執行、
有觸發次數上限；想「每回合記下自己的狀態」這種不出手、不留日誌的常駐被動無處可掛。
二階堂希羅的死に戻り用它記下每回合開始時的 HP／SP。

## 行動槽紀錄與戰鬥結尾（`actionSlots`／`battleEnd`，1.0.28）

`engine.actionSlots` 依序記下每個**真的出手**的行動槽（什麼算出手同 `AFTER_ACTION`）：

```js
{ actor, skill, turn, start, end }   // start／end 是 engine.logger.logs 的索引，含 start、不含 end
```

這一槽的反擊、觸發技能、死亡宣告與 `AFTER_ACTION` 的後果都落在 `[start, end)` 裡。
分出勝負的那一槽也會記（`AFTER_ACTION` 在有結果時不再通知，但那一槽確實出手了）。
回合開頭的 DOT／HOT、暈眩、喘息、幸運事件不屬於任何槽。

`options.battleEnd(engine)` 在勝負已定（含回合用盡的平手）、`BATTLE_END` 日誌**之前**執行一次，
用來補結尾演出，例如回顧 `actionSlots` 挑出「精彩重播」。這時已經不能改變結果，回傳值不使用。

原本戰鬥結束時沒有任何掛勾：`openingLogs` 只有開頭，想在結尾補東西只能在呼叫端
事後改寫 `result.logs`，而那時已經看不到每一段日誌是誰、在哪一槽打出來的。
第一個使用者是 mydoujin 第 41 層小美的精彩重播。
