// size1.mjs -- print {game: [codeBytes, mappedUsed, varBytes]} for the compiler at CSPIKE_ROOT with CSPIKE_OPT
import { GAMES, build } from './common.mjs';
const o = {}; for (const g of GAMES) { const u = build(g).res.usage; o[g] = [u.codegen.codeBytes, u.mapped?.used ?? u.total, u.varBytes]; }
console.log(JSON.stringify(o));
