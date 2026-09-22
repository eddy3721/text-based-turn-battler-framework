const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, Formulas } = require('../src');

const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });

// 落空是隨機的，但這裡測的是「落空之後那句話怎麼組」，所以一律壓成必定落空。
// defenderStats 合併進防守方的能力值。AFTER_EVADE 的測試需要「SP 還有空間可以回」，
// 而預設的 sp 就是 maxSp，restoreSp 會回 0。
function setup(t, { passives = [], attack, defenderStats } = {}) {
  t.mock.method(Formulas, 'isHit', () => false);
  const base = { hp: 100, maxHp: 100, sp: 30, atk: 10, spd: 10 };
  const make = (id, team, extra = {}) => new Entity({ id, name: id, team, stats: base, ...extra });
  const a = make('a', 'A');
  const b = make('b', 'B', { passives, stats: { ...base, ...defenderStats } });
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

// --- AFTER_EVADE（1.0.16）：閃避的反應側 ---

test('AFTER_EVADE runs after the MISS log, so consequences read below the dodge', t => {
  const { log } = setup(t, { defenderStats: { sp: 10, maxSp: 30 }, passives: [
    { id: 'roll', trigger: 'ON_EVADE', action: (self, evasion) => { evasion.evadeMethod = '翻滾'; } },
    {
      id: 'turtle', trigger: 'AFTER_EVADE',
      action: (self, evasion, logger) => {
        const restored = self.restoreSp(6, logger);
        logger.addLog({ type: 'SP_RECOVER', actorId: self.id, value: restored,
          message: `${self.name} 落地即起，回復 ${restored} SP！` });
      }
    }
  ] });
  // 順序是這個觸發器存在的理由：先「躲掉了」，後果才接在下一行。
  assert.deepEqual(log.logs.map(entry => entry.message), [
    'a 攻擊，但是被 b 用翻滾躲開了！',
    'b 落地即起，回復 6 SP！'
  ]);
});

test('AFTER_EVADE really changes state, which ON_EVADE alone could not express', t => {
  const { b } = setup(t, { defenderStats: { sp: 10, maxSp: 30 }, passives: [{
    id: 'turtle', trigger: 'AFTER_EVADE',
    action: self => { self.restoreSp(6); }
  }] });
  assert.equal(b.stats.sp, 16, '躲一次回 6 SP——這正是傷害側表達不了的那件事');
});

test('AFTER_EVADE sees the same evasion object ON_EVADE just filled in', t => {
  let seen = null;
  setup(t, { passives: [
    { id: 'roll', trigger: 'ON_EVADE', action: (self, evasion) => { evasion.evadeMethod = '翻滾'; } },
    { id: 'observe', trigger: 'AFTER_EVADE', action: (self, evasion) => { seen = evasion; } }
  ] });
  assert.equal(seen.evadeMethod, '翻滾');
  assert.equal(seen.caster.id, 'a');
  assert.equal(seen.target.id, 'b');
});

test('AFTER_EVADE honours enabled and fires once per missed hit', t => {
  const attack = new Skill({ id: 'strike', name: '斬擊', actions: [{ type: 'DAMAGE', hits: 3 }] });
  let all = 0, odd = 0;
  setup(t, { attack, passives: [
    { id: 'every', trigger: 'AFTER_EVADE', action: () => { all++; } },
    {
      id: 'odd', trigger: 'AFTER_EVADE',
      enabled: (self, evasion) => evasion.hitIndex % 2 === 1,
      action: () => { odd++; }
    }
  ] });
  assert.equal(all, 3);
  assert.equal(odd, 2);
});

test('a defender with only ON_EVADE is untouched, and logger stays optional', t => {
  // 既有消費者一個字都不該變：ON_EVADE 仍然只收 (self, evasion)。
  let args = null;
  const { log } = setup(t, { passives: [{
    id: 'roll', trigger: 'ON_EVADE',
    action: (...received) => { args = received; received[1].evadeMethod = '翻滾'; }
  }] });
  assert.equal(args.length, 2, 'ON_EVADE 的簽章沒有變');
  assert.equal(log.logs.length, 1);
  assert.equal(log.logs[0].message, 'a 攻擊，但是被 b 用翻滾躲開了！');
});
