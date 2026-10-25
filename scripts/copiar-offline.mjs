// Copia la versión offline (un único HTML) dentro de la web publicada y
// comprueba que de verdad no depende de ningún archivo externo.
import { copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';

const origen = 'dist-offline/index.html';
const destino = 'dist/raidlab.html';

const html = readFileSync(origen, 'utf8');
const externos = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(?!data:)([^"]+)"/g)].map((m) => m[1]);
if (externos.length > 0) {
  console.error(`La versión offline aún enlaza archivos externos: ${externos.join(', ')}`);
  process.exit(1);
}

copyFileSync(origen, destino);
rmSync('dist-offline', { recursive: true, force: true });
console.log(`${destino} (${Math.round(statSync(destino).size / 1024)} KB)`);
