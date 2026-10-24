# 標籤（tags，1.0.23）

技能、單一傷害段與 Buff 都能帶一組自由字串。框架**只負責驗證與傳遞，不解讀**：
沒有屬性表、沒有相剋、沒有預設的標籤清單。「火會燒掉營寨」「水會被泥偶吸收」
這種規則由遊戲層自己用被動寫。

```js
new Skill({
  id: 'fire_blast', name: '大字爆炎', tags: ['fire', 'spell'],
  actions: [
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 1.2, tags: ['aoe'] },
    { type: 'BUFF', requiresDamage: true,
      buffs: [{ id: 'burn', name: '灼傷', type: 'DOT', value: 40, duration: 2, tags: ['fire'] }] }
  ]
});
```

## 會出現在哪裡

| 情境 | `hit.tags` 的內容 |
| --- | --- |
| 技能的傷害段 | 技能 `tags` ∪ 該段 `action.tags`（去重，技能的在前） |
| DOT 扣血 | 該 Buff 的 `tags` |
| 反擊、幸運事件、環境／直接扣血 | 空陣列（除非呼叫端自己在 context 放 `tags`） |

傷害側的所有觸發器都讀得到：`BEFORE_DAMAGE`、`AFTER_DAMAGE_RECEIVED`、
`AFTER_ATTACK_RECEIVED`、`AFTER_DAMAGE_DEALT`、`AFTER_ATTACK_DEALT`、`ON_PART_BREAK`。
落空時 `ON_EVADE`／`AFTER_EVADE` 的 `evasion.tags` 也是同一份。

```js
// 被火打到就燒營
{ id: 'camps_burn', trigger: 'AFTER_DAMAGE_RECEIVED',
  enabled: (self, hit) => hit.tags.includes('fire'),
  action: (self, hit, logger) => { /* … */ } }
```

`hit.tags` 永遠是陣列（沒有標籤時是共用的凍結空陣列），讀取端不必判空。

## 規則

- 必須是**非空字串的陣列**；型別錯誤直接拋錯——安靜地變成「沒有標籤」只會看到
  「這招怎麼沒觸發」，跟機率沒中長得一樣。
- `action.tags` 只能寫在 `DAMAGE` 段。BUFF 段要帶標籤就寫在各筆 buff 設定上，
  由 DOT 自己帶著走。
- 儲存時去重並凍結；`Skill` 是跨戰鬥共用的單例，標籤不能在戰鬥中被改掉。
- 標籤不影響命中、傷害、爆擊、反擊，也不多耗任何亂數；不設標籤的技能行為與亂數
  序列跟 1.0.22 完全相同。

測試：`tests/tags.test.js`。
