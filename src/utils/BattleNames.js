// Remember only names assigned by the engine, so reusing an Entity in another
// battle does not turn an automatic suffix into part of its original name.
const assignedNames = new WeakMap();

function assignBattleNames(entities) {
  const originals = entities.map(entity => {
    const previous = assignedNames.get(entity);
    return previous && entity.name === previous.assigned ? previous.original : entity.name;
  });
  const reserved = new Set(originals);
  const used = new Set();
  const nextNumbers = new Map();

  entities.forEach((entity, index) => {
    const original = originals[index];
    if (typeof original !== 'string' || !original) return;
    let name = original;
    if (used.has(name)) {
      let number = nextNumbers.get(original) || 2;
      // Preserve literal names such as "桐人2" instead of assigning the same
      // name to a duplicate "桐人" earlier in the roster.
      do { name = `${original}${number++}`; } while (reserved.has(name) || used.has(name));
      nextNumbers.set(original, number);
    }
    used.add(name);
    entity.name = name;
    assignedNames.set(entity, { original, assigned: name });
  });
}

module.exports = assignBattleNames;
