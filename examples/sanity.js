const { Entity, Skill, BattleEngine, createSanityRules } = require('../src');

const attack = new Skill({ id: 'attack', name: '攻擊', actions: [{ type: 'DAMAGE' }] });
const pressure = new Skill({ id: 'pressure', name: '精神衝擊', actions: [
  { type: 'CHANGE_SANITY', amount: -50, targetType: 'ENEMY_ALL' }
] });
function unit(id, team, sanity, extra = {}) {
  return new Entity({ id, name: id, team, sanity,
    stats: { hp: 500, maxHp: 500, sp: 100, atk: 20, def: 10, spd: 10, hit: 100, cri: 0 },
    normalAttack: attack, ...extra });
}

console.log('預設玩法：精神衝擊使旅人崩潰，下一完整回合結束後恢復。');
const hero = unit('旅人', 'A', {});
const enemy = unit('低語者', 'B', false, { openingSkill: pressure });
const result = new BattleEngine([hero], [enemy], { maxTurns: 4, luckEvents: { enabled: false } }).start();
for (const log of result.logs) console.log(log.message);

const logger = { addLog: log => console.log(log.message) };
console.log('\n自訂刻度與規則：0～100，中立 50，關閉崩潰並替換狀態分類。');
const morale = unit('士氣單位', 'A', { min: 0, max: 100, neutral: 50,
  rules: createSanityRules({ panicEnabled: false, getState: s => s.value < 25 ? 'LOW_MORALE' : 'READY' }) });
morale.changeSanity(-40, logger, { source: 'FEAR' });
console.log(`仍可行動：${morale.canAct()}`);

console.log('\n純機制：到達下限仍能行動，施放率維持原值。');
const custom = unit('自訂單位', 'A', { rules: false });
custom.changeSanity(-50, logger, { source: 'CUSTOM' });
console.log(`理智 ${custom.sanity.value}；可行動 ${custom.canAct()}；施放率 ${custom.getEffectiveStats().skillCastRate}`);
