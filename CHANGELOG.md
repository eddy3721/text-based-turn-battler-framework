# 更新紀錄

版本號只往上加，不重複使用同一個版本號重新打包。沒有特別註明時，既有技能的行為與亂數序列不變。

## 1.0.44（2026-10-21）

- 多目標 `HEAL` 不再為實際恢復量 0（已滿血）的目標印日誌；`ON_HP_CHANGE` 照常執行。單體治療仍會印 0，讓施放看得見。

## 1.0.43（2026-10-20）

- `ROUND_START` 被動可加 `whileDead: true`，持有者倒下時仍會在回合開始執行。
- 新增 `engine.revive(entity, hp)`：讓倒下的單位站回來，並清掉死亡紀錄。

## 1.0.42（2026-10-19）

- `hitResolver` 可回傳 `{ forceMiss: true }`，該擊不擲命中骰直接落空；閃避情境帶 `forcedMiss: true`。

## 1.0.41（2026-10-17）

- 新增 `targetSelectionResolver`：行動槽第一次選目標時詢問一次，整槽沿用；新增 `engine.targetPool`、`engine.selectTargets`。

## 1.0.40（2026-10-17）

- 新增 `BATTLE_START` 被動：戰鬥開場、第 1 回合之前執行。

## 1.0.39（2026-10-14）

- `LAST_STAND` 寫的日誌改在那一擊自己的日誌之後才印。

## 1.0.38（2026-10-14）

- 新增護盾 `shield` 與插隊行動 `engine.insertAction`，插隊會在下一個空檔佔一個真正的行動槽。

## 1.0.37（2026-10-12）

- `actionTargetResolver` 可回傳 `{ targets, uncounterable: true }`：改寫目標的同時，這一槽的攻擊不會被反擊。

## 1.0.36（2026-10-07）

- 濃縮反擊（`counterStyle: 'summary'`）只丟掉還擊者自己的開場白，保留其他單位的 `SKILL_TEXT`。

## 1.0.35（2026-10-06）

- 新增 `BEFORE_SKILL_CAST` 被動：對手出招之前，旁邊的隊友也能介入、調整這一招的傷害。

## 1.0.34（2026-10-06）

- 新增 `AFTER_REST` 被動：喘息之後執行。

## 1.0.33（2026-10-05）

- 新增 `healTaken` 受治療倍率。

## 1.0.32（2026-10-04）

- `actionTargetResolver` 的 `{ swapSides: true }` 可加 `excludeSelf: true`，交換陣營後的友方目標不含施放者自己。

## 1.0.31（2026-10-04）

- 多段 `ENEMY_ALL` 可設 `hitOrder: 'wave'`，改成逐波掃過所有目標。

## 1.0.30（2026-10-04）

- 新增沉默：擋下指定招式，普攻被擋時改用替代攻擊。見 [docs/SILENCE.md](docs/SILENCE.md)。

## 1.0.29（2026-10-04）

- DOT／HOT 結算日誌帶上 `buffId` 與 `buffType`。

## 1.0.28（2026-10-03）

- 新增行動槽紀錄 `actionSlots` 與戰鬥結束鉤子 `battleEnd`。

## 1.0.27（2026-09-30）

- 新增 `LAST_STAND` 被動：這一擊會致死時，最後執行一次。

## 1.0.26（2026-09-29）

- `HEAL` 的 `stat` 可用能力值權重表；新增承受傷害倍率 Buff；滿血時 HOT 不再印日誌。

## 1.0.25（2026-09-29）

- 新增 `AFTER_ACTION` 被動：行動槽真的出手後，通知場上所有存活單位。
- 新增 `ROUND_START` 被動：每回合開始時執行。

## 1.0.24（2026-09-28）

- 新增 `untouchable` Buff：攻擊不擲骰，必定落空。

## 1.0.23（2026-09-27）

- 技能、傷害段與 Buff 可帶自由標籤，傷害結算時合併成 `hit.tags`。見 [docs/TAGS.md](docs/TAGS.md)。

## 1.0.22（2026-09-23）

- 新增可選用的理智系統（預設關閉），並匯出 `Sanity`。見 [docs/SANITY.md](docs/SANITY.md)。

## 1.0.17–1.0.20（2026-09-22）

- `BattleEngine` 新增四個選項：`roundStart`、`hitResolver`、`actionTargetResolver`（可回傳 `{ swapSides: true }`）、`skillSelectionResolver`。
- `Formulas.isHit` 新增第四個參數 `hitRateModifier`。

## 1.0.16

- 新增 `AFTER_EVADE`：閃避之後的反應，在 MISS 日誌之後執行。見 [docs/EVASION.md](docs/EVASION.md)。

## 1.0.15

- 新增仇恨值 `aggro`：`ENEMY_SINGLE` 依仇恨加權抽選目標。權重相同時抽到的位置與舊版相同。見 [docs/AGGRO.md](docs/AGGRO.md)。
- 1.0.14 打包後作廢：只剩一個候選人時少擲一次骰，會讓 1v1 的亂數序列位移。

## 1.0.13

- 新增可選用的無敵、貫通、公式後的傷害縮放，以及明確的 Buff 正負面與解除規則。見 [docs/PROTECTION.md](docs/PROTECTION.md)。

## 1.0.12

- 反擊率上限由 0.3 降為 0.2：技巧相同時由 15% 降為 10%。

## 1.0.11

- 新增 `uncounterable`：整個技能或單一傷害段不進入反擊判定，也不消耗亂數。

## 1.0.10

- 疲勞也會降低 `skillCastRate`：TIRED −10、EXHAUSTED −15 個百分點。

## 1.0.9

- 所有單位共用 `Formulas.softenLuckDamage` 的幸運傷害遞減曲線。

## 1.0.8

- 普攻預設 SP 消耗由 2 降為 1；技能可宣告 `dealsBasicAttackDamage`，讓轉派的普攻也照常扣體力。

## 1.0.6

- 喘息恢復量由 maxSp 的 15% 提高到 40%。
- 新增 `AFTER_SKILL_CAST`：技能結束後通知存活的對手。

## 1.0.5

- 新增 `AFTER_ATTACK_DEALT`：攻擊方每次完整攻擊、對每個目標執行一次。

## 1.0.3

- 新增不能行動的單位（`actionDisabled`）、鎖定能力值（`lockedStats`），以及整次攻擊結束後的受擊鉤子 `AFTER_ATTACK_RECEIVED`。見 [docs/INANIMATE.md](docs/INANIMATE.md)。

## 1.0.2

- 新增技能施放率 `skillCastRate`（預設 35%）、無視防禦與敵方光環。見 [docs/SKILL_MODIFIERS.md](docs/SKILL_MODIFIERS.md)。

## 1.0.1 以前

- 回合制戰鬥引擎本體：`Entity`、`Skill`、`Buff`、`BattleEngine`、`Formulas`；重名編號、召喚、SP／HP 恢復、反擊與幸運事件。
