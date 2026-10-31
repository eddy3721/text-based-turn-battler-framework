# API 參考

這份是「查表用」的完整清單：每個建構參數、能力值、action 欄位、觸發器、引擎選項與日誌類型。
規則背後的理由與邊界情況寫在各主題文件，表格裡會連過去。想先看能跑的程式，從 [examples/](../examples) 開始。

```js
const {
  Entity, Skill, Buff, BattleEngine, Formulas,
  random, createSeededRandom,   // 亂數（1.0.45）
  Sanity, createSanityRules      // 可選的理智系統，見 SANITY.md
} = require('text-based-turn-battler-framework');
```

## 一場戰鬥怎麼跑

```text
new BattleEngine(teamA, teamB, options).start()
  BATTLE_START 日誌 → openingLogs → 開場台詞（dialogues.opening）→ BATTLE_START 被動
  每回合（最多 maxTurns 回合）：
    TURN_START 日誌 → options.roundStart → ROUND_START 被動 → ROUND_START 觸發型 Buff
    排出行動順序：每個存活單位 2 個行動槽，依 spd 加權抽籤（抽中的人 spd 暫時降 3/4）
    每個行動槽：
      DOT/HOT 結算 → 暈眩／麻痺擲骰 → BEFORE_ACTION 觸發型 Buff → 幸運事件
      → 選招：openingSkill（第一次行動）> 以 skillCastRate 機率從 skills 抽一招 > normalAttack
        （普攻付不出 SP 時改為喘息 REST）
      → actionTargetResolver / skillSelectionResolver → 執行 → AFTER_ACTION 被動
      → 這個單位的 Buff 持續時間 -1
      → 插隊行動（engine.insertAction 排進來的）
  勝負已定或回合用盡 → options.battleEnd → BATTLE_END 日誌
回傳 { winner: 'TEAM_A' | 'TEAM_B' | 'DRAW', logs, finalTeamA, finalTeamB }
```

- **一次跑完**：`start()` 是同步的，回傳整場的戰報。前端要做逐行播放，就自己用計時器讀 `logs`。
- **Entity 會被改寫**：戰鬥中 HP、SP、Buff 都直接改在傳進去的物件上。每場戰鬥請重新建立 Entity
  （被動裡的計數器也一樣，放在建立函式的閉包裡，見 [examples/boss-fight.js](../examples/boss-fight.js)）。
- **同名自動編號**：兩個「史萊姆」會變成「史萊姆」「史萊姆2」，`id` 不變。結算時請用 `id` 找回單位。

## Entity

```js
new Entity({ id, name, team, stats, normalAttack, skills, passives, ... })
```

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `id` | 必填 | 戰鬥內唯一。日誌用 `actorId` / `targetId` 指向它 |
| `name` | 必填 | 戰報顯示名稱。同名會被自動編號 |
| `team` | 必填 | `'A'` 或 `'B'`，要和放進 `teamA` / `teamB` 的位置一致 |
| `stats` | 必填 | 能力值，見下表。會被複製，不會改到你傳入的物件 |
| `normalAttack` | — | 普攻用的 `Skill`。沒有普攻又抽不到技能時，這一槽會略過 |
| `skills` | `[]` | 主動技能。每個行動槽以 `skillCastRate` 機率，從「付得起 SP 的」裡均勻抽一招 |
| `openingSkill` | `null` | 第一次行動必定使用（付得起時） |
| `counterSkill` | `null` | 反擊時用的技能；沒有就用框架的 ×1 反擊。見 [COUNTERS.md](COUNTERS.md) |
| `passives` | `[]` | 被動，見「被動與觸發器」 |
| `buffs` | `[]` | 開場就帶著的 Buff 設定 |
| `dialogues` | `{}` | `{ opening, death, victory }` 台詞字串，各印一次（`BOSS_DIALOGUE`） |
| `parts` | `[]` | 可破壞部位 `[{ id, name, maxDurability }]`，見 [DAMAGE_REACTIONS.md](DAMAGE_REACTIONS.md) |
| `actionDisabled` | `false` | 不能行動的目標（木樁、水晶），見 [INANIMATE.md](INANIMATE.md) |
| `lockedStats` | `[]` | 這些能力值的生效值一律為 0 |
| `fatigueEnabled` | `true` | 疲勞機制，見 [FATIGUE.md](FATIGUE.md) |
| `normalAttackSpCost` | `1` | 普攻每一擊消耗的 SP |
| `sanity` | `false` | 理智系統設定，見 [SANITY.md](SANITY.md) |

常用方法（被動裡會用到）：`addBuff(config)`、`removeBuffs('positive' | 'negative')`、`heal(amount)`、
`restoreSp(amount)`、`takeDamage(amount, logger, context)`、`getEffectiveStats()`、`changeSanity(delta, logger)`。
狀態欄位：`isAlive`、`stats`（原始值，HP/SP 直接在這裡）、`buffs`、`team`。

### 能力值（stats）

框架只讀下面這些欄位；其他欄位（例如遊戲自己的 `str`、`tec`）照樣會保留，可以拿來當 `action.stat`。

| 欄位 | 預設 | 框架怎麼用 |
| --- | --- | --- |
| `hp` | 必填 | 目前 HP。歸零即倒下 |
| `maxHp` | `hp` | HP 上限（治療、`HP_BELOW`、`revive` 用） |
| `sp` | `0` | 目前 SP。技能段落的 `spCost`、普攻的逐擊消耗都從這裡扣 |
| `maxSp` | `sp` | SP 上限。SP 比例決定疲勞階段 |
| `atk` | 應設定 | DAMAGE / HEAL 預設讀的能力值；讀不到會直接拋錯 |
| `def` | `0` | 減傷：`傷害 × 300 / (def + 300)` |
| `spd` | 應設定 | 行動順序權重；速度差決定普攻連擊數。沒給的話沒有人會行動，整場打成平手 |
| `hit` | `0` | 命中加成，每點 +1% |
| `eva` | `0` | 閃避：`eva / (eva + 100)`。命中率保底 10% |
| `cri` | `0` | 爆擊率（0～1） |
| `criDmg` | `1.5` | 爆擊倍率 |
| `counter` | `0` | 反擊點數，0 表示不反擊。機率看雙方點數差，見 [COUNTERS.md](COUNTERS.md) |
| `luk` | `0` | 幸運。對手比你幸運時，你可能觸發幸運事件，見 [LUCK_EVENTS.md](LUCK_EVENTS.md) |
| `aggro` | `1` | 被敵方單體技能選中的權重，見 [AGGRO.md](AGGRO.md) |
| `skillCastRate` | `0.35` | 每個行動槽改用技能的機率，見 [SKILL_MODIFIERS.md](SKILL_MODIFIERS.md) |
| `int` 等任意欄位 | — | 只在 `action.stat` 指定時才會被讀 |

傷害：`floor(能力值 × power × 減傷 × 0.9～1.1)`（至少 1），之後依序套用連擊遞減、爆擊、`damageMultiplier`。
完整順序見 [PROTECTION.md](PROTECTION.md)。

## Skill

```js
new Skill({ id, name, actions: [...], tier, tags, uncounterable, counterChanceMultiplier, counterStyle })
```

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `id` / `name` | 必填 | `name` 會出現在預設戰報裡 |
| `actions` | `[]` | 依序執行的段落。中途 SP 不夠就停在那一段 |
| `tier` | `'standard'` | 自由字串，寫進日誌的 `skillTier`，給 UI 區分大招 |
| `tags` | `[]` | 自由標籤，會合併進 `hit.tags`，見 [TAGS.md](TAGS.md) |
| `uncounterable` | `false` | 整招不會被反擊 |
| `counterChanceMultiplier` | `1` | 每一擊被反擊的機率倍率（0～1） |
| `counterStyle` | `'summary'` | 當作 `counterSkill` 時的戰報呈現：`'summary'` 或 `'detailed'` |

### 施放結果（`execute` 的回傳值，1.0.47）

`skill.execute(caster, allies, enemies, logger, engine, options)` 回傳這一次施放的結果：

```js
const report = hit.execute(caster, allies, enemies, logger, engine, { targets: [target] });
for (const unit of report.landed) unit.addBuff(stun, engine); // 只掛在真的打到的人身上
```

| 欄位 | 說明 |
| --- | --- |
| `skill` / `caster` | 這一次施放 |
| `landed` | 至少打到一擊的目標（含被格擋、被護盾吃掉） |
| `targets` | 每個出手過的目標一筆：`target`、`attempts`、`landed`、`missed`、`countered`、`blocked`、`crits`、`damage`、`actualDamage`、`shieldAbsorbed`、`defeated` |

範圍是這一次 `execute` 的傷害段：別人的反擊、`CAST_SKILL` 叫出來的子技能各有自己的結果。
覆寫了 `execute` 的技能不一定會把結果往上傳，直接走基底 `Skill` 的呼叫才保證拿得到。
附帶效果用它判斷，不要翻 `logger.logs` 找 `MISS`、也不要在打之前記血量比較：混亂把目標換掉時兩種都會判錯。

### action 共通欄位

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `type` | 必填 | 見下表 |
| `targetType` | `'ENEMY_SINGLE'` | `ENEMY_SINGLE`（依 aggro 加權抽）、`ENEMY_ALL`、`ALLY_SINGLE`（均勻抽）、`ALLY_ALL`、`SELF` |
| `inheritTarget` | `true` | **沿用上一段的目標**，只有上一段沒有目標時才依本段的 `targetType` 重選。要換目標請設 `false` |
| `spCost` | `0` | 這一段的 SP 消耗 |
| `requiresDamage` | `false` | 只對「這一招前面的段落真的造成傷害的目標」執行 |
| `text` | — | 覆寫預設戰報的片段（字串或 `ctx => string`），見下方「戰報文字」 |
| `message` | — | `ctx => string`，整句覆寫，優先於 `text` |

> 常見的坑：多段技能第一段是沒寫 `targetType` 的 `TEXT`，它會先抽一個敵人，後面的 `ENEMY_ALL` 傷害段因為沿用目標，只會打到那一個人。
> 讓第一段也寫 `targetType: 'ENEMY_ALL'`，或在傷害段設 `inheritTarget: false`。

### action 類型

| `type` | 專屬欄位 | 日誌 |
| --- | --- | --- |
| `DAMAGE` | `power`（1）、`stat`（`'atk'`）、`hits`（1）、`combo`（依速度差決定段數）、`damageDecay`（連擊遞減 0.4）、`accuracy`（1）、`hitOrder`（`'target'` / `'wave'`，見 README）、`damageMultiplier`、`ignoreDefense`、`ignoreInvincible`、`ignoreShield`、`uncounterable`、`partDamageMultiplier`、`tags` | `DAMAGE` / `BLOCK` / `MISS` / `COUNTER` |
| `HEAL` | `power`（1）、`stat`（`'atk'`，或權重表 `{ atk: 0.5, int: 1 }`）。讀施放者的原始能力值 | `HEAL` |
| `BUFF` | `buffs: [Buff 設定, ...]`（**陣列**） | `BUFF_APPLY` |
| `RESTORE_SP` | `amount` | `SP_RECOVER` |
| `CHANGE_SANITY` | `amount`（可正可負） | `SANITY_CHANGE` |
| `SUMMON` | `monsterId` 或 `monsterIds`（隨機抽一個）、`maxTotal`（4）、`maxAlive`（2）、`failMessage`。需要引擎選項 `summonFactory` | `SUMMON` / `SUMMON_FAILED` |
| `CAST_SKILL` | `skillIds: [...]`，從中隨機施放一個可施放的（不看 SP）。需要引擎選項 `skillResolver`，子技能不扣 SP | 子技能自己的日誌 |
| `TEXT` | 只印一行文字 | `SKILL_TEXT` |

普攻（`normalAttack` 的 DAMAGE 段）與 `combo: true` 的段數由速度差決定，第 2 擊起傷害遞減。

### 戰報文字

每種 type 的預設句由片段拼成，只覆寫想改的片段即可：

| type | 拼法 | 預設 |
| --- | --- | --- |
| `DAMAGE` | `action`（第 2 擊起用 `combo`）+ 爆擊時 `crit` + `hit`；落空 `miss`；格擋 `block` | 「X 攻擊，」「第 N 擊，」「會心一擊！」「對 Y 造成了 N 點傷害！」 |
| `HEAL` | `action` + `heal` | 「X 治療，」「使 Y 回復了 N 點生命！」 |
| `BUFF` | `action` + `buff` | `''`（空字串）+「Y 被附加了 Z 狀態！」 |
| `RESTORE_SP` | `action` + `recover` | |
| `SUMMON` | `action` + `summon`（失敗時 `fail`） | |
| `TEXT` | `action` | 「X 使用了 技能名！」 |

片段可以是字串，或接收 `ctx` 的函式。`ctx` 欄位一律存在：
`{ caster, target, targets, value, isCrit, hitIndex, buff, skill, blocked, blockMethod, evadeMethod }`。
`hitOrder: 'wave'` 另有 `text.wave`（第 2 波起的過場）。

## Buff

Buff 用設定物件表示：放在 BUFF action 的 `buffs`、Entity 的 `buffs`，或在被動裡 `entity.addBuff(config)`。

| 欄位 | 說明 |
| --- | --- |
| `id`、`name` | `name` 會出現在戰報 |
| `type` | `'STAT'`（改能力值）、`'DOT'`（每槽扣 `value`）、`'HOT'`（每槽回 `value`）、`'STUN'`（無法行動） |
| `duration` | 持有者的**行動槽**數；每次輪到他行動後減 1 |
| `value` | DOT / HOT 的數值 |
| `effect` | `STAT` 用：`stats => { stats.atk *= 1.3; }`，作用在 `getEffectiveStats()` 的副本上 |
| `chance` | `STUN` 每個行動槽被擋下的機率（預設 1 = 必定） |
| `message` | `STUN` / 沉默被擋時的句子，字串或 `({ entity, buff, skill }) => string` |
| `stackPolicy` | `'refresh'`：同 id 的舊 Buff 先移除再加（預設會疊加） |
| `polarity`、`dispellable` | `'positive' / 'negative' / 'neutral'`，搭配 `entity.removeBuffs()` 驅散，見 [PROTECTION.md](PROTECTION.md) |
| `shield` | 護盾量，吸收傷害，扣完就碎（`SHIELD_BREAK`） |
| `invincible` | 攻擊命中但傷害歸零（`BLOCK`） |
| `untouchable` | 攻擊必定落空且不擲骰（`MISS`） |
| `damageTaken` | `{ multiplier, filter?(hit) }` 承受傷害倍率 |
| `healTaken` | `{ multiplier }` 承受治療倍率（減療） |
| `silence` | `true` 或 `{ filter(skill, entity), fallback }`，見 [SILENCE.md](SILENCE.md) |
| `tags` | 自由標籤，DOT 傷害會帶上 |
| `trigger`、`skillIds`、`remainingTriggers` | 觸發型 Buff：在 `'BEFORE_ACTION'` 或 `'ROUND_START'` 施放 `skillIds` 中的一招，用完次數就移除 |

## 被動與觸發器

被動是普通物件，放在 Entity 的 `passives`：

```js
{
  trigger: 'AFTER_ACTION',                         // 什麼時候跑
  enabled: (self, ctx) => ctx.actor === self,      // 可選：回傳 false 就略過
  action: (self, ctx, logger, engine) => { ... }   // 做事
}
```

在 `action` 裡寫戰報：`logger.addLog({ type: 'SKILL_TEXT', actorId: self.id, message: '...' })`。
要擲骰請用框架匯出的 `random()`，不要用 `Math.random()`，否則傳了 `rng` 也無法重現。

| trigger | 誰收到 | `ctx` | 簽名 | 說明 |
| --- | --- | --- | --- | --- |
| `BATTLE_START` | 每個存活單位 | `{ maxTurns }` | `(self, ctx, logger, engine)` | 第 1 回合之前一次。見 [ACTIONS.md](ACTIONS.md) |
| `ROUND_START` | 每個存活單位（`whileDead: true` 的倒下單位也跑） | `{ round }` | 同上 | 每回合開始 |
| `AFTER_ACTION` | 兩隊所有存活單位 | `{ actor, skill }` | 同上 | 一個行動槽真的出手之後 |
| `AFTER_REST` | 喘息的單位 | `{ value }` | 同上 | 喘息之後；被動可提供 `restMessage(self, ctx)` 換掉喘息台詞 |
| `BEFORE_SKILL_CAST` | 施放者的敵方 | `{ caster, skill, damageMultiplier, isCounter, isNormalAttack }` | 同上 | 出招之前；改 `ctx.damageMultiplier` 會影響這一招所有傷害段 |
| `AFTER_SKILL_CAST` | 施放者的敵方 | `{ caster, skill }` | 同上 | 每次技能執行完 |
| `AFTER_ALLY_SKILL_CAST` | 施放者的存活隊友（不含施放者） | `{ caster, skill }` | 同上 | 同上，給要看自己人出招的被動（1.0.48） |
| `BEFORE_DAMAGE` | 受擊者 | `hit` | `(self, hit, logger)` | 改 `hit.damage`、設 `hit.blocked` / `hit.blockMethod`。可重複觸發 |
| `LAST_STAND` | 受擊者 | `hit` | `(self, hit, logger)` | 只在這一擊仍會致死時；把 `hit.damage` 壓到 `hp - 1` 就能保命。台詞會排在傷害那行之後 |
| `AFTER_DAMAGE_RECEIVED` | 受擊者 | `hit` | `(self, hit, logger, engine)` | 每一擊、真的掉血之後 |
| `AFTER_DAMAGE_DEALT` | 攻擊者 | `hit` | 同上 | 每一擊、目標還活著時 |
| `AFTER_ATTACK_RECEIVED` | 受擊者 | 整招的彙總 `hit` | 同上 | 一招打完、每個目標一次 |
| `AFTER_ATTACK_DEALT` | 攻擊者 | 整招的彙總 `hit` | 同上 | 同上的攻擊方版本 |
| `ON_PART_BREAK` | 受擊者 | `hit` | 同上 | 部位被破壞 |
| `ON_EVADE` | 閃避者 | `evasion` | `(self, evasion)` | 落空之前描述怎麼躲：設 `evadeMethod`（片段）或 `evadeMessage`（整句）。不能寫日誌。見 [EVASION.md](EVASION.md) |
| `AFTER_EVADE` | 閃避者 | `evasion` | `(self, evasion, logger, engine)` | 落空之後的反應 |
| `ON_SANITY_CHANGE` / `ON_SANITY_STATE_CHANGE` | 理智變動的單位 | 見 [SANITY.md](SANITY.md) | | |

另一種寫法是血量門檻：`{ condition: 'HP_BELOW', threshold: 0.5, action: (self, logger, engine) => {} }`，
HP 比例第一次降到門檻以下時執行一次。**注意簽名沒有 ctx。**

被動上還可以放 `enemySkillCastMultiplier`（搭配 `id`）：持有者存活時，敵方的技能施放率乘上這個值，見 [SKILL_MODIFIERS.md](SKILL_MODIFIERS.md)。

`hit` 主要欄位：`caster`、`target`、`skill`、`action`、`damage`（可改）、`actualDamage`、`lethal`、`blocked`、
`blockMethod`、`isCrit`、`hitIndex`、`hits`、`isNormalAttack`、`isCounter`、`tags`、`shieldAbsorbed`、
`source`（`'ATTACK'` / `'DOT'` / `'LUCK_EVENT'` / `'DIRECT'`）。

## BattleEngine

```js
new BattleEngine(teamA, teamB, options).start()
```

| 選項 | 說明 |
| --- | --- |
| `maxTurns` | 回合上限，預設 100，用盡為 `DRAW` |
| `rng` | `() => [0, 1)`，只在 `start()` 期間取代 `Math.random`。搭配 `createSeededRandom(seed)` 重現戰鬥 |
| `luckEvents` | `{ enabled: false }` 關閉幸運事件 |
| `openingLogs` | 開場時照原樣插入的日誌陣列 |
| `summonFactory` | `(monsterId, { entityId }) => Entity \| null`，`SUMMON` 用。回傳的 Entity 設 `summonHostile: true` 會加入對面 |
| `skillResolver` | `(skillId) => Skill`，`CAST_SKILL` 與觸發型 Buff 用 |
| `roundStart` | `(engine) => void`，每回合 TURN_START 之後 |
| `battleEnd` | `(engine) => void`，勝負已定、BATTLE_END 之前，可補結尾日誌 |
| `hitResolver` | `({ caster, target, skill, action, hitIndex, turn, engine }) => { hitRateModifier, forceMiss, evadeMessage, hitMessage, afterRoll }`，逐擊調整命中 |
| `actionTargetResolver` | `({ caster, skill, allies, enemies, engine })`，出手前改目標：回傳目標陣列、`{ targets, uncounterable }`、`{ swapSides: true, excludeSelf? }`（混亂），或 `undefined` |
| `targetSelectionResolver` | 參數多了 `targetType`，在行動槽第一次挑目標時才問一次，回傳格式同上 |
| `strictTargeting` | `true` 時，敵我反轉下直接從原本那一邊挑的 `options.targets` 會拋錯，而不是悄悄重抽。給測試與平衡腳本開 |
| `skillSelectionResolver` | `({ caster, skill, allies, enemies, engine }) => Skill \| undefined`，換掉這一槽抽到的招 |

鉤子裡可以用的 `engine` 成員：

| 成員 | 說明 |
| --- | --- |
| `engine.logger.addLog(entry)` / `engine.logger.logs` | 寫日誌 / 目前所有日誌 |
| `engine.teamA` / `engine.teamB` / `engine.currentTurn` / `engine.result` | 戰場狀態 |
| `engine.actionSlots` | `[{ actor, skill, turn, start, end, inserted? }]`，每個出手的行動槽在 `logs` 裡的範圍 |
| `engine.insertAction(entity, skill, { onSkip })` | 插隊：目前行動槽結束後立刻讓 entity 施放 skill |
| `engine.castSkill(entity, skillIds)` | 立即施放（不佔行動槽、不扣 SP） |
| `engine.revive(entity, hp)` | 讓倒下的單位復活 |
| `engine.targetPool(caster, targetType)` / `engine.selectTargets(caster, targetType)` | 自己挑目標時用，會套用混亂等改目標效果 |
| `engine.settleDeaths()` / `engine.checkWinCondition()` | 直接改 HP 之後手動結算 |

## 日誌（result.logs）

每筆都有 `type` 與 `message`（中文戰報句）。UI 可以直接印 `message`，也可以依 `type` 和欄位自己排版。

常見欄位：`actorId`（做事的人）、`targetId`、`skillId`、`skillTier`、`isNormalAttack`、`value`（數值）、
`isCrit`、`isCounter`（反擊途中產生的日誌）。

| type | 什麼時候 | 額外欄位 |
| --- | --- | --- |
| `BATTLE_START` / `BATTLE_END` | 開始 / 結束 | |
| `TURN_START` | 每回合開始 | `turn` |
| `DAMAGE` | 打中並造成傷害 | `value`、`actualDamage`、`isCrit`、`shieldAbsorbed`、`partId` |
| `BLOCK` | 打中但被格擋、護盾或無敵吸收 | 同上，`blocked: true` |
| `MISS` | 落空 | `evadeMethod` |
| `COUNTER` | 這一擊被反擊（取代原本的傷害行） | `value`（反擊傷害）、`incomingSkillId`、`isCrit` |
| `HEAL` | 治療 | `value` |
| `SP_RECOVER` | 回復 SP | `value` |
| `BUFF_APPLY` | 附加 Buff | |
| `BUFF_EFFECT` | DOT / HOT 結算 | `buffId`、`buffType`（`'DOT'` / `'HOT'`）、`value` |
| `SHIELD_BREAK` | 護盾碎掉 | `buffId` |
| `PART_BREAK` | 部位被破壞 | `partId`、`partName` |
| `SILENCED` | 招式被沉默擋下 | `buffId`、`skillId` |
| `SKILL_TEXT` | 技能的文字段、被動寫的台詞 | |
| `TEXT` | 暈眩、略過等系統文字 | `buffId`（暈眩時） |
| `BOSS_DIALOGUE` | `dialogues` 台詞、`hitResolver` 的 `hitMessage` | |
| `DEATH` | 倒下 | |
| `FATIGUE` / `FATIGUE_SKIP` / `REST` | 疲勞變嚴重 / 累到不能動 / 喘息 | `stage` / — / `value` |
| `LUCK_EVENT` | 幸運事件 | `tier`（`'PURPLE'` / `'RED'`）、`value`、`opponentId` |
| `SUMMON` / `SUMMON_FAILED` | 召喚成功 / 沒有增援 | `targetId`（召喚物） |
| `SANITY_CHANGE` | 理智變動 | 見 [SANITY.md](SANITY.md) |

## 亂數

| 匯出 | 說明 |
| --- | --- |
| `createSeededRandom(seed)` | 整數種子 → `() => [0, 1)`（mulberry32），給 `rng` 選項 |
| `random()` | 框架目前的亂數來源。被動與鉤子裡要擲骰就用它 |

沒傳 `rng` 時就是 `Math.random`，行為與 1.0.44 以前相同。

## 常見的坑

1. **重用 Entity**：同一個物件跑第二場，HP、Buff、被動狀態都還是上一場的。每場重建。
2. **`BUFF` 要寫 `buffs: [...]`**，不是 `buff: {...}`；寫錯不會報錯，只是什麼都不會附加。
3. **多段技能沿用目標**：見上面 `inheritTarget` 的說明。
4. **`BEFORE_DAMAGE` / `LAST_STAND` 沒有 `engine` 參數**，`HP_BELOW` 的簽名是 `(self, logger, engine)`。
5. **`duration` 算的是持有者的行動槽**，不是回合。每回合每人大約 2 槽。
6. **鉤子裡擲骰用 `random()`**，否則同一個種子跑不出同一場。
7. **讀能力值用 `getEffectiveStats()`**，`stats` 是原始值；`STAT` Buff 只影響前者。
8. **自己挑目標要走 `engine.targetPool` / `selectTargets`**，附帶效果看 `execute` 回傳的 `landed`。直接從 `enemies` 挑人再對同一個人上效果，
   混亂時傷害會被換到別人身上、效果卻留在原處。測試開 `strictTargeting: true` 可以抓出這種寫法。
