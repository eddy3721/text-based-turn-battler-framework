# 文字對戰遊戲戰鬥模組 (Text-Based Turn-Battler Framework)

純 JavaScript 的回合制戰鬥引擎，給文字掛機、文字 RPG 這類「一鍵結算、看戰報」的遊戲用。

- **一次性結算**：`engine.start()` 同步跑完整場，回傳勝負與逐行戰報（每行都有結構化欄位和中文句子）。
- **資料驅動**：角色是 `Entity`，技能是一串 `actions`，被動是「觸發器 + 函式」，不用繼承任何類別。
- **鉤子很多**：開場、回合開始、出招前、受傷前後、保命、閃避、行動後……Boss 機制都寫在遊戲層，不用改框架。
- **可重現**：傳入種子亂數，同一個種子永遠跑出同一場戰鬥。
- **無 runtime 依賴**，Node 20 以上；也能直接打包進前端。

## 安裝

```bash
npm install github:eddy3721/text-based-turn-battler-framework#v1.0.46
```

```js
const { Entity, Skill, BattleEngine } = require('text-based-turn-battler-framework');
// ESM：import { Entity, Skill, BattleEngine } from 'text-based-turn-battler-framework';
```

## 快速開始

```js
const { Entity, Skill, BattleEngine } = require('text-based-turn-battler-framework');

// 技能是一串 actions，引擎依序執行。DAMAGE 預設打一個敵人，傷害 = atk × power（再扣防禦）。
const slash = new Skill({ id: 'slash', name: '斬擊', actions: [{ type: 'DAMAGE' }] });
const fireball = new Skill({ id: 'fireball', name: '火球術', actions: [
  { type: 'DAMAGE', power: 1.8, spCost: 10, text: { action: ctx => `${ctx.caster.name} 詠唱火球術，` } }
] });
const claw = new Skill({ id: 'claw', name: '利爪', actions: [{ type: 'DAMAGE' }] });

const hero = new Entity({
  id: 'hero', name: '勇者', team: 'A',
  stats: { hp: 2000, sp: 60, atk: 150, def: 50, spd: 120, cri: 0.2 },
  normalAttack: slash,
  skills: [fireball] // 每個行動槽預設 35% 機率從這裡抽一招（stats.skillCastRate）
});
const boss = new Entity({
  id: 'boss', name: '魔王', team: 'B',
  stats: { hp: 2100, sp: 60, atk: 130, def: 80, spd: 90, cri: 0.1 },
  normalAttack: claw,
  dialogues: { opening: '區區人類。', death: '不可能……' }
});

const result = new BattleEngine([hero], [boss]).start();
for (const log of result.logs) console.log(log.message);
console.log(result.winner); // 'TEAM_A' | 'TEAM_B' | 'DRAW'
```

```text
戰鬥開始！
魔王：「區區人類。」
--- 第 1 回合 ---
勇者 攻擊，會心一擊！對 魔王 造成了 169 點傷害！
勇者 詠唱火球術，對 魔王 造成了 194 點傷害！
魔王 攻擊，對 勇者 造成了 105 點傷害！
...
```

這段就是 [examples/quickstart.js](examples/quickstart.js)，clone 之後 `node examples/quickstart.js` 就能跑。

## 範例

每個範例都可以直接執行，開頭註解列出它示範的機制。範例都有固定種子，每次跑出的戰報一樣；
`tests/examples.test.js` 會檢查這些機制真的出現在戰報裡。

| 範例 | 示範 |
| --- | --- |
| [quickstart.js](examples/quickstart.js) | 最小的一場戰鬥：Entity、Skill、普攻與技能、台詞 |
| [boss-fight.js](examples/boss-fight.js) | Boss 階段：開場護盾（`BATTLE_START` + `shield`）、半血狂暴（`HP_BELOW`）、保命（`LAST_STAND`）、行動計數後插隊放大招（`AFTER_ACTION` + `insertAction`）、逐波全體攻擊（`hitOrder: 'wave'`）、群體治療 |
| [party-support.js](examples/party-support.js) | 團隊配合：嘲諷（`aggro`）、替隊友擋招（`BEFORE_SKILL_CAST`）、隊友出手後鼓舞（`AFTER_ACTION`）、閃避方式與閃避後反應（`ON_EVADE` / `AFTER_EVADE`）、減療（`healTaken`）、同名自動編號 |
| [control.js](examples/control.js) | 控制：沉默（`silence`）、機率麻痺（`STUN` + `chance`）、混亂敵我互換（`actionTargetResolver` + `swapSides`）、以 `int` 計算傷害 |
| [replay.js](examples/replay.js) | 可重現：`rng` + `createSeededRandom`、鉤子裡用 `random()`、`ROUND_START` 被動、用 `actionSlots` + `battleEnd` 做精彩重播 |
| [basic.js](examples/basic.js) | DOT／HOT、召喚（`SUMMON`）、呼叫已註冊技能（`CAST_SKILL`）、階段轉換 |
| [sanity.js](examples/sanity.js) | 可選的理智系統 |

## 文件

先看 **[docs/REFERENCE.md](docs/REFERENCE.md)**：所有建構參數、能力值、action 欄位、觸發器、引擎選項、日誌類型，以及常見的坑。

想知道某個機制的完整規則與設計理由，再看主題文件：

| 文件 | 內容 |
| --- | --- |
| [MECHANICS.md](docs/MECHANICS.md) | 架構總覽、召喚與資源、自定義公式、受傷前後的被動、已註冊技能與定時效果、逐波攻擊、可重現戰鬥 |
| [ACTIONS.md](docs/ACTIONS.md) | 戰鬥開場（`BATTLE_START`）、行動後（`AFTER_ACTION`）、回合開始（`ROUND_START`）、喘息之後（`AFTER_REST`）、出招之前（`BEFORE_SKILL_CAST`）、插隊（`insertAction`）、復活、各種 resolver |
| [PROTECTION.md](docs/PROTECTION.md) | 無敵、貫通、狀態解除、傷害縮放、保命（`LAST_STAND`）與護盾（`shield`） |
| [COUNTERS.md](docs/COUNTERS.md) | 一般反擊、技能反擊與傷害條件效果 |
| [EVASION.md](docs/EVASION.md) | 落空時由防守方描述自己怎麼躲（`ON_EVADE` / `AFTER_EVADE`） |
| [DAMAGE_REACTIONS.md](docs/DAMAGE_REACTIONS.md) | 受傷後被動、隨機部位與部位破壞 |
| [AGGRO.md](docs/AGGRO.md) | 仇恨值如何加權目標抽選，以及用 Buff 做嘲諷與隱蔽 |
| [SILENCE.md](docs/SILENCE.md) | 沉默：擋下指定招式，普攻被擋時改用替代攻擊 |
| [FATIGUE.md](docs/FATIGUE.md) | 疲勞、普攻逐擊耗體與喘息規則 |
| [SKILL_MODIFIERS.md](docs/SKILL_MODIFIERS.md) | 技能施放率 `skillCastRate`、無視防禦與敵方光環 |
| [TAGS.md](docs/TAGS.md) | 技能／傷害段／Buff 的自由標籤，傷害結算時合併成 `hit.tags` |
| [LUCK_EVENTS.md](docs/LUCK_EVENTS.md) | 幸運事件（紫／紅）與遞減曲線 |
| [INANIMATE.md](docs/INANIMATE.md) | 不能行動的目標（`actionDisabled`／`lockedStats`）與整次攻擊結束後的反應 |
| [SANITY.md](docs/SANITY.md) | 可選理智、自訂刻度與規則、全局回合崩潰及恢復 |

版本變動見 [CHANGELOG.md](CHANGELOG.md)。

### 給 AI 助手

[llms.txt](llms.txt) 是給 AI 讀的精簡入口：用法重點、檔案地圖和容易寫錯的地方。
請 AI 幫你寫技能或 Boss 之前，先讓它讀 `llms.txt` 與 `docs/REFERENCE.md`。

## 顯示戰報

`result.logs` 每筆都有 `type` 和 `message`。最簡單的做法是逐行印 `message`；
要做動畫或特效，就依 `type` 和欄位（`actorId`、`targetId`、`value`、`isCrit`……）自己排版：

```js
result.logs.forEach((log, index) => {
  setTimeout(() => {
    // 例如 DAMAGE 且 isCrit 時把文字放大變紅，BUFF_EFFECT 依 buffType 分顏色
    appendLogToScreen(log);
  }, index * 500);
});
```

所有日誌類型與欄位見 [REFERENCE.md 的日誌一節](docs/REFERENCE.md#日誌resultlogs)。

## 整合方式

- **GitHub tag（推薦）**：如上方安裝指令，固定一個版本 tag。
- **tarball**：在框架目錄 `npm pack`，把 `.tgz` 隨你的專案 commit，部署環境連不到 GitHub 時用。
- **發版前先試改動**：`npm install ../text-based-turn-battler-framework` 讓專案暫時指向本機原始碼；
  確定後在框架 commit、打 tag，再改回依賴那個 tag。
- **Monorepo**：放在 `packages/battle-engine`，用 npm workspaces 連結。

## 誰在用

- **我的同人（mydoujin）**：文字 RPG，本框架就是從這個遊戲的戰鬥系統抽出來的。
  文件裡許多「為什麼這樣設計」的段落，都來自它的實戰調整。
  謝謝打通第 74 層的玩家們，這個框架因為你們而開源。

## 開發

```bash
npm test          # 全部測試（含範例檢查）
npm run demo      # 跑 examples/basic.js
```

改框架的規則（亂數序列、版本號、文件）寫在 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE)
