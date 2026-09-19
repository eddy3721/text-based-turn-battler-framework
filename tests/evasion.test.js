const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, Formulas } = require('../src');

const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });

// 落空是隨機的，但這裡測的是「落空之後那句話怎麼組」，所以一律壓成必定落空。
function setup(t, { passives = [], attack } = {}) {
  t.mock.method(Formulas, 'isHit', () => false);
  const make = (id, team, extra = {}) => new Entity({ id, name: id, team,
    stats: { hp: 100, maxHp: 100, sp: 30, atk: 10, spd: 10 }, ...extra });
  const a = make('a', 'A');
  const b = make('b', 'B', { passives });
  const skill = attack || new Skill({ id: 'strike', name: '斬擊', actions: [{ type: 'DAMAGE' }] });
  const log = logger();
  skill.execute(a, [a], [b], log);
  return { a, b, log };
}

test('a defender without an evasion passive keeps the original miss line', t => {
  const { log } = setup(t);
  assert.equal(log.logs[0].type, 'MISS');
  assert.equal(log.logs[0].message, 'a 攻擊，但是被 b 躲開了！');
  assert.equal(log.logs[0].evadeMethod, undefined);
});

test('evadeMethod fills the default miss line the same way blockMethod fills block', t => {
  const { log } = setup(t, { passives: [{
    id: 'roll', trigger: 'ON_EVADE', action: (self, evasion) => { evasion.evadeMethod = '翻滾'; }
  }] });
  assert.equal(log.logs[0].message, 'a 攻擊，但是被 b 用翻滾躲開了！');
  // 遊戲層要靠日誌辨認閃避方式時不必再解析字串。
  assert.equal(log.logs[0].evadeMethod, '翻滾');
});

test('the passive sees the incoming hit and the defender own state, so the method can vary', t => {
  const invulnerable = {
    id: 'roll', trigger: 'ON_EVADE',
    action: (self, evasion) => {
      evasion.evadeMethod = self.buffs.some(buff => buff.id === 'rolling')
        ? `翻滾的無敵幀（${evasion.skill.name}）` : '翻滾';
    }
  };
  const { b, log } = setup(t, { passives: [invulnerable] });
  assert.equal(log.logs[0].message, 'a 攻擊，但是被 b 用翻滾躲開了！');

  b.addBuff({ id: 'rolling', name: '翻滾', type: 'STAT', duration: 2 });
  const second = logger();
  new Skill({ id: 'strike', name: '斬擊', actions: [{ type: 'DAMAGE' }] })
    .execute({ ...b, id: 'a', name: 'a', isAlive: true, stats: b.stats, team: 'A' }, [], [b], second);
  assert.equal(second.logs[0].message, 'a 攻擊，但是被 b 用翻滾的無敵幀（斬擊）躲開了！');
});

test('enabled gates the passive exactly like the damage-side triggers', t => {
  const { log } = setup(t, { passives: [{
    id: 'roll', trigger: 'ON_EVADE', enabled: () => false,
    action: (self, evasion) => { evasion.evadeMethod = '翻滾'; }
  }] });
  assert.equal(log.logs[0].message, 'a 攻擊，但是被 b 躲開了！');
});

test('evadeMessage overrides the whole line, including the attacker own action.message', t => {
  const attack = new Skill({ id: 'strike', name: '斬擊', actions: [{
    type: 'DAMAGE', message: ({ caster }) => `${caster.name} 使出了必殺的一擊！`
  }] });
  const { log } = setup(t, { attack, passives: [{
    id: 'split', trigger: 'ON_EVADE',
    action: (self, evasion) => { evasion.evadeMessage = `${self.name} 的身體散成數塊，飄在空中。`; }
  }] });
  assert.equal(log.logs[0].message, 'b 的身體散成數塊，飄在空中。');
});

test('multi-hit skills resolve evasion per hit, keeping each hit own lead', t => {
  const attack = new Skill({ id: 'strike', name: '斬擊', actions: [{ type: 'DAMAGE', hits: 3 }] });
  let seen = 0;
  const { log } = setup(t, { attack, passives: [{
    id: 'roll', trigger: 'ON_EVADE',
    action: (self, evasion) => {
      seen++;
      evasion.evadeMethod = `翻滾${evasion.hitIndex}`;
    }
  }] });
  assert.equal(seen, 3);
  assert.deepEqual(log.logs.map(entry => entry.message), [
    'a 攻擊，但是被 b 用翻滾1躲開了！',
    '第 2 擊，但是被 b 用翻滾2躲開了！',
    '第 3 擊，但是被 b 用翻滾3躲開了！'
  ]);
});

test('a skill that overrides text.miss still owns the sentence and may use evadeMethod', t => {
  const attack = new Skill({ id: 'strike', name: '斬擊', actions: [{
    type: 'DAMAGE', text: { miss: ctx => `劍刃落空了——對方${ctx.evadeMethod}得乾淨俐落。` }
  }] });
  const { log } = setup(t, { attack, passives: [{
    id: 'roll', trigger: 'ON_EVADE', action: (self, evasion) => { evasion.evadeMethod = '翻滾'; }
  }] });
  assert.equal(log.logs[0].message, 'a 攻擊，劍刃落空了——對方翻滾得乾淨俐落。');
});
