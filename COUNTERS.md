# 反擊

`Entity` 接受可選的 `counterSkill: Skill`；`stats.counter` 為 0–1 機率，省略為零。
遊戲層負責從技巧換算，框架只讀 `getEffectiveStats().counter`。

透過 `BattleEngine` 執行技能時，每次出招對每位目標，在第一個命中的 DAMAGE 段
判定一次反擊；未命中不消耗判定機會，失敗後本招不重試。巢狀 CAST_SKILL 共用
這次出招的判定集合。DOT、直接 takeDamage 不進入反擊判定。

反擊者必須存活且未暈眩。成功時跳過原本該擊的傷害與受傷前被動，立即還擊原攻擊者；
攻擊者存活就繼續剩餘攻擊。一般還擊是獨立的 `basic_counter` 單擊、倍率 1，
無 SP 費用、不吃速度連擊，但視為普攻。反擊必定命中，仍可爆擊、被格擋並觸發普攻追加效果。
反擊不使用行動槽、不消耗 openingSkill，也不呼叫 tickBuffs。

若 counterSkill 可施放，直接使用它並支付其 SP，不另做技能抽選；不可施放時退回
一般還擊。指定技能的第一個 DAMAGE 目標強制為原攻擊者，之後遵守原有技能目標規則。
不要將需要隨機子技能選人的 CAST_SKILL 包裝當作指定目標反擊技能。

反擊及同步衍生技能共用 `counterSource`；反擊附加的 Buff 也記錄來源，定時觸發時
恢復來源，禁止衍生效果再次引發反擊。錯誤退出時還原來源與呼叫堆疊。

招架與反擊傷害濃縮成單一 `COUNTER` 紀錄，例如「艾莉絲使出了 光之太刀，
但是遭亞絲娜反擊，受到 100 點傷害！」；技能名不加引號。狀態、死亡與台詞仍在其後
各自輸出。COUNTER 的 actorId 是反擊者、targetId 是原攻擊者、value 是反擊總傷害，
incomingSkillId 記錄被反制招式，skillId／skillTier 記錄實際反擊招式。

Action 可設定 `requiresDamage: true`：只對本次技能執行先前造成過正傷害的目標生效。
例如 DAMAGE 後接此條件的 BUFF，便能讓繳械在落空、完全格擋、完全招架時不生效。
省略此設定的既有 BUFF 仍獨立施加。

驗證：`node --test tests/counter.test.js`。
