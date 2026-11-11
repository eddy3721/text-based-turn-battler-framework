# 異常累積（buildup，1.0.53）

凍傷、出血這類「打一下累積一點，滿了才發動」的異常。量表記在**承受者**身上，
所以不同角色、不同技能灌的是同一條：兩個人一起鋪霜，會比各自鋪更早凍住。

框架只管量表，不解讀異常是什麼。發動後要扣血、掛 Buff、抽 SP，都由呼叫端自己寫。

```js
const FROST = { threshold: 100, growth: 25 };

const result = target.addBuildup('frost', 35, FROST);
if (result.triggered) {
  // 凍傷發動：遊戲層自己決定效果
  target.addBuff({ id: 'frostbite', name: '凍傷', type: 'STAT', duration: 3, stackPolicy: 'refresh',
    polarity: 'negative', dispellable: true, damageTaken: { multiplier: 1.2 } });
}
```

## 方法

| 方法 | 說明 |
| --- | --- |
| `addBuildup(key, amount, { threshold, growth = 0 })` | 累積 `amount`。達到門檻就發動：量表歸零（溢出不留）、門檻加 `growth`、發動次數 +1。回傳 `{ key, amount, value, threshold, count, triggered }` |
| `getBuildup(key)` | 快照 `{ key, value, threshold, count }`；沒累積過是 `null` |
| `clearBuildup(key)` | 累積值歸零。門檻與發動次數保留——被淨化不會讓抗性消失 |

## 規則

- `key` 是非空字串，代表一種異常。不同 `key` 各自一條量表。
- 同一種異常的 `threshold` 與 `growth` 要一致，第一次累積時定下，之後帶不同數字會拋錯。
  實務上把設定放在一個共用模組，所有來源都從那裡拿。
- 倒下的單位不會累積，回傳 `amount: 0`、`triggered: false`。
- 量表只活在這個 `Entity` 上，一場戰鬥一份。不會自己衰減；要衰減就由遊戲層在
  `ROUND_START` 之類的時機自己扣（`clearBuildup` 或重新設計）。
- 不擲骰、不寫戰報，沒用到時亂數序列與戰報完全不變。
- 免疫（例如 Boss 不吃異常）由遊戲層在呼叫前判斷。

測試：`tests/buildup.test.js`。
