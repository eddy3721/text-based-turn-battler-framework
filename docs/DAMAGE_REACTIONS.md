# 受傷後被動與部位破壞

## 受傷後事件

防守方可宣告 `trigger: 'AFTER_DAMAGE_RECEIVED'`，每次實際損失 HP 後執行一次。
適用普通攻擊、技能、逐擊反擊、DOT、幸運事件及直接呼叫 takeDamage。
落空、全擋、零傷害、治療、已死亡實體再受傷均不觸發。

```js
const bombDamage = () => ({
  trigger: 'AFTER_DAMAGE_RECEIVED',
  enabled: (self, hit) => self.isAlive && self.charging && hit.source !== 'SELF_BLAST',
  action: (self, hit, logger, engine) => {
    self.chargeDamage = (self.chargeDamage || 0) + hit.actualDamage;
    if (self.chargeDamage >= self.stats.maxHp * 0.06) self.bombPrimed = true;
  }
});
```

累計的重置時機、門檻、來源排除與達標反應由遊戲被動負責，框架不限制為炸彈。
可使用 enabled 選擇只計攻擊、排除持續傷害或只計特定技能。
每場建立自己的實體與被動，勿在共用技能單例保存傷害累計。

### hit 欄位

| 欄位 | 意義 |
| --- | --- |
| `damage` | 原有語義：防禦／減傷後的傷害數字，可能大於剩餘 HP |
| `actualDamage` | 這一擊實際損失的 HP，上限為受擊前剩餘 HP；例如剩 5 HP 被打 100，值為 5 |
| `lethal` | 這次扣血是否使目標死亡 |
| `source` | 普通 DAMAGE 行動預設 ATTACK，直接傷害預設 DIRECT；DOT 與幸運事件為 DOT／LUCK_EVENT，可自訂來源字串 |
| `caster`, `target`, `skill`, `action` | 攻守者與技能；DOT、直接或環境傷害可能沒有 caster／skill／action |
| `isCounter`, `isNormalAttack`, `hitIndex`, `hits` | 攻擊的來源及段數，非技能傷害可能省略 |
| `buffId` | DOT 的來源 Buff ID |
| `partId`, `partName` | 這一擊命中的部位；不分部位的傷害省略 |
| `partDamage` | 本擊實際消耗的部位耐久，不能超過該部位剩餘耐久 |
| `partDurability`, `partMaxDurability` | 本擊扣除後的耐久快照及上限 |
| `brokePart` | 是否為該部位第一次破壞 |

`BEFORE_DAMAGE` 可先讀 partId 以實作部位防護，仍以修改 hit.damage 調整傷害。
actualDamage 與部位結算數值是結果；後置被動應讀取它們，不應修改以重新結算。
新後置事件也會通知致死一擊，觀察者可累計最後的實際扣血；反應技能應使用 `self.isAlive` 保護。
既有 HP_BELOW 與 AFTER_DAMAGE_DEALT 的存活條件不變。

## 隨機部位

Entity 新增可選 `parts`，各部位共享實體 HP，各自有一次性的破壞耐久。

```js
const monster = new Entity({
  id: 'wyvern', name: '測試飛龍', team: 'B',
  stats: { hp: 1000, maxHp: 1000, atk: 80, def: 30, sp: 100, spd: 30 },
  parts: [
    { id: 'head', name: '頭部', maxDurability: 200 },
    { id: 'tail', name: '尾巴', maxDurability: 150 },
    { id: 'legs', name: '雙腿', maxDurability: 250 }
  ],
  passives: [{
    trigger: 'ON_PART_BREAK',
    enabled: (self, hit) => self.isAlive && hit.partId === 'legs',
    action: (self, hit, logger) => {
      self.addBuff({ id: 'toppled', name: '倒地', type: 'STUN', duration: 2 });
      logger.addLog({ type: 'BOSS_DIALOGUE', message: '飛龍失去平衡，倒在地上！' });
    }
  }]
});
```

- id 必須唯一且非空，name 可省略並使用 id，maxDurability 為正安全整數。
- 框架複製資料並建立 `durability`、`broken`，不修改傳入的設定，也不跨場共用。
- 每次命中的攻擊等機率抽一個部位，多段逐擊抽選，全體攻擊每個目標各自抽選。
- 無部位設定時不增加任何部位亂數抽選，保留原本戰鬥隨機序列。
- 已破壞部位仍可命中、扣 HP，部位耐久維持 0，不重複觸發破壞。
- DOT、環境及自傷不分配部位；反擊視為一般攻擊，會命中部位。
- 不提供玩家指定部位、斬擊斷尾條件、獨立部位抗性或耐久回復；這些可在後續 Boss 設計時擴充。

### 部位傷害倍率

```js
new Skill({ id: 'breaker', actions: [
  { type: 'DAMAGE', power: 1, partDamageMultiplier: 2 }
] });
```

部位傷害 = min(剩餘部位耐久, floor(actualDamage × partDamageMultiplier))。
倍率預設 1，必須為有限非負數，0 表示不削減部位耐久；不改變 HP 傷害。
後置破壞反應可修改技能組、能力或 Buff，後續攻擊會讀到新狀態。

## 結算順序與日誌

1. 選部位 → BEFORE_DAMAGE → 扣 HP／部位耐久。
2. 原攻擊寫入 DAMAGE／BLOCK 紀錄。
3. 首次破壞時寫 PART_BREAK → ON_PART_BREAK。
4. AFTER_DAMAGE_RECEIVED → 原有死亡／HP_BELOW → 攻擊方 AFTER_DAMAGE_DEALT → 勝負檢查。

被動反應若結束戰鬥，後續反應與動作停止。finishDamage 對同一結果物件只結算一次，避免重複累計或重入。
直接呼叫 takeDamage 預設立即結算；需要先寫日誌時傳 `deferReactions: true`，再呼叫 finishDamage。
預設命中文字會帶部位名稱；自訂 message/text 可讀取 partId、partName、partDamage。
DAMAGE／BLOCK 保留部位欄位；反擊摘要以 `partHits` 保存逐擊部位結果。
PART_BREAK 日誌包含 targetId、partId、partName；反擊整理不會移除破壞紀錄。
反擊流程會移除 SKILL_TEXT，後置被動若要保留提示請使用 BOSS_DIALOGUE 或自訂事件類型。
