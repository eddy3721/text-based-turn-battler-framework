const templates = {
  PURPLE: [
    '{name} 往後退後腦撞到樹受到 {damage} 點傷害。',
    '{name} 踩到香蕉皮摔倒受到 {damage} 點傷害。',
    '一顆棒球飛來砸中 {name} 的頭，造成 {damage} 點傷害。',
    '{name} 右腳踩到釘子受到 {damage} 點傷害。',
    '一把小刀飛來刺中 {name}，造成 {damage} 點傷害。',
    '天外飛來一支箭射中 {name} 的左膝蓋造成 {damage} 點傷害。',
    '一群發狂的比特犬衝過來襲擊 {name}，造成 {damage} 點傷害。'
  ],
  RED: [
    '一顆迷路的隕石精準突破大氣層，直接命中 {name} 的天靈蓋，造成 {damage} 點傷害。',
    '{name} 走在路上被卡車以時速 150 公里正面撞飛，雖然沒有成功轉生但受到了 {damage} 點傷害。',
    '{name} 踩到一塊樂高積木，造成 {damage} 點傷害。',
    '一道紅色落雷直接劈中 {name}，造成 {damage} 點傷害。',
    '一顆雄三飛彈把 {name} 的頭頂當作降落點，造成 {damage} 點傷害。'
  ]
};

function randomLuckMessage(tier, name, damage) {
  const index = Math.floor(Math.random() * templates[tier].length);
  return { eventId: `${tier.toLowerCase()}_${index + 1}`,
    message: templates[tier][index].replace(/\{name\}|\{damage\}/g,
      token => token === '{name}' ? name : String(damage)) };
}

module.exports = { templates, randomLuckMessage };
