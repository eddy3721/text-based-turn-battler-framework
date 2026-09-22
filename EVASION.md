# 閃避風格

命中判定失敗時，防守方可以說明「這次是怎麼躲掉的」。宣告
`trigger: 'ON_EVADE'` 的被動會在每一個落空的擊上執行一次。

```js
const roll = () => ({
  id: 'roll',
  trigger: 'ON_EVADE',
  action: (self, evasion) => {
    evasion.evadeMethod = self.buffs.some(buff => buff.id === 'rolling')
      ? '翻滾的無敵幀' : '翻滾';
  }
});
```

    a 攻擊，但是被 b 用翻滾躲開了！

## 為什麼要有這條路

這是 `BEFORE_DAMAGE`／`blockMethod` 的對稱邊。那邊是「擋下」——攻擊命中了，
傷害被防守方吃掉；這邊是「躲開」——攻擊根本沒碰到。

原本只有前者能由防守方描述。落空發生在 `takeDamage` **之前**，連 hit 物件都還
沒建立，所以戰報只能印攻擊方 `action.text.miss` 那句通用的「但是被 X 躲開了！」。
任何有自己閃避方式的單位（翻滾、分裂、殘影、瞬移）都只能在遊戲層事後改寫字串，
而那種改寫看不到戰鬥狀態，只能靠日誌裡的標記硬猜視窗的起訖——多段技能、
同名單位、已存檔的舊戰報都會讓它出錯。

## 兩個欄位

| 欄位 | 用途 |
| --- | --- |
| `evadeMethod` | 片段。交給預設文案拼成「但是被 X 用某某躲開了！」，與 `blockMethod` 同型 |
| `evadeMessage` | 整句覆寫。留給拼不出來的演出，例如「身體散成數塊，飄在空中」 |

兩個都不設就維持原本的預設句，既有單位的戰報一字不變——沒有 `evadeMethod` 時
連空白都與改版前相同。

`evadeMessage` **優先於攻擊方的 `action.message`**。這是這裡唯一一處防守方蓋過
攻擊方的地方，理由是「對手是怎麼躲掉的」只有防守方知道，攻擊方的技能文案寫不出來。
反過來說，攻擊方若自己覆寫了 `text.miss`，那句話仍然由它掌握，可自行讀取
`ctx.evadeMethod` 決定要不要用。優先序：

    evadeMessage → action.message → action.text.miss → 預設片段

## evasion 欄位

被動收到的第二個參數帶著這一擊的來龍去脈，欄位與 `BEFORE_DAMAGE` 的 hit 同名：

| 欄位 | 意義 |
| --- | --- |
| `caster`, `target` | 攻擊方與防守方；`target` 恆為 self |
| `skill`, `action` | 落空的技能與該段動作 |
| `hitIndex`, `hits` | 第幾擊／總段數 |
| `isNormalAttack` | 是否為普攻（含速度連擊） |
| `evadeMethod`, `evadeMessage` | 寫入欄位，預設皆為 null |

`enabled(self, evasion)` 的用法與傷害側的觸發器完全一致，回傳 false 就跳過。

## 判定範圍

- **每一個落空的擊各自執行一次**，多段技能與速度連擊因此可以逐擊給不同文案。
- 反擊的還擊不進入這條路：反擊已經通過了自己的判定，必定命中，不會落空。
- 只作用於命中判定失敗。被格擋、零傷害、DOT 與直接 `takeDamage` 都不算閃避，
  那些仍走 `BEFORE_DAMAGE`／`blockMethod`。
- **`ON_EVADE` 不要改變戰鬥狀態，它只負責描述。** 它跑在 MISS 日誌組句之前，
  所以既拿不到 logger，在這裡印東西也會排到「但是被 X 躲開了！」前面。
  要對「被躲掉」產生後果，用下面的 `AFTER_EVADE`。

## AFTER_EVADE：閃避的反應側（1.0.16）

`ON_EVADE` 只能描述。想讓「躲掉」本身有後果——回資源、疊層數、掛增益——
宣告 `trigger: 'AFTER_EVADE'`，它在 **MISS 日誌送出之後**對防守方執行。

```js
// 綠龜護符：輕裝翻滾落地即起，躲一次回 6 SP。
const turtle = () => ({
  id: 'turtle', trigger: 'AFTER_EVADE',
  action: (self, evasion, logger, engine) => {
    const restored = self.restoreSp(6, logger);
    if (restored <= 0) return;
    logger?.addLog({ type: 'SP_RECOVER', actorId: self.id, value: restored,
      message: `${self.name} 落地即起，回復 ${restored} SP！` });
  }
});
```

    a 攻擊，但是被 b 用翻滾躲開了！
    b 落地即起，回復 6 SP！

**為什麼是新的觸發器，而不是給 `ON_EVADE` 加 logger。** 兩件事的時點不同：
描述必須在組句之前，反應必須在組句之後。把 logger 交給 `ON_EVADE`，後果就會
印在「躲掉了」前面——先看到結果，才看到原因。這不是參數問題，是階段問題。

**在此之前這類設計無處可掛。** 這一節原本寫著「請用傷害側的觸發器」，
但落空根本不會進 `takeDamage`，從 `BEFORE_DAMAGE` 到 `AFTER_ATTACK_RECEIVED`
一個都不會響——傷害側對落空是全啞的，那句話等於沒有給出路。

- 簽章 `(self, evasion, logger, engine)`，與傷害側的觸發器一致；
  `enabled(self, evasion)` 同樣可用。
- 收到的 `evasion` 就是 `ON_EVADE` 剛填完的那一個，讀得到 `evadeMethod`。
- 每一個落空的擊各觸發一次，與 `ON_EVADE` 同頻。
- 防守方已陣亡時不執行；`engine.result` 出現後停止。
- **開放的是副作用，不是重新結算。** 這一擊已經確定落空，在這裡做什麼都不會
  讓它變成命中。

`evadeMethod` 有值時會一併寫進 `MISS` 日誌，遊戲層要據此上標籤或換樣式時
不必再去解析訊息字串。

驗證：`node --test tests/evasion.test.js`。
