import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RAID_SPECS,
  bloquesDelDisco,
  calcularCapacidad,
  evaluarVolumen,
  instantaneaIops,
  iopsNominales,
  normalizarNumeroDiscos,
  num,
  penalizacionEscritura,
  textoParaPdf,
} from '../src/lib/raid.js';

const discos = (nivel, estados) =>
  estados.map((status, i) => ({
    id: `BAY-${String(i + 1).padStart(2, '0')}`,
    status,
    subgroupIndex: nivel === '10' ? Math.floor(i / 2) : null,
  }));
const S = 'healthy';
const F = 'failed';
const R = 'rebuilding';

test('capacidad útil y redundancia de cada nivel (N = 6, S = 4 TB)', () => {
  const esperado = { 0: [24, 0], 1: [4, 20], 5: [20, 4], 6: [16, 8], 10: [12, 12] };
  for (const [nivel, [util, red]] of Object.entries(esperado)) {
    const m = calcularCapacidad(nivel, 6, 4);
    assert.equal(m.rawTB, 24, nivel);
    assert.equal(m.usableTB, util, nivel);
    assert.equal(m.redundancyTB, red, nivel);
    assert.equal(m.usableTB + m.redundancyTB, m.rawTB, nivel);
  }
  assert.equal(calcularCapacidad('5', 4, 4).efficiencyPct, 75);
  assert.equal(calcularCapacidad('5', 4, 4).formulaEvaluated, 'C_útil = (N − 1) × S = (4 − 1) × 4 TB = 12,0 TB');
});

test('número de discos: mínimo, máximo y par en RAID 10', () => {
  assert.deepEqual(normalizarNumeroDiscos('5', 4), { discos: 4, aviso: '' });
  assert.equal(normalizarNumeroDiscos('6', 3).discos, 4);
  assert.equal(normalizarNumeroDiscos('1', 12).discos, RAID_SPECS['1'].maxDisks);
  assert.equal(normalizarNumeroDiscos('10', 5).discos, 6);
  assert.equal(normalizarNumeroDiscos('10', 3).discos, 4);
  assert.match(normalizarNumeroDiscos('10', 7).aviso, /PAR/);
  assert.equal(normalizarNumeroDiscos('0', 'x').discos, 2);
});

test('RAID 0 cae con un solo disco averiado', () => {
  assert.equal(evaluarVolumen('0', discos('0', [S, S, S])).estado, 'OPTIMO');
  assert.equal(evaluarVolumen('0', discos('0', [S, F, S])).estado, 'CRITICO');
});

test('RAID 1 aguanta hasta N − 1 averías', () => {
  assert.equal(evaluarVolumen('1', discos('1', [F, F, S])).estado, 'DEGRADADO');
  assert.equal(evaluarVolumen('1', discos('1', [F, F, F])).estado, 'CRITICO');
  assert.equal(evaluarVolumen('1', discos('1', [R, S])).estado, 'RECONSTRUYENDO');
});

test('RAID 5: 1 avería degrada, 2 pierden el volumen (también durante el rebuild)', () => {
  assert.equal(evaluarVolumen('5', discos('5', [S, F, S, S])).estado, 'DEGRADADO');
  assert.equal(evaluarVolumen('5', discos('5', [S, R, S, S])).estado, 'RECONSTRUYENDO');
  assert.equal(evaluarVolumen('5', discos('5', [F, F, S, S])).estado, 'CRITICO');
  const enRebuild = evaluarVolumen('5', discos('5', [S, R, F, S]), { segundoFalloEnRebuild: true });
  assert.equal(enRebuild.estado, 'CRITICO');
  assert.match(enRebuild.explicacion, /Catástrofe durante el Rebuild/);
});

test('RAID 6 aguanta 2 averías cualesquiera, también un 2.º fallo en pleno rebuild', () => {
  assert.equal(evaluarVolumen('6', discos('6', [F, S, S, F, S, S])).estado, 'DEGRADADO');
  assert.equal(evaluarVolumen('6', discos('6', [R, F, S, S, S, S])).estado, 'RECONSTRUYENDO');
  assert.equal(evaluarVolumen('6', discos('6', [F, F, F, S, S, S])).estado, 'CRITICO');
});

test('RAID 10 depende del subgrupo: 3 averías en pares distintos sí, 2 en el mismo par no', () => {
  assert.equal(evaluarVolumen('10', discos('10', [F, S, F, S, F, S])).estado, 'DEGRADADO');
  const mismoPar = evaluarVolumen('10', discos('10', [F, F, S, S, S, S]));
  assert.equal(mismoPar.estado, 'CRITICO');
  assert.match(mismoPar.explicacion, /Subgrupo A/);
  assert.equal(evaluarVolumen('10', discos('10', [R, F, S, S])).estado, 'CRITICO');
});

test('reparto de bloques: una P por stripe en RAID 5, P y Q distintas en RAID 6, espejos en RAID 10', () => {
  for (const N of [3, 4, 7]) {
    const filas = Array.from({ length: N }, (_, i) => bloquesDelDisco('5', i, N));
    for (let s = 0; s < 4; s++) {
      assert.equal(filas.filter((b) => b[s].type === 'parity-p').length, 1, `RAID 5, N=${N}, stripe ${s}`);
    }
  }
  for (const N of [4, 6]) {
    const filas = Array.from({ length: N }, (_, i) => bloquesDelDisco('6', i, N));
    for (let s = 0; s < 4; s++) {
      assert.equal(filas.filter((b) => b[s].type === 'parity-p').length, 1);
      assert.equal(filas.filter((b) => b[s].type === 'parity-q').length, 1);
    }
  }
  // La paridad rota: no cae siempre en el mismo disco
  const discosP = [0, 1, 2, 3].map((s) => [0, 1, 2, 3].find((i) => bloquesDelDisco('5', i, 4)[s].type === 'parity-p'));
  assert.equal(new Set(discosP).size, 4);
  const a = bloquesDelDisco('10', 2, 6);
  const b = bloquesDelDisco('10', 3, 6);
  assert.deepEqual(a.map((x) => x.label + "' (Esp)"), b.map((x) => x.label));
});

test('IOPS: penalización de escritura clásica y orden lógico entre niveles', () => {
  assert.deepEqual(['0', '1', '5', '6', '10'].map((n) => penalizacionEscritura(n, 3)), [1, 3, 4, 6, 2]);
  // 4 × 15.000 / (0,7 + 0,3 × 4)
  assert.equal(iopsNominales('5', 4), Math.round(60000 / 1.9));
  assert.ok(iopsNominales('0', 4) > iopsNominales('10', 4));
  assert.ok(iopsNominales('10', 4) > iopsNominales('5', 4));
  assert.ok(iopsNominales('5', 6) > iopsNominales('6', 6));
});

test('IOPS según el estado: el rebuild hunde el rendimiento y el fallo crítico lo deja a 0', () => {
  const optimo = instantaneaIops('5', 4, 'OPTIMO', 0);
  const degradado = instantaneaIops('5', 4, 'DEGRADADO', 1);
  const rebuild = instantaneaIops('5', 4, 'RECONSTRUYENDO', 0);
  assert.ok(optimo.hostIops > degradado.hostIops && degradado.hostIops > rebuild.hostIops);
  assert.ok(rebuild.rebuildIops > 0);
  assert.equal(instantaneaIops('5', 4, 'CRITICO', 2).hostIops, 0);
  // En espejo el rebuild cuesta menos que con paridad
  assert.ok(instantaneaIops('10', 4, 'RECONSTRUYENDO', 0).pctOfNominal > rebuild.pctOfNominal);
});

test('formato español y texto apto para las fuentes estándar del PDF', () => {
  assert.equal(num(12, 1), '12,0');
  assert.equal(num(12345.5, 2), '12.345,50');
  const limpio = textoParaPdf('C_útil = (N − 1) × S · D = D1 ⊕ P → ≥ ✕ ● ↻ ñ €');
  assert.equal(limpio, 'C_útil = (N - 1) × S · D = D1 XOR P -> >= x * ~ ñ €');
  assert.equal(textoParaPdf('emoji 🔥'), 'emoji ?');
});
