function createBodyParts(configs) {
  if (!Array.isArray(configs)) throw new Error('parts must be an array');
  const ids = new Set();
  return configs.map(({ id, name = id, maxDurability }) => {
    if (typeof id !== 'string' || !id || ids.has(id) || typeof name !== 'string' || !name ||
        !Number.isSafeInteger(maxDurability) || maxDurability <= 0) {
      throw new Error('Each part needs a unique id, a name and positive integer maxDurability');
    }
    ids.add(id);
    return { id, name, maxDurability, durability: maxDurability, broken: false };
  });
}

// Broken parts remain hittable. No parts means no extra random draw.
function selectBodyPart(parts) {
  return parts.length ? parts[Math.floor(Math.random() * parts.length)] : null;
}

function damageBodyPart(part, actualDamage, multiplier) {
  const partDamage = Math.min(part.durability, Math.floor(actualDamage * multiplier));
  const brokePart = !part.broken && partDamage > 0 && partDamage === part.durability;
  part.durability -= partDamage;
  if (brokePart) part.broken = true;
  return { partId: part.id, partName: part.name, partDamage,
    partDurability: part.durability, partMaxDurability: part.maxDurability, brokePart };
}

module.exports = { createBodyParts, selectBodyPart, damageBodyPart };
