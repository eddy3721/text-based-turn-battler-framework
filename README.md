# 文字對戰遊戲戰鬥模組 (Text-Based Turn-Battler Framework)

這是一個基於純 JavaScript (Framework-Agnostic) 開發的回合制戰鬥核心引擎。專為類似「我的桐人」這類型的文字掛機或對戰遊戲所設計。本系統採用**一次性結算**與**資料驅動 (Data-Driven)** 的架構，讓您可以輕鬆地套用到 React、Vue、Node.js 甚至任何前端專案中。

---

## 系統架構總覽

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
目前的系統有保留了 `ON_HP_CHANGE` 事件，用來做 Boss 的階段轉換。
您可以繼續擴充更多事件，例如：
- `ON_TURN_START` (回合開始時觸發回血被動)
- `ON_DEATH` (死後觸發自爆，對全體造成傷害)
只要在 `BattleEngine.js` 或是 `Entity.js` 中對應的時機呼叫 `checkPassives` 即可。

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
