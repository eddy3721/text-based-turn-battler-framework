# 幸運事件

預設啟用；可用 `new BattleEngine(teamA, teamB, { luckEvents: { enabled: false } })` 關閉。
Entity 的 `stats.luk` 預設為 0；比較時使用 STAT Buff 加成後的能力。

每個可行動的正常行動槽，在 DOT/HOT、暈眩檢查與 BEFORE_ACTION 效果之後、
選擇技能之前判定一次。多人戰鬥等機率選一位存活敵人作為比較對象。

令 D = max(0, 敵人幸運 − 行動者幸運)，R = D / (D + 100)。

| 種類 | 機率 | 減免前傷害 |
| --- | --- | --- |
| PURPLE | 30% × R | D × 1.2 × 浮動倍率 |
| RED | 10% × R | D × 2.4 × 浮動倍率 |

同一個亂數依紅、紫、正常區間判定，兩種事件互斥；D = 0 不抽事件。
確定事件種類後，傷害獨立抽取一次與一般傷害相同的 ±10% 浮動：`0.9 + Math.random() × 0.2`。
先浮動再向下取整，最低 1 點，之後套用受傷減免。未觸發事件不抽傷害浮動。
基礎係數集中於 Formulas.luckEventProfile；與一般傷害共用 Formulas.applyDamageVariance。
傷害與血量無關，不設上限；幸運差越大，傷害持續增加，可超過一般攻擊。
例如差 100 / 500 / 1000 點時，紫色基礎傷害為 120 / 600 / 1200，紅色為 240 / 1200 / 2400，再套用浮動。

事件取消該次正常行動、不扣 SP、不消耗開場技能機會；行動槽 Buff 時間照常扣除。
反擊、子技能與被動施法不額外判定。已發生的 BEFORE_ACTION 效果保留。
傷害不經攻防、命中、暴擊或反擊，仍經 BEFORE_DAMAGE 減免與低血量被動。
免傷後仍取消行動。來源 context.source 為 LUCK_EVENT，無 caster，故不觸發攻擊者追擊或吸血。
可以致死，先記錄事件，再結算死亡與勝負。

LuckEvents.js 收錄 7 條紫色、5 條紅色文案，同組等機率抽選。
戰報 type 為 LUCK_EVENT，包含 tier、eventId、actorId、targetId、opponentId、value、
actionCancelled 和 message。actorId/targetId 均為受害者，value 為減免後傷害。
message 沒有種類前綴；前端僅依 tier 將整行設為紫色或紅色。
