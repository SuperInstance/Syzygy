#!/usr/bin/env node
// diversity.mjs — did sharing evidence make the research community converge?
// Embeds every idea (name + mechanism) of both generations and reports mean
// pairwise cosine DISTANCE within each generation (higher = more diverse) and
// how many ideas share a theme with at least 3 others (cosine sim >= 0.8).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from '../apis.mjs';
const LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const g = JSON.parse(fs.readFileSync(path.join(LOGS, 'holarchy-ideas-gen2.json'), 'utf8'));
const txt = (i) => `${i.name}. ${i.mechanism}`;
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; } return d / Math.sqrt(na * nb); };
const res = {};
for (const [name, list] of [['gen1', g.gen1], ['gen2', g.ideas]]) {
  const V = await embed(list.map(txt), { tag: `diversity:${name}` });
  const dists = [], perIdea = [];
  for (let i = 0; i < V.length; i++) { const row = []; for (let j = 0; j < V.length; j++) if (i !== j) row.push(1 - cos(V[i], V[j])); perIdea.push(row.reduce((s, x) => s + x, 0) / row.length);
    for (let j = i + 1; j < V.length; j++) dists.push(1 - cos(V[i], V[j])); }
  const crowded = V.filter((v, i) => V.filter((w, j) => j !== i && cos(v, w) >= 0.8).length >= 3).length;
  res[name] = { n: V.length, mean_pairwise_distance: +(dists.reduce((s, x) => s + x, 0) / dists.length).toFixed(4), crowded_ideas: crowded, perIdea };
  console.log(`${name}: n=${V.length}  mean pairwise cosine distance ${res[name].mean_pairwise_distance}  ideas in a crowd (>=3 neighbours at sim>=0.8): ${crowded}`);
}
// unpaired: bootstrap on per-idea mean distances (each idea's distance to its own generation)
const a = res.gen2.perIdea, b = res.gen1.perIdea, m = (x) => x.reduce((s, y) => s + y, 0) / x.length;
console.log(`gen2 - gen1 per-idea mean distance: ${(m(a) - m(b)).toFixed(4)}`);
fs.writeFileSync(path.join(LOGS, 'holarchy-diversity.json'), JSON.stringify(res, null, 1));
