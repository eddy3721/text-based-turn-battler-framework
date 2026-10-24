# 可選理智系統

理智是單場戰鬥的獨立狀態，不取代 HP、SP 或疲勞。省略 `Entity.sanity`
或傳入 `false` 就不啟用；同場可混合有理智與無理智單位。未啟用時不新增
理智日誌、數值效果或隨機抽選。召喚物由工廠自行設定，不繼承召喚者理智。

執行 `npm run demo:sanity` 可查看預設玩法、自訂刻度及純機制範例。

## 啟用與操作

```js
const { Entity, Skill, BattleEngine, createSanityRules } = require('text-based-turn-battler-framework');

const hero = new Entity({
  id: 'hero', name: '旅人', team: 'A',
  stats: { hp: 100, maxHp: 100, sp: 20, atk: 10, spd: 10 },
  sanity: {} // min: -50, max: 50, neutral: 0, initial: 0
});

hero.changeSanity(-15, logger, { engine, source: 'FEAR' });
// 回傳實際變動量 -15，hero.sanity.value 為 -15，state 為 SHAKEN。

const pressure = new Skill({ id: 'pressure', name: '精神衝擊', actions: [
  { type: 'CHANGE_SANITY', amount: -20, targetType: 'ENEMY_ALL',
    text: { action: '低語迴盪，', sanity: ctx => `${ctx.target.name} 的理智變為 ${ctx.after}。` } }
] });
```

`min < neutral < max`，所有數字與刻度寬度都必須有限；`initial` 必須在範圍內，
省略時使用 `neutral`。例如 `sanity: { min: 0, max: 100, neutral: 50 }`。
狀態在 `entity.sanity`，不在 `stats.sp`；未啟用時 `entity.sanity === null`。
請透過 `changeSanity` 更新數值，不直接寫入狀態欄位。

`changeSanity(delta, logger?, context?)` 接受有限正負數，夾限後回傳實際差值。
無理智或死亡單位回傳 0；沒有實際變化就沒有日誌或事件。`context` 可提供
`engine`、`caster`、`skill`、`source`、`message(event)`。戰鬥中的被動應傳入 engine，
以取得正確回合與反應上下文；未傳入時使用單位最近一次參與的全局回合，戰前為 0。

`CHANGE_SANITY.amount` 為必填有限數字。動作支援既有 `targetType`、`inheritTarget`、
`spCost`、`requiresDamage` 與敵我反轉規則；不自行擲命中，也不因上一段落空自動取消。
若只想在命中造成傷害後改變理智，可用 `AFTER_DAMAGE_DEALT` 或
`AFTER_DAMAGE_RECEIVED` 被動呼叫 `changeSanity`。`requiresDamage` 則沿用既有
「本次技能已對該目標造成傷害」的條件，不等於每一擊命中事件。

文案預設拼接 `text.action + text.sanity`；片段可用字串或函式，`action.message(ctx)`
可整句覆寫。context 包含原有 `caster/target/targets/skill`，以及
`before/after/value/previousState/state/source`；`value` 是實際有正負號的變動量。

## 預設規則與全局回合

| 項目 | 預設行為 |
| --- | --- |
| 技能施放率 | 中立為 0 修正，向兩端線性到 −0.10／＋0.10；兩側分別按各自範圍換算 |
| 與疲勞／光環組合 | STAT Buff → 加上疲勞與理智的百分點修正 → 夾限 [0,1] → 敵方光環倍率 |
| 回穩 | 每個全局回合結束往中立移動刻度寬度的 5%，預設 5 點，不越過中立 |
| 狀態 | `SHAKEN` 動搖、`NEUTRAL` 平穩、`INSPIRED` 振奮；下限觸發 `PANIC` |
| 自動戰況效果 | 普通傷害、擊殺、隊友死亡不自動改變理智 |

只影響一般技能抽選，不影響強制開場技能或其他能力值。狀態本身不再額外乘傷害。

第 N 回合崩潰會立即禁止尚未執行的行動，持續至第 N＋1 回合結束。
開戰初始值就在下限，視為第 0 回合觸發，封鎖第一回合；第 N 回合加入的召喚物
若初始就在下限，封鎖至 N＋1 回合結束。速度與行動槽數量不會縮短期間。

期間 `entity.isPanicked()` 為 true、`canAct()` 為 false。正常行動、反擊、主動幸運事件、
`CAST_SKILL`／`engine.castSkill` 與直接 `Skill.execute` 都不能施放；`ignoreSp` 不豁免。
多段攻擊在下一擊、下一個目標或下一段動作前停止；已結算的傷害、死亡、受擊與
整次攻擊反應仍完成。被動本身仍會執行，因此護盾、防護、DOT、HOT 等仍有效，
但被動嘗試讓崩潰者施放技能時會被阻擋。

普通 Buff 照常在每個行動槽結束扣時間。`ROUND_START` 定時 Buff 照常消耗觸發次數，
崩潰者的該次施法被略過；`BEFORE_ACTION` 蓄力等待下一次可行動時才消耗，與暈眩一致。
崩潰不會消耗尚未使用的開場技能機會。

崩潰中暫停自然回穩；外部仍可增減數值，但不提前解除，也不刷新崩潰期限。
期滿回復至中立值，若已更高則保留；解除當次不再自然回穩。
沒有額外免疫期。死亡單位不恢復，戰鬥結束後不再做回合末回穩。

自訂技能覆寫 `execute` 時，必須在入口與每個後續執行邊界檢查
`if (!caster.isAlive || caster.isPanicked() || engine?.result) return;`。
直接自行扣 HP 的任意 JavaScript 回呼不可能由框架攔截；主動反應應走技能介面。

## 替換預設規則

```js
const rules = createSanityRules({
  castRateModifier: (sanity, entity) => sanity.value < sanity.neutral ? 0.05 : 0,
  recoveryAmount: (sanity, entity) => 2,
  getState: sanity => sanity.value < -20 ? 'FEAR' : 'CALM',
  panicEnabled: false
});
// new Entity({ ...角色設定, sanity: { rules } });

// 純數值／事件，不自動回穩、不修正施放率、不崩潰：
// new Entity({ ...角色設定, sanity: { rules: false } });
```

`createSanityRules(overrides?)` 回傳凍結的規則物件；也可直接提供部分規則物件，
未指定的項目沿用預設。單位各自持有可變理智狀態，共用規則不共用數值。
規則函式應為純函式：`castRateModifier` 回傳有限數字，`recoveryAmount` 回傳有限
非負數，`getState` 回傳非空字串且不能使用保留的 `PANIC`。
`rules: false` 仍提供預設的動搖／平穩／振奮分類及事件。

## 事件與日誌

被動簽章與受傷反應一致：`enabled(self, event)`、`action(self, event, logger, engine)`。
支援 `ON_SANITY_CHANGE`（實際數值改變）及 `ON_SANITY_STATE_CHANGE`（實際狀態轉換）。
`event` 包含前後值、實際差值、前後狀態、`source`、實體 ID、技能 ID，
以及 `target/caster/skill` 參照。初始崩潰只發送狀態事件，`previousState` 為 null。

日誌類型為 `SANITY_CHANGE`、`SANITY_STATE_CHANGE`、`SANITY_PANIC`、`SANITY_RECOVER`。
狀態進入崩潰或解除時，以專用類型取代一般狀態日誌，避免重複敘述。
共同欄位包含 `actorId/targetId`、`before/after/value`、`previousState/state`、
`source`、`panicUntil` 及來源技能 metadata（若有）。`panicUntil` 是解除所在回合，
未崩潰為 null；不會為每個被跳過的行動槽再播一行崩潰日誌。

框架來源為 `INITIAL`、`SKILL`、`ROUND_RECOVERY`、`PANIC_RECOVERY`，直接呼叫未指定
來源時為 `DIRECT`；應用端可使用自己的來源字串。
同一次改變先記數值與狀態日誌，再通知數值事件、狀態事件。被動造成的巢狀變動
立即更新數值，通知依序排隊；event 是該次變動的快照，不應以當前值取代。
單一反應鏈超過 100 次變動會拋出錯誤，避免互相恢復／扣除的被動形成無窮迴圈。

理智不會自動存入角色養成資料；每場建立新的 Entity 即得到全新狀態。
