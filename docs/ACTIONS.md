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
例如「回溯到回合開始」的技能，就用它記下每回合開始時的 HP／SP。

### 倒下時也跑（`whileDead`，1.0.43）與 `engine.revive`

被動加上 `whileDead: true`，持有者倒下時引擎仍會在回合開始執行它（只跑這種，其他被動照舊略過）。
搭配 `engine.revive(entity, hp)` 讓單位站回來：HP 夾在 1 到上限之間、清掉死亡紀錄（之後再倒下會照常印「倒下了」），
回傳是否真的復活。回合開始時復活，那一回合照常排進行動順序。

全隊都倒下時勝負已經判定，`whileDead` 被動沒有機會執行：這是「等隊友撐住，自己再回來」，不是保命。
典型用途是陣亡後隔幾回合重生的單位。測試：`tests/battleStart.test.js`。

## 戰鬥開場（`BATTLE_START` 被動，1.0.40）

`start()` 印完 `BATTLE_START`、`openingLogs` 與開場台詞之後、第 1 回合之前，引擎對每個存活單位執行一次
`trigger: 'BATTLE_START'` 的被動，簽名是 `(self, { maxTurns }, logger, engine)`。跑完後結算死亡與勝負。

被動可以直接設定 `engine.result`（`'TEAM_A'`／`'TEAM_B'`／`'DRAW'`）：有結果時後面的單位不再觸發、
回合迴圈一次都不跑，接著照常是 `battleEnd` 與 `BATTLE_END`。只呼叫 `executeTurn()` 的呼叫端不會經過這裡。

```js
// 開場就跑掉，強制平手
{
  id: 'run_away', trigger: 'BATTLE_START',
  action: (self, battle, logger, engine) => {
    logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name} 跑走了` });
    engine.result = 'DRAW';
  }
}
```

原本開場只有 `openingSkill`，要等持有者第一次行動才放，那時已經印出第 1 回合、別人也可能先出手；
`ROUND_START` 也一樣晚了一步。典型用途是開場就上好狀態、或先講一句開場白的角色。測試：`tests/battleStart.test.js`。

## 喘息之後（`AFTER_REST` 被動，1.0.34）

SP 付不起普攻、停下來喘息的那一槽，引擎在 `REST` 日誌**之後**、疲勞同步與 `tickBuffs()` **之前**，
對喘息者自己執行 `trigger: 'AFTER_REST'` 的被動，簽名是 `(self, { value }, logger, engine)`，
`value` 是實際回復的 SP。跑完後結算死亡與勝負。

被動可以另外提供 `restMessage: (self, { value }) => string`：第一個啟用中、有提供的被動換掉預設的
「X 暫時停下攻勢，調整呼吸」。日誌仍是 `type: 'REST'`、`value` 不變，所以上色與統計照舊。

```js
{
  id: 'stand_guard', trigger: 'AFTER_REST',
  restMessage: self => `${self.name} 雙臂抱胸站到隊伍前面，一邊喘氣一邊瞪著敵人`,
  action: (self, rest, logger, engine) => {
    self.addBuff({ id: 'stand_guard', name: '擋在前面', type: 'STAT', duration: 2,
      effect: stats => { stats.aggro = (stats.aggro ?? 1) * 3; } }, engine);
  }
}
```

喘息仍不算出手：不通知 `AFTER_ACTION`、不進 `actionSlots`。原本喘息完全沒有掛勾，
「喘息時改擺架勢」只能事後改寫日誌。

## 出招之前（`BEFORE_SKILL_CAST` 被動，1.0.35）

`AFTER_SKILL_CAST` 的前置版。每次 `Skill.execute` 開始、第一段效果之前，引擎對施放者的**敵方**
存活單位執行 `trigger: 'BEFORE_SKILL_CAST'` 的被動，簽名是 `(self, cast, logger, engine)`：

| 欄位 | 說明 |
| --- | --- |
| `caster`、`skill` | 施放者與這一招 |
| `isCounter` | 這次執行是反擊的還擊 |
| `isNormalAttack` | 普攻，或派發型普攻帶出的子技能 |
| `damageMultiplier` | 預設 1。被動可以改它；這次執行的每一擊傷害在 `action.damageMultiplier` 之後、`takeDamage` 之前乘上它並取整。必須是有限的非負數，否則拋錯 |

```js
// 干擾對手的法術：這一招的傷害減半
{
  id: 'disturb', trigger: 'BEFORE_SKILL_CAST',
  enabled: (self, cast) => !cast.isCounter && !cast.isNormalAttack,
  action: (self, cast, logger) => {
    cast.damageMultiplier *= 0.5;
    logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name} 擾亂了 ${cast.skill.name}！` });
  }
}
```

- 範圍與 `AFTER_SKILL_CAST` 相同：子技能、反擊技能、普攻都會各問一次。派發型普攻的外層與子技能各問一次，
  兩次的倍率各自只管自己那一次執行裡的擊數。
- 只改傷害，不取消招式：SP 照付、命中照擲、反擊照判定。日誌印在這一招的第一行之前。
- 沒有被動使用時不擲骰、不改任何數值，戰鬥亂數序列與 1.0.34 相同。

原本「替隊友擋下對手的招式」只能寫在防守方自己的 `BEFORE_DAMAGE`，旁邊的隊友插不上手。
測試：`tests/beforeSkillCast.test.js`。

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

## 行動目標改向（`actionTargetResolver`，1.0.17；`excludeSelf`，1.0.32）

`BattleEngine` 選項 `actionTargetResolver({ caster, skill, allies, enemies, engine })` 在每個行動槽出招前問一次，可以回傳：

- 陣列：這一招所有對敵 `DAMAGE` 段改打陣列裡的單位（治療、增益不受影響）。
- `{ swapSides: true }`：整招敵我反轉，非 `SELF` 的目標類型全部鏡像，攻擊打隊友、治療與增益送給對面。
  反轉後的 `ALLY_*` 包含施放者自己，適合「分不清敵我」的混亂。
- `{ targets: [...], uncounterable: true }`（1.0.37）：跟陣列一樣改打指定單位，但這些擊不可反擊，
  在反擊擲骰前就排除。適合「被別人的力道牽著打到隊友」的挪移類效果：挨打的人並沒有跟施放者交手。
  省略 `uncounterable` 時與陣列相同。
- `{ swapSides: true, excludeSelf: true }`（1.0.32）：同上，但反轉後選出來的我方目標不含施放者。
  適合附身、催眠這類「被操控、換了一邊」的效果：操控者不會拿宿主的拳頭打宿主。
  隊上只剩施放者自己時，反轉後的那一段沒有目標，直接跳過。
- `null`／`undefined`：照常。

改向只在行動槽開頭判定一次，套用到這個行動槽裡施放者自己出的每一段：`CAST_SKILL`、
在 `execute` 裡呼叫的子技能都吃同一個結果。別人的反擊、別人的觸發技能不受影響。
`engine.swapExcludesSelf(caster)` 回報目前這個行動槽是否處於 `excludeSelf` 的反轉。

### 延後到挑目標時才判定（`targetSelectionResolver`，1.0.41）

`actionTargetResolver` 在出招前就得回答，所以只能從 `skill.actions` 的形狀猜這招會不會挑目標。
猜不準的典型是「外殼技能」：最外層只放一段扣 SP 的 `TEXT`，真正的攻擊或治療寫在 `execute` 裡呼叫子技能。
`targetSelectionResolver({ caster, skill, targetType, engine })` 把問的時機挪到**這個行動槽第一次挑「不是自己」的目標時**，
回傳格式與 `actionTargetResolver` 相同，答案沿用到行動槽結束。

- 只挑 `SELF` 的招式從頭到尾不會問。沒寫 `targetType` 的 `TEXT` 也不算挑目標（它預設成 `ENEMY_SINGLE` 只是歷史包袱）。
- `actionTargetResolver` 回傳非 `null` 時以它為準，這個行動槽不再問 `targetSelectionResolver`。
- 插隊行動也會問（`actionTargetResolver` 維持不介入插隊行動，免得改掉既有消費者的行為）。
- `targetType` 是觸發判定的那一段原本的目標類型，給「附身時只攔對敵攻擊」這類判斷用。

**自己挑目標的招式要走框架的入口，不要直接讀 `enemies`／`allies`：**

- `engine.targetPool(caster, targetType)`：這次挑 `targetType` 時實際可選、還活著的人。會先觸發延後的判定；
  反轉時 `ENEMY_*` 給我方、`ALLY_*` 給敵方，`excludeSelf` 一併處理；固定改向（`{ targets }`）只改 `ENEMY_*`。
  「挑血最少的」「挑層數最多的」這類自訂規則，從這裡拿候選再自己挑。
- `engine.selectTargets(caster, targetType)`：照框架預設規則挑（單體敵人吃仇恨、單體隊友均勻抽、全體就是整個候選）。

用這兩個入口挑出來的目標，用 `options.targets` 指定給子技能時，反轉下照樣算數
（判斷方式是「全都站在反轉後那一邊」，見 `engine.forcedTargetsFollowSwap`）。
直接從 `enemies` 挑的在反轉下照舊作廢、依反轉後的 `targetType` 重抽——這是 1.0.41 之前對所有指定目標的處理，
所以先打一段、再對「同一個人」補一段的招式，第二段會落到別人身上，甚至因為找不到人而整段跳過。

延後判定是這一段才得出反轉時，前面沒寫 `targetType` 的 `TEXT` 抓到的還是反轉前那一邊的目標，
這一段不會延續它，而是照反轉後的 `targetType` 重新挑。

## 插隊行動（`engine.insertAction`，1.0.38）

`engine.insertAction(entity, skill, { onSkip })` 讓 `entity` 在**目前這個行動槽結束後、下一個行動槽開始前**
額外執行一次 `skill`。給「能量滿了隨時可以放」的終結技、追加攻擊這類不照速度排隊的行動用；
通常在 `AFTER_ACTION` 被動裡呼叫，插在剛出手的那個人後面。

- 插隊的那一槽是完整的行動槽：執行完結算死亡與勝負、通知 `AFTER_ACTION`、記進 `actionSlots`（帶 `inserted: true`）。
- 它不是速度排出來的那一槽：不擲麻痺、不跑幸運事件與疲勞、不扣 Buff 的持續時間、不吃速度連擊（`inBasicAttackSlot` 為 false）。
- 輪到它時 `entity.canAct()` 為 false（倒下、必定暈眩、恐慌），這次插隊取消，呼叫 `onSkip(entity, skill)`。
  「插隊之前被打暈就放不出來」是刻意的，遊戲可以靠它做打斷。
- 多個插隊依排入順序執行；插隊裡再排的插隊接在後面，同一個空檔一起跑完。
- 回合開始時排入的插隊，在該回合第一個行動槽之前執行；回合最後一槽之後排入的，在回合結束前執行。
- 戰鬥分出勝負時，沒輪到的插隊作廢。

在這之前，遊戲層只能在 `AFTER_ACTION` 被動裡直接呼叫 `skill.execute`：那一下不算行動槽，
別人的 `AFTER_ACTION` 看不到它、`actionSlots` 也不記，戰報重播會把它併進前一個人的槽。
典型用途是條件達成後立刻追加的終結技。
