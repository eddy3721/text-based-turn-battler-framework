# 文字對戰遊戲戰鬥模組 (Text-Based Turn-Battler Framework)

一般反擊、技能反擊與傷害條件效果請見 [COUNTERS.md](COUNTERS.md)。

這是一個基於純 JavaScript (Framework-Agnostic) 開發的回合制戰鬥核心引擎。專為類似「我的桐人」這類型的文字掛機或對戰遊戲所設計。本系統採用**一次性結算**與**資料驅動 (Data-Driven)** 的架構，讓您可以輕鬆地套用到 React、Vue、Node.js 甚至任何前端專案中。

---

## 系統架構總覽

### 召喚與資源恢復

- `Entity.stats.maxSp` 可明確設定；省略時採初始 `sp`（兩者皆省略為 0）。`heal(amount, logger)` 與 `restoreSp(amount)` 回傳實際恢復量，不超過上限、不復活死亡單位。
- 技能可加入 `{ type: 'RESTORE_SP', amount: 8, targetType: 'ALLY_ALL' }`，輸出 `SP_RECOVER`，包含 `actorId`、`targetId`、`value` 與技能 metadata。`HEAL` 日誌同樣使用實際恢復量。
- `{ type: 'SUMMON', monsterId: 'goblin', maxAlive: 2, maxTotal: 4, spCost: 20 }` 由 `new BattleEngine(teamA, teamB, { summonFactory })` 處理。工廠簽章為 `(monsterId, { entityId }) => Entity`；引擎登錄陣營與 `summonerId`，每位召喚者分別計數，增援下一回合才進入行動順序。
- `RESTORE_SP` 與 `SUMMON` 的日誌文字跟其他 action 一樣走片段拼裝：`RESTORE_SP` 是 `action + recover`，`SUMMON` 是 `action + summon`（`ctx.target` 為剛登場的增援，日誌由引擎寫出但文案仍由技能決定），`action.message` 一樣可整句覆寫。
- 召喚可用非空 `monsterIds` 陣列取代單一 `monsterId`，每次等機率抽一個 ID。引擎保留工廠提供的原始名稱，不附加增援文字；同名單位以唯一實體 ID 區分。
- `Skill.canCast(entity, context?)` 及 `execute(caster, allies, enemies, logger, context?)` 的可選 context 為 BattleEngine；未注入工廠或已達召喚上限時，召喚技能不可選且不消耗 SP。既有無召喚技能可照舊呼叫。
- `Entity` 可設定 `openingSkill`。首次可行動時若可施放則使用一次，否則走一般技能抽選；暈眩不消耗首次行動機會。
- Buff 設定 `stackPolicy: 'refresh'` 時替換同 ID 效果並重設時間；省略則維持原本可堆疊行為。時間仍以目標自己的行動槽結束時計算。
- 引擎選項 `openingLogs` 可傳入遊戲層的開場敘事紀錄。工廠、故事、怪物資料仍由遊戲負責。

整個引擎分為五個核心模組：

1. **`Entity` (戰鬥實體)**
   - 敵我雙方皆使用相同的 `Entity` 類別，統一了狀態 (HP, SP, 能力值) 以及增益狀態 (Buffs) 的管理。
   - 內建 `passives` (被動技能/事件觸發) 陣列，方便實作「半血狂暴」、「死後復活」等多階段變身效果。

2. **`Skill` (技能系統)**
   - 採用**動作分段 (Actions)** 結構設計。一個技能不再只是單純的數字，而是由多個 `action` 組成的陣列。
   - 支援：多段連擊演出、多行文字戰報、中途扣除 SP、依序賦予 Buff 或補血。
   - 每個動作可決定是否延續上一個動作的目標 (`inheritTarget`)。

3. **`BattleEngine` (戰鬥引擎)**
   - 控制整場戰鬥的迴圈。呼叫 `start()` 後會在瞬間計算完所有的回合。
   - 負責判定技能施放率（預設 40% 機率施放主動技能，否則退回普通攻擊）。
   - 負責管理勝負條件並輸出結構化的 `logs`（戰鬥日誌）。

4. **`Buff` (狀態效果)**
   - 處理持續性效果，如 `HOT` (持續恢復)、`DOT` (持續傷害)、`STAT` (能力值加成)。

5. **`Formulas` (公式庫)**
   - 將所有數值計算獨立抽離的工具類別，包含傷害計算、爆擊判定、命中判定、回合行動順序等。

---

## 其他專案該怎麼套用？

由於本框架無依賴任何前端 UI 函式庫，您可以直接將 `src` 資料夾複製到您的專案中。

### 1. 匯入模組
在您的遊戲邏輯組件中（例如 React 的某個 Page 或 Hook）匯入：
```javascript
import { Entity, Skill, BattleEngine } from './src/index';
```

### 2. 定義技能與實體
根據您的企劃文件建立技能庫與角色資料。這通常會從您的伺服器 API 或是 JSON 設定檔讀取：
```javascript
const normalAttack = new Skill({ ... });
const fireball = new Skill({ ... });

const player = new Entity({
  id: 'p1',
  name: '勇者',
  team: 'A', // 透過 Team 字串來區分敵我
  stats: { hp: 1000, maxHp: 1000, sp: 100, atk: 150, def: 50, spd: 120, cri: 0.2 },
  normalAttack: normalAttack,
  skills: [fireball],
  passives: []
});
```

### 3. 執行戰鬥並取得結果
這部分通常發生在玩家點擊「挑戰 Boss」或是背景掛機結算時：
```javascript
const engine = new BattleEngine([player], [boss]);
const result = engine.start(); 

// result.winner 會回傳獲勝隊伍 ('TEAM_A', 'TEAM_B', 或 'DRAW')
// result.logs 包含了整場戰鬥的所有細節
```

建立 `BattleEngine` 時會依 `teamA`、`teamB` 的陣列順序，統一處理同場
角色與怪物的同名問題：第一位保留原名，後續為 `桐人2`、`桐人3`，不加空格。
敵我同名也共用編號；若 `桐人2` 本來就是其他單位的原名，會跳過該號碼以免撞名。
框架直接更新戰鬥實體的 `name`，技能、被動與回傳的 `finalTeamA`／`finalTeamB`
都會使用相同名稱，`id` 不變。結算文字請依 `id` 取回實體的戰鬥名稱。
重用同一實體建立新戰鬥時，框架會從原名重新編號。呼叫端只需提供角色或怪物
本名，不需附加玩家名稱或預先加上 A／B 後綴。

### 4. 處理戰鬥日誌 (UI 渲染)
前端專案**最重要**的工作就是把 `result.logs` 漂漂亮亮地渲染出來。
您可以寫一個計時器 (例如 `setTimeout`)，每隔 0.5 秒從 logs 陣列拿出一筆資料顯示在畫面上，營造出戰鬥的動態感：
```javascript
// React 範例概念
result.logs.forEach((log, index) => {
  setTimeout(() => {
    // 根據 log.type 來決定顯示方式，例如：
    // 若 type 是 'DAMAGE' 且 isCrit 為 true，文字顯示為紅色放大震動
    appendLogToScreen(log.message); 
  }, index * 500); 
});
```

---

## 開發者需要「自定義」什麼東西？

這套框架提供了骨幹，但具體的遊戲體驗需要您自行定義以下內容：

### 1. 修改數值公式 (`src/utils/Formulas.js`)
目前的傷害公式僅僅是簡單的 `(攻擊力 * 技能倍率) - 防禦力`。
您需要依照您的遊戲平衡來修改：
- 傷害公式 (可能要加入亂數浮動值、屬性相剋倍率)。
- 行動順序演算法 (目前是單純比 SPD，您可以改為跑條/Action Gauge 系統)。
- 閃避與命中的期望值計算。

### 2. 擴充更多類型的 Action (在 `Skill.js`)
目前 `Skill.js` 的 `actions` 支援 `TEXT`, `DAMAGE`, `HEAL`, `BUFF`。
如果您的企劃有更複雜的機制（例如：「偷竊」、「吸血」、「復活」或「驅散敵方 Buff」），您需要在 `Skill.js` 的 `execute` 迴圈中增加對應的 `action.type` 處理邏輯。

### 3. 技能與裝備的 JSON 化
因為目前技能的 `message` 參數使用了 Arrow Function 來做到字串格式化，如果您希望技能設定可以完全放在資料庫 (Database) 中當作純 JSON 傳輸，您會需要寫一個 Parsing 層，將 `{caster} 攻擊了 {target}` 這種字串解析成實際的文字，藉此拔除程式碼中的 Function。

### 4. 觸發器與被動系統 (`Entity.js` 的 `passives`)
`ON_HP_CHANGE` / `condition: 'HP_BELOW'` 用於一次性階段轉換，僅存活單位會觸發。
技能傷害先寫入戰報，再執行 `action(self, logger, engine)`，可透過 engine 立即施放反擊。
`trigger: 'AFTER_DAMAGE_DEALT'` 用於逐擊追加效果，詳見下方。

---

## 專案整合與套用最佳實務

如果您擔心未來戰鬥框架更新時，每次都要「手動複製資料夾」會很麻煩，這裡有幾種業界常見的整合方式：

### 1. (推薦) 封裝成本地 NPM 套件 (NPM Package)
這是最乾淨的做法！您可以為這個框架加入一個 `package.json`，然後在您的 React 專案中直接用 NPM 安裝它。
- 在本框架目錄執行 `npm init -y`。
- 在您的 React 專案中執行：`npm install 絕對路徑/text-based-turn-battler-framework`
- 未來如果戰鬥框架有修改程式碼，只要在 React 專案執行 `npm update` 即可！
- 在 React 中引用的方式會變成：`import { BattleEngine } from 'text-based-turn-battler-framework';`

### 2. 使用 Git 子模組 (Git Submodule)
如果兩個專案都在 Git 上，您可以將戰鬥框架作為子模組引入 React 專案中。當戰鬥框架有更新並 push 到 Github 時，React 專案只需要下 `git submodule update --remote` 就能同步最新程式碼。

### 3. Monorepo 架構 (如 Turborepo 或 NPM Workspaces)
把「戰鬥引擎」跟「React 前端」放在同一個大型 Repo 底下，分成 `packages/engine` 和 `apps/web`，兩邊可以連動開發，修改引擎會即時反映在前端。

### 💡 如果我還是想直接複製，應該放在 React 的哪裡？需要改名嗎？
如果您選擇直接複製 `src` 資料夾：
- **放置位置**：通常會放在 React 專案的 `src/lib/battler-engine/` 或是 `src/features/combat/` 底下。
- **需要改名嗎？**：強烈建議**將框架原本的 `src` 資料夾改名**為 `battler-engine` 或是 `core`，以免跟 React 專案本身的 `src` 搞混。
- 這樣引入時就會長得像：`import { BattleEngine } from '../lib/battler-engine/index';`
# 受傷前被動

Entity 支援可重複執行的 `trigger: 'BEFORE_DAMAGE'` 被動。可選的
`enabled(self, hit)` 回傳是否啟用，`action(self, hit, logger)` 修改本擊的
`hit.damage`。`hit` 包含 target，以及 Skill 傳入的 caster、skill、action、
hitIndex、hits（本次攻擊總段數）、isCrit。直接呼叫 takeDamage 時，攻擊來源欄位可能不存在。

格擋可設定 `hit.blocked = true` 與 `hit.blockMethod = '盾牌'`。takeDamage 回傳處理結果，
Skill 以最終 damage 產生 BLOCK 戰報（value 為減傷後傷害）。完全格擋不觸發
血量變動被動；後續 BUFF 動作仍獨立生效。既有 HP_BELOW 被動維持一次性觸發。

格擋文字使用技能的 `text.action` / `text.combo` 前綴，加上 `text.block`。
`block` 可為字串或 context 回呼，預設依最終傷害顯示完全格擋或部分減傷。
被動不組裝整句。多段技能的前綴由技能自行決定，並不強制使用「第 X 擊」。
`action.message` 仍優先於所有片段，需自行根據 `ctx.blocked`、`ctx.blockMethod`
與 `ctx.value`（減傷後傷害）處理格擋演出；未格擋時前兩者為 false / null。

## 呼叫已註冊技能與定時效果

遊戲端管理技能表，建立引擎時注入 `skillResolver: id => getSkill(id)`。框架不持有遊戲註冊表。

```js
new Skill({ id: 'random_move', actions: [
  { type: 'CAST_SKILL', skillIds: ['dagger', 'hammer', 'spear'], spCost: 12 }
] });
```

`CAST_SKILL` 等機率抽取一個可用技能；單一 ID 為指定施放。候選不必在施放者的 `skills` 中。
子技能自行選目標、使用自己的文案及日誌 skillId，免 SP 且不占行動槽。
召喚上限等非 SP 條件仍有效；無可用候選時不施放。未知 ID 或缺少解析器會報錯。
執行與可施放檢查均阻擋同一施放者呼叫鏈中的重複技能；另一名角色仍可使用同一技能反擊。
循環候選不會造成無窮遞迴。
遊戲端應在註冊表完成後驗證 CAST_SKILL 與 Buff 的所有 skillIds。

也可從被動呼叫 `engine.castSkill(caster, skillIds, options?)`。
`options.targets` 可指定被呼叫技能第一個 DAMAGE 動作的目標（例如命中後對同一人爆炸）；
後續動作沿用既有 inheritTarget 規則。一般隨機技能不要傳 targets，以使用技能原本的選人設定。
低階 `Skill.execute(..., engine, { ignoreSp: true })` 及 `canCast(entity, engine, { ignoreSp: true })`
使用每次執行設定，絕不改寫共用 Skill；一般呼叫不傳此設定。

自我蓄力可在 BUFF 動作中設定：

```js
{ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1,
  skillIds: ['dagger', 'hammer', 'spear'], stackPolicy: 'refresh' }
```

這類 Buff 在下一次可行動前先消耗，再呼叫技能，之後仍有正常行動；暈眩時延後。
`trigger: 'ROUND_START', remainingTriggers: 2` 則在後續兩個全局回合開始各觸發一次，
不受持有者行動次數影響。透過技能施加的 Buff 不會於施加當回合立即觸發 ROUND_START。
直接施加時用 `entity.addBuff(config, engine)` 記錄當前回合。
重複 refresh 會重新計算剩餘次數；死亡時清除定時效果。
這類 Buff 的壽命由 remainingTriggers 控制，不讀取 duration；舊 Buff 維持行動槽計時。
定時技能由 Buff 持有者施放，因此場地攻擊應將 Buff 附加在施放者自己身上。

## 傷害後反應與台詞

`AFTER_DAMAGE_DEALT` 的 `enabled(self, hit)` 與 `action(self, hit, logger, engine)`
可讀取 `hit.caster/target/skill/isNormalAttack/damage`。僅正傷害且雙方仍存活時觸發。
例如 enabled 檢查 isNormalAttack，再呼叫獨立爆炸技能，即可防止爆炸反覆觸發自己。
順序為本擊戰報 → 死亡或 HP_BELOW 反應 → 存活者追加效果 → 下一擊；
反擊殺死施放者或戰鬥結束時，剩餘動作停止。
直接 `takeDamage(amount, logger, { engine })` 可使用共用反應與死亡結算；
需自行先記錄傷害時，傳 `deferReactions: true`，寫完日誌再呼叫
`target.finishDamage(outcome, logger, engine)`。DOT 已使用此流程。
直接治療可傳 `entity.heal(amount, logger, { engine })`，讓血量被動取得引擎；
HEAL 技能與 HOT 也會在回復日誌之後傳入引擎、檢查血量被動。

Entity 可設定 `dialogues: { opening, death, victory }`（各為台詞本體字串）。
引擎補上戰鬥名稱及引號，產生 `BOSS_DIALOGUE`；各事件只播一次，平手不播勝利台詞。
前端自行決定這種日誌的顏色。死亡紀錄由引擎集中去重，涵蓋直接技能、DOT、派生與反擊。

```js
text: {
  action: '揮劍橫斬，',
  combo: '接著反手上挑，',
  block: ctx => `劍刃被 ${ctx.target.name} 的${ctx.blockMethod}擋住，造成 ${ctx.value} 點傷害！`
}
```
