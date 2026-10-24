# 沉默（silence，1.0.30）

Buff 帶 `silence` 就會擋下持有者的招式。被擋的那一槽不會空掉，而是改用別的攻擊。

```js
// 傳統沉默：不能用技能，普攻照常
target.addBuff({ id: 'silence', name: '沉默', type: 'STAT', duration: 2, silence: true });

// 只封法術；法師的普攻本身就是法術，被擋時改用杖擊
target.addBuff({ id: 'silence_bubble', name: '沉默', type: 'STAT', duration: 2,
  silence: { filter: (skill, entity) => skill.tags.includes('spell'), fallback: staffStrike },
  message: ({ entity, skill }) => `${entity.name} 張口想詠唱 ${skill.name}，卻發不出聲音。` });
```

| 欄位 | 說明 |
| --- | --- |
| `silence: true` | 擋下普攻以外的所有招式 |
| `silence.filter(skill, entity)` | 回傳 true 的招式被擋。可以擋到普攻 |
| `silence.fallback` | 普攻被擋時改用的 Skill。省略時是框架的 `silenced_strike`（×1 ATK） |
| `message` | 字串，或 `({ entity, buff, skill }) => string`。`skill` 是原本想用的那一招 |

## 擋在哪裡

只看行動槽的**出招選擇**：

1. 開場技能（`openingSkill`）被擋，就當作沒有開場技能，往下抽選。開場機會照樣用掉。
2. 技能抽選照舊從「可施放」的技能裡抽，抽到被擋的招才退回普攻。
   先過濾再抽會改變其他招的機率與亂數用量，沒被沉默的戰鬥亂數序列與 1.0.29 相同。
3. 普攻被擋時改用 `fallback`。替代攻擊佔普攻的位置：逐擊收費、吃速度連擊、`isNormalAttack` 為 true。

每個被擋的行動槽記一筆 `SILENCED`（`actorId`、`buffId`、`skillId`、`message`），
一槽最多一筆。技能和改用的普攻都被擋時，寫的是原本想用的技能。

不受影響：反擊、`CAST_SKILL` 與觸發型 Buff 帶出的技能、被動、遭遇戰的 `skillSelectionResolver`
（它在沉默之後執行，可以再換招）。`canCast` 不看沉默，所以沉默不會讓角色誤判成「沒體力」而喘息。

測試：`tests/silence.test.js`。
