// Motor de RAIDLab sin DOM: reglas de cada nivel, capacidad, estado del volumen,
// reparto de bloques y modelo de IOPS. Lo usan la interfaz (src/app.js) y las
// pruebas (`npm test`).

/**
 * ============================================================================
 * DOCUMENTACIÓN DE LA LÓGICA MATEMÁTICA DE RAID Y TOLERANCIA A FALLOS
 * ============================================================================
 *
 * Sea:
 *   N = Número total de discos físicos en el arreglo.
 *   S = Capacidad individual de cada disco en Terabytes (TB).
 *   C_bruta = N * S (Capacidad física total instalada).
 *
 * 1. RAID 0 (Striping / Fragmentación pura):
 *    - Restricción: N >= 2
 *    - Capacidad Útil: C_útil = N * S
 *    - Capacidad de Redundancia: C_red = 0
 *    - Tolerancia a Fallos: 0 discos.
 *    - Ecuación de estado: Si discos_averiados >= 1 => FALLO CRÍTICO (Pérdida total, ya que
 *      cada archivo está fragmentado secuencialmente entre los N discos sin paridad).
 *
 * 2. RAID 1 (Mirroring / Espejado completo N-way):
 *    - Restricción: N >= 2
 *    - Capacidad Útil: C_útil = S (todos los N discos contienen una réplica idéntica de los bloques)
 *    - Capacidad de Redundancia: C_red = (N - 1) * S
 *    - Tolerancia a Fallos: (N - 1) discos.
 *    - Ecuación de estado:
 *        * discos_averiados == 0           => ÓPTIMO
 *        * 1 <= discos_averiados <= N - 1  => DEGRADADO (al menos 1 espejo sano conserva el 100% de datos)
 *        * discos_averiados == N           => FALLO CRÍTICO (todas las réplicas han caído)
 *
 * 3. RAID 5 (Striping a nivel de bloque con Paridad Simple Distribuida XOR):
 *    - Restricción: N >= 3
 *    - Capacidad Útil: C_útil = (N - 1) * S
 *    - Capacidad de Redundancia: C_red = 1 * S
 *    - Fundamento algebraico: Para cada fila (stripe), el bloque de paridad P se calcula mediante
 *      la operación lógica OR Exclusivo (XOR):
 *      P = D_1 ⊕ D_2 ⊕ ... ⊕ D_{N-1}
 *      Propiedad de inversión de XOR: Si cualquier disco i falla, su bloque D_i se reconstruye en tiempo real:
 *      D_i = D_1 ⊕ ... ⊕ D_{i-1} ⊕ D_{i+1} ⊕ ... ⊕ P
 *    - Tolerancia a Fallos: 1 disco.
 *    - Ecuación de estado:
 *        * discos_averiados == 0 => ÓPTIMO
 *        * discos_averiados == 1 => DEGRADADO (1 incógnita en 1 ecuación XOR: soluble)
 *        * discos_averiados >= 2 => FALLO CRÍTICO (2 incógnitas en 1 sola ecuación XOR: sistema indeterminado, pérdida de datos).
 *
 * 4. RAID 6 (Striping con Doble Paridad Distribuida Independiente P + Q):
 *    - Restricción: N >= 4
 *    - Capacidad Útil: C_útil = (N - 2) * S
 *    - Capacidad de Redundancia: C_red = 2 * S
 *    - Fundamento algebraico: Genera dos síndromes independientes por cada stripe:
 *      Síndrome P (XOR simple): P = D_1 ⊕ D_2 ⊕ ... ⊕ D_{N-2}
 *      Síndrome Q (Álgebra de Campos de Galois GF(2^8) / Reed-Solomon):
 *      Q = (g^1 · D_1) ⊕ (g^2 · D_2) ⊕ ... ⊕ (g^{N-2} · D_{N-2})
 *      Esto forma un sistema lineal de 2 ecuaciones independientes capaz de despejar hasta 2 incógnitas (2 discos caídos).
 *    - Tolerancia a Fallos: 2 discos cualesquiera.
 *    - Ecuación de estado:
 *        * discos_averiados == 0          => ÓPTIMO
 *        * discos_averiados == 1 o == 2   => DEGRADADO (soluble mediante P o sistema P+Q)
 *        * discos_averiados >= 3          => FALLO CRÍTICO (3 incógnitas superan los 2 síndromes P y Q).
 *
 * 5. RAID 10 / RAID 1+0 (Stripe de Subgrupos Espejo):
 *    - Restricción: N >= 4 y N mod 2 == 0 (número par de discos).
 *    - Topología: Los N discos se dividen en K = N / 2 subgrupos espejo (Span 0, Span 1, ..., Span K-1),
 *      donde cada subgrupo m contiene exactamente 2 discos en RAID 1: Par_m = { Disco_{2m}, Disco_{2m+1} }.
 *      Sobre esos K subgrupos se aplica un RAID 0 (Stripe global).
 *    - Capacidad Útil: C_útil = (N / 2) * S
 *    - Capacidad de Redundancia: C_red = (N / 2) * S
 *    - Ecuación de Tolerancia a Fallos por Subgrupos:
 *      Un subgrupo espejo m sobrevive mientras al menos 1 de sus 2 discos esté operativo.
 *      Si AMBOS discos de un mismo subgrupo m fallan (Averiados(Par_m) == 2), ese subgrupo pierde el 100% de sus
 *      bloques; como el nivel superior es un RAID 0 (sin paridad entre subgrupos), el volumen completo sufre FALLO CRÍTICO.
 *      Por tanto:
 *        * Si existe algún subgrupo m con 2 discos averiados => FALLO CRÍTICO (incluso si solo han fallado 2 discos en total).
 *        * Si ningún subgrupo tiene 2 discos averiados, pero hay >= 1 disco averiado => DEGRADADO (puede tolerar hasta
 *          K = N / 2 discos averiados simultáneamente siempre que pertenezcan a subgrupos espejo distintos).
 * ============================================================================
 */

export const RAID_SPECS = {
  '0': {
    name: 'RAID 0',
    tag: 'Striping Puro (Sin Redundancia)',
    minDisks: 2,
    maxDisks: 12,
    requireEven: false,
    defaultDisks: 4,
    constraintText: 'Requiere mínimo 2 discos. Fragmenta datos en paralelo para máximo rendimiento pero 0 tolerancia a fallos.',
    formulaSymbolic: 'C_útil = N × S',
    formulaNote: 'El 100% de los bloques se destina a datos distribuidos (Striping). No existen bloques de paridad ni espejos.',
  },
  '1': {
    name: 'RAID 1',
    tag: 'Espejado Completo (Mirroring)',
    minDisks: 2,
    maxDisks: 8,
    requireEven: false,
    defaultDisks: 2,
    constraintText: 'Requiere mínimo 2 discos. Cada unidad mantiene una copia idéntica bloque a bloque del volumen.',
    formulaSymbolic: 'C_útil = S   |   C_redundancia = (N − 1) × S',
    formulaNote: 'Todos los discos almacenan exactamente los mismos bloques. Sobrevive mientras quede al menos 1 disco sano.',
  },
  '5': {
    name: 'RAID 5',
    tag: 'Paridad Simple Distribuida (XOR)',
    minDisks: 3,
    maxDisks: 12,
    requireEven: false,
    defaultDisks: 4,
    constraintText: 'Requiere mínimo 3 discos. Soporta la avería de 1 unidad mediante cálculo XOR rotativo.',
    formulaSymbolic: 'C_útil = (N − 1) × S',
    formulaNote: 'La capacidad equivalente a 1 disco físico se reparte entre todas las unidades para almacenar paridad XOR.',
  },
  '6': {
    name: 'RAID 6',
    tag: 'Doble Paridad Distribuida (P + Q)',
    minDisks: 4,
    maxDisks: 12,
    requireEven: false,
    defaultDisks: 6,
    constraintText: 'Requiere mínimo 4 discos. Soporta hasta 2 discos averiados simultáneamente (XOR + Reed-Solomon).',
    formulaSymbolic: 'C_útil = (N − 2) × S',
    formulaNote: 'La capacidad equivalente a 2 discos se destina a los síndromes independientes P (XOR) y Q (Campos de Galois).',
  },
  '10': {
    name: 'RAID 10',
    tag: 'Híbrido Espejo + Stripe (RAID 1+0)',
    minDisks: 4,
    maxDisks: 12,
    requireEven: true,
    defaultDisks: 4,
    constraintText: 'Requiere mínimo 4 discos y número PAR. Divide las unidades en pares espejo (RAID 1) unidos en Stripe (RAID 0).',
    formulaSymbolic: 'C_útil = (N / 2) × S',
    formulaNote: 'El 50% de la capacidad se dedica a espejar cada subgrupo par. Resiste hasta N/2 fallos si ocurren en subgrupos distintos.',
  },
};

/** Número con formato español (coma decimal). */
export function num(valor, decimales = 1) {
  return Number(valor).toLocaleString('es-ES', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

/**
 * Ajusta el número de discos a las reglas del nivel (mínimo, máximo y par en RAID 10).
 * Devuelve { discos, aviso } con un aviso vacío si no hubo que corregir nada.
 */
export function normalizarNumeroDiscos(nivel, solicitado) {
  const spec = RAID_SPECS[nivel];
  let discos = parseInt(solicitado, 10);
  let aviso = '';

  if (Number.isNaN(discos) || discos < spec.minDisks) {
    aviso = `${spec.name} exige un mínimo estricto de ${spec.minDisks} discos. Ajustado automáticamente a ${spec.minDisks}.`;
    discos = spec.minDisks;
  } else if (discos > spec.maxDisks) {
    aviso = `El bastidor admite hasta ${spec.maxDisks} bahías para este modo.`;
    discos = spec.maxDisks;
  }

  // En RAID 10 el número de discos debe ser PAR para formar pares espejo
  if (spec.requireEven && discos % 2 !== 0) {
    const ajustado = discos + 1 <= spec.maxDisks ? discos + 1 : discos - 1;
    aviso = `RAID 10 requiere un número PAR de discos para formar subgrupos espejo (RAID 1). Ajustado de ${discos} a ${ajustado} discos.`;
    discos = ajustado;
  }
  return { discos, aviso };
}

/** Capacidad bruta, útil, redundancia y tolerancia a fallos para N discos de S TB. */
export function calcularCapacidad(nivel, N, S) {
  const rawTB = N * S;
  let usableTB = 0;
  let redundancyTB = 0;
  let formulaEvaluated = '';
  let faultToleranceLabel = '';
  let maxGuaranteedFaults = 0;

  switch (nivel) {
    case '0':
      usableTB = N * S;
      formulaEvaluated = `C_útil = N × S = ${N} × ${S} TB = ${num(usableTB)} TB`;
      faultToleranceLabel = '0 discos';
      maxGuaranteedFaults = 0;
      break;
    case '1':
      usableTB = S;
      redundancyTB = (N - 1) * S;
      formulaEvaluated = `C_útil = 1 × S = ${num(usableTB)} TB  |  Espejo = (${N} − 1) × ${S} TB = ${num(redundancyTB)} TB`;
      faultToleranceLabel = `${N - 1} ${N - 1 === 1 ? 'disco' : 'discos'}`;
      maxGuaranteedFaults = N - 1;
      break;
    case '5':
      usableTB = (N - 1) * S;
      redundancyTB = S;
      formulaEvaluated = `C_útil = (N − 1) × S = (${N} − 1) × ${S} TB = ${num(usableTB)} TB`;
      faultToleranceLabel = '1 disco';
      maxGuaranteedFaults = 1;
      break;
    case '6':
      usableTB = (N - 2) * S;
      redundancyTB = 2 * S;
      formulaEvaluated = `C_útil = (N − 2) × S = (${N} − 2) × ${S} TB = ${num(usableTB)} TB`;
      faultToleranceLabel = '2 discos';
      maxGuaranteedFaults = 2;
      break;
    case '10':
      usableTB = (N / 2) * S;
      redundancyTB = (N / 2) * S;
      formulaEvaluated = `C_útil = (N / 2) × S = (${N} / 2) × ${S} TB = ${num(usableTB)} TB`;
      faultToleranceLabel = `1 a ${N / 2} discos*`;
      maxGuaranteedFaults = 1;
      break;
  }

  return {
    N,
    S,
    rawTB,
    usableTB,
    redundancyTB,
    efficiencyPct: rawTB > 0 ? (usableTB / rawTB) * 100 : 0,
    redundancyPct: rawTB > 0 ? (redundancyTB / rawTB) * 100 : 0,
    formulaEvaluated,
    faultToleranceLabel,
    maxGuaranteedFaults,
  };
}

/**
 * Etiquetas de los 4 primeros stripes que guarda un disco: datos, espejos y
 * paridad rotativa P (XOR) / Q (Reed-Solomon).
 */
export function bloquesDelDisco(nivel, diskIdx, totalDisks) {
  return [0, 1, 2, 3].map((s) => {
    if (nivel === '0') {
      return { label: `D${s * totalDisks + diskIdx}`, type: 'data', stripe: s };
    }
    if (nivel === '1') {
      return {
        label: diskIdx === 0 ? `D${s}` : `D${s}' (Esp)`,
        type: diskIdx === 0 ? 'data' : 'mirror',
        stripe: s,
      };
    }
    if (nivel === '5') {
      // Paridad rotativa: en el stripe s, P va en el disco (N − 1 − s) mod N
      const parityDisk = (totalDisks - 1 - (s % totalDisks) + totalDisks) % totalDisks;
      if (diskIdx === parityDisk) return { label: `P${s} (XOR)`, type: 'parity-p', stripe: s };
      return { label: `D${s}_${diskIdx}`, type: 'data', stripe: s };
    }
    if (nivel === '6') {
      const pDisk = (totalDisks - 2 - (s % totalDisks) + totalDisks) % totalDisks;
      const qDisk = (totalDisks - 1 - (s % totalDisks) + totalDisks) % totalDisks;
      if (diskIdx === pDisk) return { label: `P${s} (XOR)`, type: 'parity-p', stripe: s };
      if (diskIdx === qDisk) return { label: `Q${s} (GF)`, type: 'parity-q', stripe: s };
      return { label: `D${s}_${diskIdx}`, type: 'data', stripe: s };
    }
    if (nivel === '10') {
      const dataIndex = s * (totalDisks / 2) + Math.floor(diskIdx / 2);
      const isMirrorHalf = diskIdx % 2 === 1;
      return {
        label: isMirrorHalf ? `D${dataIndex}' (Esp)` : `D${dataIndex}`,
        type: isMirrorHalf ? 'mirror' : 'data',
        stripe: s,
      };
    }
    return { label: `B${s}`, type: 'data', stripe: s };
  });
}

// ---------------------------------------------------------------------------
// Modelo de IOPS (didáctico)
// ---------------------------------------------------------------------------
// IOPS funcionales = N × IOPS_disco / (%lectura + %escritura × penalización),
// con la penalización de escritura clásica de cada nivel: RAID 0 → 1,
// RAID 1 → N (se escribe en todas las copias), RAID 5 → 4 (leer dato y paridad,
// escribir dato y paridad), RAID 6 → 6 y RAID 10 → 2.
export const IOPS_POR_DISCO = 15000; // SSD empresarial (supuesto del simulador)
export const FRACCION_LECTURA = 0.7; // carga típica: 70 % lectura / 30 % escritura

export function penalizacionEscritura(nivel, N) {
  return { 0: 1, 1: N, 5: 4, 6: 6, 10: 2 }[nivel] ?? 1;
}

export function iopsNominales(nivel, N, { iopsDisco = IOPS_POR_DISCO, lectura = FRACCION_LECTURA } = {}) {
  const penal = penalizacionEscritura(nivel, N);
  return Math.round((N * iopsDisco) / (lectura + (1 - lectura) * penal));
}

/**
 * IOPS disponibles para las aplicaciones y tráfico interno según el estado del
 * volumen. Los factores de degradación y rebuild son aproximados: en RAID 5/6
 * hay que leer todos los discos para recalcular cada bloque perdido; en RAID 1/10
 * basta con leer la copia.
 */
export function instantaneaIops(nivel, N, estado, averiados, ruido = 0) {
  const maxNominal = iopsNominales(nivel, N);
  const resultado = (hostIops, rebuildIops, phase) => ({
    maxNominal,
    hostIops,
    rebuildIops,
    pctOfNominal: Math.round((hostIops / maxNominal) * 100),
    phase,
  });
  if (estado === 'CRITICO') return resultado(0, 0, 'CRITICO');

  const espejo = nivel === '1' || nivel === '10';
  if (estado === 'RECONSTRUYENDO') {
    let hostFactor = 0.28;
    let rebuildFactor = 0.68;
    if (nivel === '6') {
      hostFactor = averiados > 0 ? 0.2 : 0.25;
      rebuildFactor = 0.72;
    } else if (espejo) {
      hostFactor = 0.52;
      rebuildFactor = 0.44;
    }
    return resultado(
      Math.max(500, Math.round(maxNominal * hostFactor + ruido)),
      Math.max(1000, Math.round(maxNominal * rebuildFactor - ruido * 0.6)),
      'RECONSTRUYENDO',
    );
  }
  if (estado === 'DEGRADADO') {
    let factor = 0.58;
    let sobrecarga = 0.28;
    if (nivel === '6') {
      factor = averiados >= 2 ? 0.44 : 0.56;
      sobrecarga = averiados >= 2 ? 0.42 : 0.3;
    } else if (espejo) {
      factor = 0.82;
      sobrecarga = 0.1;
    }
    return resultado(
      Math.max(1000, Math.round(maxNominal * factor + ruido)),
      Math.round(maxNominal * sobrecarga),
      'DEGRADADO',
    );
  }
  return resultado(
    Math.min(maxNominal, Math.max(Math.round(maxNominal * 0.94), Math.round(maxNominal * 0.98 + ruido))),
    0,
    'OPTIMO',
  );
}

// Las fuentes estándar de jsPDF solo tienen los caracteres de Windows-1252.
const SUSTITUTOS_PDF = {
  '−': '-',
  '⊕': 'XOR',
  '→': '->',
  '≥': '>=',
  '≤': '<=',
  '✕': 'x',
  '●': '*',
  '▲': '!',
  '■': '#',
  '↻': '~',
  '₁': '1',
  '₂': '2',
  '⁸': '8',
};
const EXTRA_CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Deja el texto en caracteres que jsPDF pinta con sus fuentes estándar. */
export function textoParaPdf(texto) {
  return [...texto]
    .map((c) => {
      if (SUSTITUTOS_PDF[c]) return SUSTITUTOS_PDF[c];
      const cp = c.codePointAt(0);
      if (cp === 10 || (cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255) || EXTRA_CP1252.has(c)) return c;
      return '?';
    })
    .join('');
}

/**
 * Estado del volumen a partir del estado de cada disco.
 * `discos`: [{ id, status: 'healthy' | 'failed' | 'rebuilding', subgroupIndex }].
 * Un disco en 'rebuilding' aún no tiene sus datos completos: cuenta como no disponible.
 * Devuelve { estado: 'OPTIMO' | 'DEGRADADO' | 'RECONSTRUYENDO' | 'CRITICO', explicacion }.
 */
export function evaluarVolumen(nivel, discos, { segundoFalloEnRebuild = false } = {}) {
  const N = discos.length;
  const nonHealthyDisks = discos.filter((d) => d.status !== 'healthy');
  const failedDisks = discos.filter((d) => d.status === 'failed');
  const rebuildingDisks = discos.filter((d) => d.status === 'rebuilding');
  const totalUnavailable = nonHealthyDisks.length;

  let isCriticalLoss = false;
  let explanation = '';

  switch (nivel) {
    case '0':
      // RAID 0 no tolera ningún disco fuera de línea
      if (totalUnavailable >= 1) {
        isCriticalLoss = true;
        explanation = `Fallo Crítico en RAID 0: La unidad ${nonHealthyDisks[0].id} ha fallado. Al no existir paridad ni espejo, los fragmentos (stripes) alojados en ese disco se han perdido irremediablemente y el sistema de archivos completo queda corrupto.`;
      } else {
        explanation = `Todas las ${N} unidades en Striping operan nominalmente. Rendimiento máximo de lectura/escritura secuencial, pero con riesgo total ante cualquier fallo físico.`;
      }
      break;

    case '1':
      // RAID 1 sobrevive mientras exista al menos 1 disco 'healthy' con la copia íntegra
      if (totalUnavailable >= N) {
        isCriticalLoss = true;
        explanation = `Fallo Crítico en RAID 1: Las ${N} unidades espejo han caído simultáneamente. No queda ninguna réplica sana desde la cual servir o reconstruir los bloques.`;
      } else if (rebuildingDisks.length > 0) {
        explanation = `Reconstruyendo espejo en ${rebuildingDisks[0].id} copiando secuencialmente los bloques desde una unidad espejo sana (${N - totalUnavailable} ${N - totalUnavailable === 1 ? 'unidad sana activa' : 'unidades sanas activas'}).`;
      } else if (failedDisks.length > 0) {
        explanation = `Arreglo RAID 1 Degradado: ${failedDisks.length} ${failedDisks.length === 1 ? 'disco averiado' : 'discos averiados'}. El volumen sigue operando sin pérdida de datos gracias a ${N - failedDisks.length} ${N - failedDisks.length === 1 ? 'espejo sobreviviente' : 'espejos sobrevivientes'}.`;
      } else {
        explanation = `Espejado RAID 1 Óptimo: Los ${N} discos mantienen réplicas idénticas en tiempo real. Tolerancia hasta ${N - 1} ${N - 1 === 1 ? 'fallo' : 'fallos'}.`;
      }
      break;

    case '5':
      // RAID 5 tolera exactamente 1 disco no disponible (averiado o a mitad de rebuild).
      // Si un 2.º disco falla antes de que termine el rebuild, se pierden 2 incógnitas por stripe => PÉRDIDA DE DATOS.
      if (totalUnavailable >= 2) {
        isCriticalLoss = true;
        if (segundoFalloEnRebuild) {
          explanation = `¡Catástrofe durante el Rebuild en RAID 5! Mientras se reconstruía una unidad leyendo todos los discos restantes, ocurrió un segundo fallo (${nonHealthyDisks.map((d) => d.id).join(' y ')}). Una única ecuación XOR no puede despejar 2 bloques desconocidos por stripe: pérdida total del volumen.`;
        } else {
          explanation = `Fallo Crítico en RAID 5: ${totalUnavailable} unidades fuera de línea (${nonHealthyDisks.map((d) => d.id).join(', ')}). La paridad simple XOR solo resuelve 1 incógnita por fila; con 2 discos caídos el sistema algebraico es indeterminado y se pierden los datos.`;
        }
      } else if (rebuildingDisks.length === 1) {
        explanation = `Reconstruyendo ${rebuildingDisks[0].id} mediante cálculo XOR inverso (D_perdido = D_restantes ⊕ P). Todas las ${N - 1} unidades sanas están bajo estrés extremo de lectura al 100%: si falla otro disco ahora, el volumen colapsará.`;
      } else if (failedDisks.length === 1) {
        explanation = `Volumen RAID 5 Degradado: ${failedDisks[0].id} ha sufrido una avería. No hay pérdida de datos porque el controlador recalcula al vuelo cada bloque faltante aplicando XOR sobre los ${N - 1} discos sobrevivientes (penalización en lecturas).`;
      } else {
        explanation = `Volumen RAID 5 Óptimo: Paridad XOR distribuida cíclicamente entre los ${N} discos. Soporta la caída de 1 unidad física sin interrupción del servicio.`;
      }
      break;

    case '6':
      // RAID 6 tolera hasta 2 discos no disponibles (averiados o en rebuild) gracias a doble paridad P + Q.
      if (totalUnavailable >= 3) {
        isCriticalLoss = true;
        explanation = `Fallo Crítico en RAID 6: ${totalUnavailable} unidades fuera de línea (${nonHealthyDisks.map((d) => d.id).join(', ')}). Se ha superado el límite de 2 síndromes independientes (P + Q en Campos de Galois). Pérdida irreversible del volumen.`;
      } else if (rebuildingDisks.length > 0) {
        const extraFailed = failedDisks.length;
        if (extraFailed === 1) {
          explanation = `¡Segundo fallo absorbido durante Rebuild en RAID 6! Aunque ${failedDisks[0].id} falló mientras ${rebuildingDisks[0].id} se reconstruía, la doble paridad (P + Q Reed-Solomon) mantiene vivo el volumen y continúa la reconstrucción sin perder datos.`;
        } else {
          explanation = `Reconstruyendo ${rebuildingDisks[0].id} con protección de doble paridad P + Q. Incluso si otro disco físico falla durante este proceso, RAID 6 evitará la pérdida de datos.`;
        }
      } else if (failedDisks.length === 2) {
        explanation = `Volumen RAID 6 en Degradación Doble (${failedDisks.map((d) => d.id).join(' y ')} averiados). El controlador resuelve simultáneamente las 2 incógnitas usando los síndromes P (XOR) y Q (GF(2^8)). Margen de tolerancia restante: 0 discos.`;
      } else if (failedDisks.length === 1) {
        explanation = `Volumen RAID 6 Degradado (${failedDisks[0].id} averiado). Datos íntegros servidos vía paridad P. Aún puede fallar 1 disco adicional en cualquier bahía sin perder el volumen.`;
      } else {
        explanation = `Volumen RAID 6 Óptimo: Doble paridad distribuida (P + Q) activa en las ${N} unidades. Protegido frente a hasta 2 fallos de disco simultáneos.`;
      }
      break;

    case '10': {
      // RAID 10: Se evalúa subgrupo por subgrupo. Cada subgrupo m = 0..(N/2 - 1) tiene 2 discos en espejo.
      // Si algún subgrupo tiene sus 2 discos fuera de línea ('failed' o 'rebuilding'), el Stripe global pierde ese segmento.
      const numSubgroups = N / 2;
      let deadSubgroups = [];
      let degradedSubgroups = [];

      for (let sg = 0; sg < numSubgroups; sg++) {
        const sgDisks = discos.filter((d) => d.subgroupIndex === sg);
        const sgUnavailable = sgDisks.filter((d) => d.status !== 'healthy');
        const sgLabel = `Subgrupo ${String.fromCharCode(65 + sg)}`;
        if (sgUnavailable.length === 2) {
          deadSubgroups.push(sgLabel);
        } else if (sgUnavailable.length === 1) {
          degradedSubgroups.push(sgLabel);
        }
      }

      if (deadSubgroups.length > 0) {
        isCriticalLoss = true;
        if (segundoFalloEnRebuild) {
          explanation = `¡Fallo Crítico en RAID 10 durante Rebuild! El disco hermano dentro del mismo ${deadSubgroups.join(', ')} sufrió una avería mientras se copiaba el espejo. Al perderse ambas mitades del mismo subgrupo y estar unidos en RAID 0, se pierde todo el volumen.`;
        } else {
          explanation = `Fallo Crítico en RAID 10: Han fallado AMBOS discos del ${deadSubgroups.join(', ')}. Como el nivel superior es un Stripe (RAID 0) sin paridad entre subgrupos, la caída completa de un par espejo destruye el volumen.`;
        }
      } else if (rebuildingDisks.length > 0) {
        if (failedDisks.length > 0) {
          explanation = `Reconstruyendo ${rebuildingDisks[0].id} desde su pareja espejo mientras otro subgrupo distinto (${degradedSubgroups.join(', ')}) opera en modo degradado. El volumen sobrevive porque ningún subgrupo perdió sus dos discos a la vez.`;
        } else {
          explanation = `Reconstruyendo ${rebuildingDisks[0].id} copiando directamente desde su disco hermano sano en el mismo subgrupo espejo (sin sobrecargar los demás subgrupos del arreglo).`;
        }
      } else if (failedDisks.length > 0) {
        explanation = `Volumen RAID 10 Degradado (${failedDisks.length} ${failedDisks.length === 1 ? 'disco averiado' : 'discos averiados'} en ${degradedSubgroups.join(', ')}). Como cada subgrupo conserva al menos 1 disco sano, el arreglo sigue funcionando sin pérdida de datos.`;
      } else {
        explanation = `Volumen RAID 10 Óptimo: ${numSubgroups} subgrupos espejo (RAID 1) combinados en Stripe (RAID 0). Resiste 1 fallo garantizado o hasta ${numSubgroups} fallos si ocurren en subgrupos diferentes.`;
      }
      break;
    }
  }

  let estado = 'OPTIMO';
  if (isCriticalLoss) estado = 'CRITICO';
  else if (rebuildingDisks.length > 0) estado = 'RECONSTRUYENDO';
  else if (failedDisks.length > 0) estado = 'DEGRADADO';
  return { estado, explicacion: explanation };
}
