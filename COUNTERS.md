# 反擊

`Entity` 接受可選的 `counterSkill: Skill`；`stats.counter` 是**反擊點數**（不是機率），
省略為零。遊戲層負責從自己的能力值換算成點數，框架只讀 `getEffectiveStats().counter`。

機率由攻守雙方的點數差決定，跟幸運事件看 luk 差、連擊看 spd 差同型：

    gap    = max(0, 守方counter − 攻方counter)
    chance = COUNTER_CEILING × gap / (gap + COUNTER_GAP_SATURATION)

所以點數相同或被對方壓過就完全不會反擊，壓制對方才有機會，且只有機率飽和、
差值不飽和。上限存在是因為反擊必定命中又會跳過原本那一擊的傷害，逼近 100%
等於高點數單位對低點數單位完全免疫。`Formulas.counterChance(attacker, defender)`
可單獨取用這條曲線。

透過 `BattleEngine` 執行技能時，**每一個命中的 DAMAGE 擊各自判定一次反擊**：
多段技能有幾擊就有幾次機會，速度連擊亦同。未命中不判定，失敗的擊不影響後續擊。
DOT、直接 takeDamage 不進入反擊判定。

判定次數與 `stats.counter` 是綁在一起的：這裡從「每次出招一次」改成「每擊一次」時，
遊戲層的機率上限必須跟著調低，否則多段技能會被反擊淹沒——使用多段技能較多的
那一方吃虧最重。改動任一邊都要重跑遊戲層的平衡模擬。

反擊者必須存活且未暈眩。成功時跳過原本該擊的傷害與受傷前被動，立即還擊原攻擊者；
攻擊者存活就繼續剩餘攻擊。一般還擊是獨立的 `basic_counter` 單擊、倍率 1，
無 SP 費用、不吃速度連擊，但視為普攻。反擊必定命中，仍可爆擊、被格擋並觸發普攻追加效果。
反擊不使用行動槽、不消耗 openingSkill，也不呼叫 tickBuffs。

若 counterSkill 可施放，直接使用它並支付其 SP，不另做技能抽選；不可施放時退回
一般還擊。指定技能的第一個 DAMAGE 目標強制為原攻擊者，之後遵守原有技能目標規則。
不要將需要隨機子技能選人的 CAST_SKILL 包裝當作指定目標反擊技能。

反擊及同步衍生技能共用 `counterSource`；反擊附加的 Buff 也記錄來源，定時觸發時
恢復來源，禁止衍生效果再次引發反擊。錯誤退出時還原來源與呼叫堆疊。

招架與反擊傷害濃縮成單一 `COUNTER` 紀錄。開頭沿用「被反制的那一擊原本會印出的
開頭」——也就是該 action 的 `text.action`／`text.combo`，反擊只是把後半段的結果
換掉。單段技能因此濃縮成一行「艾莉絲 使出了 光之太刀，但是遭亞絲娜反擊，受到
100 點傷害！」；多段技能的技能名早就由前面的宣告行講過，開頭是「第 2 擊，」。
引擎不自己造「X 使出了 Y」，否則多段技能會宣告一次、反擊再複述一次。
技能名不加引號。狀態、死亡與台詞仍在其後各自輸出。COUNTER 的 actorId 是反擊者、targetId 是原攻擊者、value 是反擊總傷害，
incomingSkillId 記錄被反制招式，skillId／skillTier 記錄實際反擊招式。

## 讓反擊技能自己演出

上面那套濃縮是**預設**（`counterStyle: 'summary'`）。它的前提是「還擊沒有值得單獨佔一行
的文案」——一般還擊放行只會得到「X 攻擊，對 Y 造成了 N 點傷害！」，跟上一行重複。

有自己演出的反擊技能可以宣告 `counterStyle: 'detailed'`：

```js
new Skill({ id: 'shield_parry', name: '盾反', counterStyle: 'detailed', actions: [...] });
```

    敵人 使出了 薪王四連，第 2 擊，但是遭灰燼以盾反反擊！
    灰燼 反手將劍尖送進 敵人 的胸膛，造成了 284 點傷害！

COUNTER 那一句只宣告「被反擊了」，不再接結果；還擊自己的 DAMAGE／BLOCK／MISS 與
SKILL_TEXT 全部原樣放行，順序不變。落空與被擋也不必特別處理——還擊自己的那一行
本來就會說明結果。

COUNTER 紀錄的 `value`、`isCrit`、`partHits` 在兩種模式下都照舊寫入：換掉的只有句子，
統計與 UI 讀的是欄位，不該因為改了呈現方式就少一筆數字。注意詳細版的傷害會同時
出現在 COUNTER 的 `value` 與還擊自己的 DAMAGE 紀錄裡，**累加傷害時只能取其一**。

`counterStyle` 只在這招被當成 `counterSkill` 時有意義；主動施放時兩種模式毫無差別。
值打錯會在建構時直接拋錯，不會安靜地退回濃縮版。

## 不可反擊的招式

有些傷害在敘事上不是「出手」，被打的人沒有對象可以還擊——例如先前安裝、之後才被
隊友的攻擊引爆的炸彈。這類招式可以宣告 `uncounterable: true`：

```js
new Skill({ id: 'bomb', name: '爆炸', uncounterable: true, actions: [...] });
// 或只讓其中一擊免疫
{ type: 'DAMAGE', uncounterable: true, ... }
```

技能層級涵蓋整招每一擊；寫在 DAMAGE action 上則只涵蓋該 action 的擊，其他擊照常判定。
排除發生在擲骰之前，不消耗判定次數。與 counterSource 不同，它**不**改變命中判定、
不把戰報標成反擊，也不影響這招的傷害觸發被動——只拿掉「對手能不能反擊」這一項。
值必須是布林，寫在非 DAMAGE action 上會在建構時拋錯。

Action 可設定 `requiresDamage: true`：只對本次技能執行先前造成過正傷害的目標生效。
例如 DAMAGE 後接此條件的 BUFF，便能讓繳械在落空、完全格擋、完全招架時不生效。
省略此設定的既有 BUFF 仍獨立施加。

驗證：`node --test tests/counter.test.js`。
