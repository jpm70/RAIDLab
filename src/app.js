import { jsPDF } from 'jspdf';
import { select } from 'd3-selection';
import 'd3-transition';
import { arc, pie, area, line, curveMonotoneX } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import { interpolate } from 'd3-interpolate';
import './styles.css';
import {
  RAID_SPECS,
  FRACCION_LECTURA,
  IOPS_POR_DISCO,
  bloquesDelDisco,
  calcularCapacidad,
  evaluarVolumen,
  instantaneaIops,
  iopsNominales,
  normalizarNumeroDiscos,
  num,
  penalizacionEscritura,
  textoParaPdf,
} from './lib/raid.js';

// Las fórmulas y reglas de cada nivel están documentadas en src/lib/raid.js.
const d3 = { select, arc, pie, area, line, curveMonotoneX, scaleLinear, interpolate };
const OFFLINE_FILE = 'raidlab.html';
const SEGUNDOS_GRAFICO_IOPS = 28;

// Estado reactivo central del simulador
const state = {
  theme: 'hacker', // 'hacker' (Modo Oscuro Terminal) | 'blueprint' (Modo Claro Técnico)
  raidLevel: '5',
  diskCount: 4,
  diskSizeTB: 4,
  // Cada disco tiene: { id, index, status: 'healthy' | 'failed' | 'rebuilding', subgroupIndex, rebuildProgress }
  disks: [],
  // Estado calculado del arreglo: 'OPTIMO' | 'DEGRADADO' | 'RECONSTRUYENDO' | 'CRITICO'
  volumeStatus: 'OPTIMO',
  statusDetail: '',
  rebuildTimer: null,
  rebuildingDiskIndex: null,
  rebuildProgress: 0,
  rebuildCrashedBySecondFault: false,
  logs: [],
  // Historial temporal de muestras de IOPS para el gráfico lineal D3.js (máx 28 puntos)
  iopsHistory: [],
  iopsTickCounter: 0,
  // Estado del Modo Tutorial Guiado Paso a Paso
  tutorialActive: false,
  tutorialStepIndex: 0,
  // Sistema S.M.A.R.T. de Alertas de Pre-fallo por Tiempo de Funcionamiento (Power-On Hours)
  smartPrefailThresholdHours: 40000,
  smartCriticalFailureHours: 55000,
  smartAgingActive: false,
  smartAgingTimer: null,
};

// Referencias a elementos del DOM
const dom = {
  raidTabs: document.querySelectorAll('.raid-tab'),
  raidLevelTag: document.getElementById('raid-level-tag'),
  raidConstraintHint: document.getElementById('raid-constraint-hint'),
  inputDiskCount: document.getElementById('input-disk-count'),
  displayDiskCount: document.getElementById('display-disk-count'),
  btnDecDisks: document.getElementById('btn-dec-disks'),
  btnIncDisks: document.getElementById('btn-inc-disks'),
  diskMinLabel: document.getElementById('disk-min-label'),
  diskStepLabel: document.getElementById('disk-step-label'),
  diskMaxLabel: document.getElementById('disk-max-label'),
  diskValidationMsg: document.getElementById('disk-validation-msg'),
  inputDiskSize: document.getElementById('input-disk-size'),
  displayDiskSize: document.getElementById('display-disk-size'),
  sizePresetBtns: document.querySelectorAll('[data-size-preset]'),
  btnCreateArray: document.getElementById('btn-create-array'),

  // Banner de estado y rebuild
  volumeStatusBanner: document.getElementById('volume-status-banner'),
  statusBadgeText: document.getElementById('status-badge-text'),
  statusExplanation: document.getElementById('status-explanation'),
  btnReplaceDisk: document.getElementById('btn-replace-disk'),
  btnFailSecondDuringRebuild: document.getElementById('btn-fail-second-during-rebuild'),
  btnRestoreAll: document.getElementById('btn-restore-all'),
  rebuildPanel: document.getElementById('rebuild-panel'),
  rebuildTitle: document.getElementById('rebuild-title'),
  rebuildTargetInfo: document.getElementById('rebuild-target-info'),
  rebuildTbProgress: document.getElementById('rebuild-tb-progress'),
  rebuildPercent: document.getElementById('rebuild-percent'),
  rebuildProgressbar: document.getElementById('rebuild-progressbar'),
  rebuildBarFill: document.getElementById('rebuild-bar-fill'),
  rebuildTelemetryNote: document.getElementById('rebuild-telemetry-note'),

  // Rack, S.M.A.R.T. Pre-fallo y matriz de bloques
  rackSummaryRaid: document.getElementById('rack-summary-raid'),
  rackSummaryDisks: document.getElementById('rack-summary-disks'),
  rackSummaryPrefail: document.getElementById('rack-summary-prefail'),
  rackSummaryPrefailSep: document.getElementById('rack-summary-prefail-sep'),
  rackSummaryHealth: document.getElementById('rack-summary-health'),
  smartThresholdBadge: document.getElementById('smart-threshold-badge'),
  btnTriggerPrefail: document.getElementById('btn-trigger-prefail'),
  btnToggleSmartAging: document.getElementById('btn-toggle-smart-aging'),
  inputSmartThreshold: document.getElementById('input-smart-threshold'),
  displaySmartThreshold: document.getElementById('display-smart-threshold'),
  raid10TopologyNotice: document.getElementById('raid10-topology-notice'),
  serverRackGrid: document.getElementById('server-rack-grid'),
  stripeMatrixTable: document.getElementById('stripe-matrix-table'),
  parityMathCallout: document.getElementById('parity-math-callout'),

  // Estadísticas y Gráfico de Anillos D3.js
  d3DonutContainer: document.getElementById('d3-capacity-donut'),
  d3DonutCenterTitle: document.getElementById('d3-donut-center-title'),
  d3DonutCenterValue: document.getElementById('d3-donut-center-value'),
  d3DonutCenterSub: document.getElementById('d3-donut-center-sub'),
  d3DonutTooltip: document.getElementById('d3-donut-tooltip'),
  btnLegendUsable: document.getElementById('btn-legend-usable'),
  btnLegendRedundancy: document.getElementById('btn-legend-redundancy'),
  statEfficiencyLabel: document.getElementById('stat-efficiency-label'),
  barUsableSegment: document.getElementById('bar-usable-segment'),
  barParitySegment: document.getElementById('bar-parity-segment'),
  legendUsable: document.getElementById('legend-usable'),
  legendRedundancy: document.getElementById('legend-redundancy'),
  statRawCapacity: document.getElementById('stat-raw-capacity'),
  statRawSub: document.getElementById('stat-raw-sub'),
  statUsableCapacity: document.getElementById('stat-usable-capacity'),
  statUsableSub: document.getElementById('stat-usable-sub'),
  statRedundancyCapacity: document.getElementById('stat-redundancy-capacity'),
  statRedundancySub: document.getElementById('stat-redundancy-sub'),
  statFaultTolerance: document.getElementById('stat-fault-tolerance'),
  statFaultSub: document.getElementById('stat-fault-sub'),
  formulaRaidName: document.getElementById('formula-raid-name'),
  formulaExpression: document.getElementById('formula-expression'),
  formulaExplanation: document.getElementById('formula-explanation'),

  // Bitácora, Gráfico Lineal D3.js de IOPS, Exportación de Informes y utilidades
  d3IopsChartContainer: document.getElementById('d3-iops-line-chart'),
  iopsLiveBadge: document.getElementById('iops-live-badge'),
  iopsImpactNote: document.getElementById('iops-impact-note'),
  controllerEventLog: document.getElementById('controller-event-log'),
  btnClearLog: document.getElementById('btn-clear-log'),
  btnExportReport: document.getElementById('btn-export-report'),
  btnExportReportTop: document.getElementById('btn-export-report-top'),
  reportExportModal: document.getElementById('report-export-modal'),
  btnCloseReportModal: document.getElementById('btn-close-report-modal'),
  inputStudentName: document.getElementById('input-student-name'),
  inputStudentNotes: document.getElementById('input-student-notes'),
  reportPreviewText: document.getElementById('report-preview-text'),
  reportCopyFeedback: document.getElementById('report-copy-feedback'),
  btnCopyReportTxt: document.getElementById('btn-copy-report-txt'),
  btnDownloadReportTxt: document.getElementById('btn-download-report-txt'),
  btnDownloadReportPdf: document.getElementById('btn-download-report-pdf'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  scenarioBtns: document.querySelectorAll('[data-scenario]'),
  btnDownloadHtml: document.getElementById('btn-download-html'),

  // Elementos del Modo Tutorial Guiado
  btnStartTutorial: document.getElementById('btn-start-tutorial'),
  guidedTutorialPopover: document.getElementById('guided-tutorial-popover'),
  tutorialPopoverArrow: document.getElementById('tutorial-popover-arrow'),
  tutorialStepBadge: document.getElementById('tutorial-step-badge'),
  tutorialTargetTag: document.getElementById('tutorial-target-tag'),
  btnTutorialClose: document.getElementById('btn-tutorial-close'),
  tutorialProgressDots: document.getElementById('tutorial-progress-dots'),
  tutorialStepTitle: document.getElementById('tutorial-step-title'),
  tutorialStepBody: document.getElementById('tutorial-step-body'),
  tutorialFormulaLine: document.getElementById('tutorial-formula-line'),
  tutorialLiveFeedback: document.getElementById('tutorial-live-feedback'),
  tutorialActionWrapper: document.getElementById('tutorial-action-wrapper'),
  btnTutorialAction: document.getElementById('btn-tutorial-action'),
  btnTutorialPrev: document.getElementById('btn-tutorial-prev'),
  btnTutorialNext: document.getElementById('btn-tutorial-next'),
  tutorialHintFooter: document.getElementById('tutorial-hint-footer'),
};

/**
 * Devuelve la paleta cromática dinámica para los gráficos D3.js según el tema activo
 * ('hacker' oscuro vs 'blueprint' claro de alto contraste).
 */
function getD3ThemePalette() {
  if (state.theme === 'blueprint') {
    return {
      usableColor: '#059669',
      redundancyColor: '#0284c7',
      criticalPrimary: '#dc2626',
      criticalSecondary: '#fca5a5',
      degradedColor: '#d97706',
      rebuildColor: '#0284c7',
      trackFill: '#e2e8f0',
      trackStroke: '#94a3b8',
      sliceStroke: '#ffffff',
      gridLine: '#cbd5e1',
      axisText: '#475569',
      axisTextStrong: '#0f172a',
    };
  }
  return {
    usableColor: '#10b981',
    redundancyColor: '#0ea5e9',
    criticalPrimary: '#ef4444',
    criticalSecondary: '#7f1d1d',
    degradedColor: '#f59e0b',
    rebuildColor: '#38bdf8',
    trackFill: '#0f172a',
    trackStroke: '#1e293b',
    sliceStroke: '#0b0f17',
    gridLine: '#1e293b',
    axisText: '#64748b',
    axisTextStrong: '#94a3b8',
  };
}

/**
 * Alterna entre el tema 'Hacker/Terminal' (Oscuro) y 'Technical/Blueprint' (Claro)
 * y actualiza dinámicamente todos los gráficos D3.js.
 */
function applyTheme(themeName, logChange = false) {
  state.theme = themeName === 'blueprint' ? 'blueprint' : 'hacker';
  const root = document.documentElement;
  if (state.theme === 'blueprint') {
    root.classList.add('theme-blueprint');
    root.classList.remove('dark');
    if (dom.btnThemeToggle) {
      dom.btnThemeToggle.textContent = 'Tema: Technical / Blueprint';
      dom.btnThemeToggle.setAttribute('aria-pressed', 'true');
    }
  } else {
    root.classList.add('dark');
    root.classList.remove('theme-blueprint');
    if (dom.btnThemeToggle) {
      dom.btnThemeToggle.textContent = 'Tema: Hacker / Terminal';
      dom.btnThemeToggle.setAttribute('aria-pressed', 'false');
    }
  }

  try {
    localStorage.setItem('raidlab-theme', state.theme);
  } catch (_) {}

  // Redibujar y actualizar colores de ambos gráficos D3.js inmediatamente
  renderD3CapacityDonut(calculateCapacityMetrics());
  renderD3IopsLineChart();

  if (logChange) {
    addControllerLog(
      'ok',
      `Esquema visual cambiado a modo ${state.theme === 'blueprint' ? 'Technical / Blueprint (Alto Contraste Claro)' : 'Hacker / Terminal (Modo Oscuro)'}. Gráficos D3.js actualizados.`
    );
  }
}

/**
 * Registra un evento técnico con marca de tiempo en la bitácora del controlador RAID.
 */
function addControllerLog(level, message) {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  state.logs.unshift({ time: timeStr, level, message });
  if (state.logs.length > 30) {
    state.logs.pop();
  }
  renderEventLog();
}

function renderEventLog() {
  if (!dom.controllerEventLog) return;
  if (state.logs.length === 0) {
    dom.controllerEventLog.innerHTML =
      '<div class="text-slate-500 py-2">Sin eventos registrados en la sesión actual.</div>';
    return;
  }
  dom.controllerEventLog.innerHTML = state.logs
    .map((item) => {
      let colorClass = 'text-emerald-400';
      let prefix = '[OK]';
      if (item.level === 'warn') {
        colorClass = 'text-amber-300';
        prefix = '[WARN]';
      } else if (item.level === 'info') {
        colorClass = 'text-sky-300';
        prefix = '[REBUILD]';
      } else if (item.level === 'crit') {
        colorClass = 'text-red-400 font-semibold';
        prefix = '[CRIT]';
      }
      return `
        <div class="border-b border-slate-800/60 pb-1.5 leading-relaxed">
          <span class="text-slate-500">${item.time}</span>
          <span class="${colorClass} ml-1">${prefix}</span>
          <span class="text-slate-300 ml-1">${item.message}</span>
        </div>
      `;
    })
    .join('');
}

/**
 * Valida y ajusta el número de discos N según las reglas del nivel RAID seleccionado.
 */
function validateAndNormalizeDiskCount(raidLevel, requestedCount, showWarning = false) {
  const { discos, aviso } = normalizarNumeroDiscos(raidLevel, requestedCount);
  if (showWarning && aviso) {
    dom.diskValidationMsg.textContent = aviso;
    dom.diskValidationMsg.classList.remove('hidden');
  } else if (!aviso) {
    dom.diskValidationMsg.classList.add('hidden');
  }
  return discos;
}

/**
 * Detiene cualquier temporizador de reconstrucción (Rebuild) activo.
 */
function stopRebuildTimer() {
  if (state.rebuildTimer) {
    clearInterval(state.rebuildTimer);
    state.rebuildTimer = null;
  }
}

/**
 * Inicializa / recrea el arreglo físico de discos con los parámetros configurados.
 */
function createArray(customMessage) {
  stopRebuildTimer();
  state.rebuildingDiskIndex = null;
  state.rebuildProgress = 0;
  state.rebuildCrashedBySecondFault = false;

  state.diskCount = validateAndNormalizeDiskCount(state.raidLevel, state.diskCount, false);
  const spec = RAID_SPECS[state.raidLevel];

  // Sincronizar atributos del slider de número de discos
  dom.inputDiskCount.min = spec.minDisks;
  dom.inputDiskCount.max = spec.maxDisks;
  dom.inputDiskCount.step = spec.requireEven ? 2 : 1;
  dom.inputDiskCount.value = state.diskCount;
  dom.diskMinLabel.textContent = `Mín: ${spec.minDisks} discos`;
  dom.diskStepLabel.textContent = spec.requireEven ? 'Paso: 2 (Par)' : 'Paso: 1 disco';
  dom.diskMaxLabel.textContent = `Máx: ${spec.maxDisks} discos`;

  // Construir los objetos de disco para el bastidor virtual con telemetría S.M.A.R.T. (Power-On Hours)
  state.disks = Array.from({ length: state.diskCount }, (_, idx) => ({
    id: `BAY-${String(idx + 1).padStart(2, '0')}`,
    index: idx,
    status: 'healthy', // 'healthy' | 'failed' | 'rebuilding'
    subgroupIndex: state.raidLevel === '10' ? Math.floor(idx / 2) : null,
    // Tiempo de funcionamiento inicial escalonado (en horas de encendido POH)
    powerOnHours: Math.min(34500, 11500 + idx * 5200),
    reallocatedSectors: 0,
    prefailNotified: false,
    blocks: generateDiskBlocksPreview(state.raidLevel, idx, state.diskCount),
  }));

  evaluateSmartPrefailAlerts(false);
  recalculateArrayState();
  seedInitialIopsHistory();
  renderAll();

  const msg =
    customMessage ||
    `Arreglo ${spec.name} inicializado con ${state.diskCount} discos de ${state.diskSizeTB} TB (Capacidad útil: ${num(calculateCapacityMetrics().usableTB, 1)} TB).`;
  addControllerLog('ok', msg);
}

/**
 * ============================================================================
 * SISTEMA S.M.A.R.T. DE ALERTAS DE PRE-FALLO POR TIEMPO DE FUNCIONAMIENTO
 * ============================================================================
 * Analiza las horas de encendido (Power-On Hours - POH) de cada unidad física.
 * Si un disco operativo supera el umbral configurado (ej. 40,000 h), activa el
 * estado de alerta de Pre-fallo (icono naranja) advirtiendo de una avería inminente.
 */
function isDiskInPrefail(disk) {
  return (
    disk &&
    disk.status === 'healthy' &&
    disk.powerOnHours >= state.smartPrefailThresholdHours
  );
}

function evaluateSmartPrefailAlerts(allowAutoFailure = true) {
  state.disks.forEach((disk) => {
    if (disk.status !== 'healthy') return;

    // Si supera el límite crítico electromecánico durante la simulación de envejecimiento, el disco falla totalmente
    if (allowAutoFailure && disk.powerOnHours >= state.smartCriticalFailureHours) {
      addControllerLog(
        'crit',
        `¡Colapso electromecánico por desgaste extremo en ${disk.id} tras ${disk.powerOnHours.toLocaleString('es-ES')} h de uso! La unidad en alerta de Pre-fallo ha sufrido una avería total.`
      );
      toggleDiskFault(disk.index);
      return;
    }

    if (disk.powerOnHours >= state.smartPrefailThresholdHours) {
      if (disk.reallocatedSectors === 0) {
        disk.reallocatedSectors = 18 + (disk.index * 7) % 25;
      }
      if (!disk.prefailNotified) {
        disk.prefailNotified = true;
        addControllerLog(
          'warn',
          `Alerta S.M.A.R.T. de Pre-fallo en ${disk.id}: Tiempo de funcionamiento (${disk.powerOnHours.toLocaleString('es-ES')} h) superó el umbral de seguridad (${state.smartPrefailThresholdHours.toLocaleString('es-ES')} h). Sectores reasignados: ${disk.reallocatedSectors}. Se recomienda reemplazo preventivo inmediato.`
        );
      }
    } else {
      disk.prefailNotified = false;
      disk.reallocatedSectors = 0;
    }
  });
}

function triggerSimulatedPrefailOnDisk() {
  // Buscar un disco sano que aún no esté en pre-fallo
  let candidate = state.disks.find(
    (d) => d.status === 'healthy' && d.powerOnHours < state.smartPrefailThresholdHours
  );
  // Si todos los discos sanos ya están en pre-fallo, incrementar aún más las horas del primero para acercarlo al fallo total
  if (!candidate) {
    candidate = state.disks.find((d) => d.status === 'healthy');
  }
  if (!candidate) {
    addControllerLog(
      'warn',
      'No hay unidades operativas disponibles para simular desgaste S.M.A.R.T.'
    );
    return;
  }

  if (candidate.powerOnHours < state.smartPrefailThresholdHours) {
    candidate.powerOnHours = state.smartPrefailThresholdHours + 2400;
    candidate.reallocatedSectors = 24 + candidate.index * 5;
    evaluateSmartPrefailAlerts(false);
  } else {
    candidate.powerOnHours = Math.min(
      state.smartCriticalFailureHours,
      candidate.powerOnHours + 5500
    );
    candidate.reallocatedSectors += 19;
    evaluateSmartPrefailAlerts(true);
  }
  renderAll();
}

function replacePrefailDiskPreventively(diskIndex) {
  const disk = state.disks[diskIndex];
  if (!disk || disk.status !== 'healthy') return;

  // Si el arreglo permite rebuild y no está en fallo crítico ni reconstruyendo otra unidad, iniciar rebuild preventivo con unidad nueva (0 h)
  disk.powerOnHours = 0;
  disk.reallocatedSectors = 0;
  disk.prefailNotified = false;

  if (
    state.raidLevel !== '0' &&
    state.volumeStatus !== 'CRITICO' &&
    state.volumeStatus !== 'RECONSTRUYENDO'
  ) {
    disk.status = 'failed';
    addControllerLog(
      'info',
      `Mantenimiento preventivo S.M.A.R.T.: Unidad envejecida en ${disk.id} extraída en caliente e insertado disco nuevo (0 h). Iniciando sincronización...`
    );
    startRebuildSimulation();
  } else {
    addControllerLog(
      'ok',
      state.raidLevel === '0'
        ? `Unidad en ${disk.id} clonada a un disco nuevo (0 h) y sustituida en frío: en RAID 0 no hay redundancia, así que retirarla sin clonarla destruiría el volumen.`
        : `Unidad en ${disk.id} sustituida preventivamente por un disco nuevo (0 h de uso, S.M.A.R.T. óptimo).`
    );
    renderAll();
  }
}

function stopSmartAgingTimer() {
  if (state.smartAgingTimer) {
    clearInterval(state.smartAgingTimer);
    state.smartAgingTimer = null;
  }
  state.smartAgingActive = false;
  if (dom.btnToggleSmartAging) {
    dom.btnToggleSmartAging.textContent = '⏱️ Auto-Desgaste: OFF';
    dom.btnToggleSmartAging.setAttribute('aria-pressed', 'false');
    dom.btnToggleSmartAging.classList.remove('btn-prefail-orange');
    dom.btnToggleSmartAging.classList.add('btn-neutral');
  }
}

function toggleSmartAutoAging() {
  if (state.smartAgingActive) {
    stopSmartAgingTimer();
    addControllerLog('info', 'Simulación de envejecimiento continuo S.M.A.R.T. pausada.');
    return;
  }

  state.smartAgingActive = true;
  if (dom.btnToggleSmartAging) {
    dom.btnToggleSmartAging.textContent = '⏱️ Auto-Desgaste: ON (+h/s)';
    dom.btnToggleSmartAging.setAttribute('aria-pressed', 'true');
    dom.btnToggleSmartAging.classList.remove('btn-neutral');
    dom.btnToggleSmartAging.classList.add('btn-prefail-orange');
  }
  addControllerLog(
    'info',
    `Simulación de tiempo de funcionamiento S.M.A.R.T. activada (Umbral de Pre-fallo: ${state.smartPrefailThresholdHours.toLocaleString('es-ES')} h).`
  );

  state.smartAgingTimer = setInterval(() => {
    const isRebuilding = state.volumeStatus === 'RECONSTRUYENDO';
    state.disks.forEach((d) => {
      if (d.status === 'healthy') {
        // Durante un Rebuild el estrés mecánico/térmico de lectura continua envejece más rápido las unidades sobrevivientes
        const increment = isRebuilding ? 2600 : 1400;
        d.powerOnHours += increment + Math.round(Math.random() * 400);
        if (d.powerOnHours >= state.smartPrefailThresholdHours) {
          d.reallocatedSectors += Math.round(2 + Math.random() * 6);
        }
      }
    });
    evaluateSmartPrefailAlerts(true);
    renderAll();
  }, 1200);
}

function generateDiskBlocksPreview(raidLevel, diskIdx, totalDisks) {
  return bloquesDelDisco(raidLevel, diskIdx, totalDisks);
}

function calculateCapacityMetrics() {
  return calcularCapacidad(state.raidLevel, state.diskCount, state.diskSizeTB);
}

/**
 * Recalcula el estado del volumen (OPTIMO, DEGRADADO, RECONSTRUYENDO o CRITICO).
 * Si se pierde el volumen durante un rebuild, el rebuild se aborta.
 */
function recalculateArrayState() {
  const { estado, explicacion } = evaluarVolumen(state.raidLevel, state.disks, {
    segundoFalloEnRebuild: state.rebuildCrashedBySecondFault,
  });
  if (estado === 'CRITICO') stopRebuildTimer();
  state.volumeStatus = estado;
  state.statusDetail = explicacion;
}

/**
 * Alterna el estado de un disco al hacer clic sobre él en el bastidor virtual.
 */
function toggleDiskFault(diskIndex) {
  const disk = state.disks[diskIndex];
  if (!disk) return;

  // Si el disco está sano, provocamos una avería física
  if (disk.status === 'healthy') {
    const wasRebuilding = state.volumeStatus === 'RECONSTRUYENDO';
    disk.status = 'failed';

    if (wasRebuilding) {
      // Evaluamos qué pasa al inyectar este segundo fallo en pleno rebuild
      state.rebuildCrashedBySecondFault = true;
      recalculateArrayState();

      if (state.volumeStatus === 'CRITICO') {
        addControllerLog(
          'crit',
          `¡Segundo fallo inyectado en ${disk.id} durante Rebuild! Tolerancia superada: reconstrucción abortada y pérdida crítica de datos.`
        );
      } else {
        state.rebuildCrashedBySecondFault = false;
        addControllerLog(
          'warn',
          `Fallo adicional en ${disk.id} durante el Rebuild. La redundancia de ${RAID_SPECS[state.raidLevel].name} absorbió el impacto y la reconstrucción continúa.`
        );
      }
    } else {
      recalculateArrayState();
      if (state.volumeStatus === 'CRITICO') {
        addControllerLog(
          'crit',
          `Avería física en ${disk.id}. Se ha superado la tolerancia a fallos de ${RAID_SPECS[state.raidLevel].name}: PÉRDIDA DE DATOS.`
        );
      } else {
        addControllerLog(
          'warn',
          `Avería física detectada en ${disk.id}. El volumen pasa a estado DEGRADADO operando mediante redundancia.`
        );
      }
    }
  } else if (disk.status === 'failed') {
    // Un disco averiado no vuelve solo: se sustituye por uno nuevo y se reconstruye.
    if (state.volumeStatus === 'CRITICO') {
      addControllerLog(
        'crit',
        `Sustituir ${disk.id} ya no sirve: el volumen se perdió y no queda redundancia de la que reconstruir. Restaura el arreglo (en la vida real, desde la copia de seguridad).`
      );
    } else if (state.volumeStatus === 'RECONSTRUYENDO') {
      addControllerLog(
        'warn',
        `${disk.id} se sustituirá cuando termine la reconstrucción en curso: el controlador reconstruye una unidad cada vez.`
      );
    } else {
      startRebuildSimulation(disk.index);
      return;
    }
  }

  renderAll();
}

/**
 * Inicia la simulación visual de Reconstrucción (Rebuild) sobre el primer disco averiado disponible.
 */
function startRebuildSimulation(diskIndex = null) {
  // No se puede reconstruir un volumen que ya sufrió pérdida crítica de datos
  if (state.volumeStatus === 'CRITICO' || state.volumeStatus === 'RECONSTRUYENDO') return;

  const targetDisk =
    diskIndex !== null && state.disks[diskIndex]?.status === 'failed'
      ? state.disks[diskIndex]
      : state.disks.find((d) => d.status === 'failed');
  if (!targetDisk) return;

  stopRebuildTimer();
  targetDisk.status = 'rebuilding';
  // Al insertar un disco de reemplazo nuevo, su contador S.M.A.R.T. de horas se reinicia a 0 h
  targetDisk.powerOnHours = 0;
  targetDisk.reallocatedSectors = 0;
  targetDisk.prefailNotified = false;
  state.rebuildingDiskIndex = targetDisk.index;
  state.rebuildProgress = 0;
  state.rebuildCrashedBySecondFault = false;

  recalculateArrayState();
  addControllerLog(
    'info',
    `Disco nuevo (0 h S.M.A.R.T.) insertado en ${targetDisk.id}. Iniciando reconstrucción de ${state.diskSizeTB} TB bloque a bloque...`
  );
  renderAll();

  // Intervalo de reconstrucción progresiva (~7.5 segundos de duración total para dar tiempo a probar un 2.º fallo)
  state.rebuildTimer = setInterval(() => {
    state.rebuildProgress += 2;

    if (state.rebuildProgress >= 100) {
      state.rebuildProgress = 100;
      stopRebuildTimer();
      targetDisk.status = 'healthy';
      state.rebuildingDiskIndex = null;
      recalculateArrayState();
      addControllerLog(
        'ok',
        `Reconstrucción (Rebuild) completada al 100% en ${targetDisk.id}. Paridad/espejo verificado.`
      );
      renderAll();
    } else {
      renderRebuildProgressOnly();
    }
  }, 150);
}

/**
 * Provoca un fallo automático en un disco sano aleatorio mientras corre el Rebuild
 * para demostrar de forma inmediata qué sucede ante un segundo fallo concurrente.
 */
function triggerSecondFaultDuringRebuild() {
  if (state.volumeStatus !== 'RECONSTRUYENDO') return;

  // Buscar un disco sano; en RAID 10 priorizar el disco hermano del mismo subgrupo para demostrar el caso catastrófico
  let candidate = null;
  if (state.raidLevel === '10' && state.rebuildingDiskIndex !== null) {
    const rebuildingDisk = state.disks[state.rebuildingDiskIndex];
    candidate = state.disks.find(
      (d) => d.status === 'healthy' && d.subgroupIndex === rebuildingDisk.subgroupIndex
    );
  }
  if (!candidate) {
    candidate = state.disks.find((d) => d.status === 'healthy');
  }
  if (candidate) {
    toggleDiskFault(candidate.index);
  }
}

/**
 * Actualiza únicamente la barra de progreso de Rebuild en cada tick de 150ms.
 */
function renderRebuildProgressOnly() {
  const rebDisk =
    state.rebuildingDiskIndex !== null ? state.disks[state.rebuildingDiskIndex] : null;
  if (!rebDisk) return;

  const pct = Math.min(100, Math.max(0, state.rebuildProgress));
  const currentTB = num((pct / 100) * state.diskSizeTB, 2);
  dom.rebuildTargetInfo.textContent = `${rebDisk.id} (${state.diskSizeTB} TB)`;
  dom.rebuildTbProgress.textContent = `${currentTB} / ${num(state.diskSizeTB, 2)} TB`;
  dom.rebuildPercent.textContent = `${pct}%`;
  dom.rebuildProgressbar.setAttribute('aria-valuenow', String(pct));
  dom.rebuildBarFill.style.transform = `scaleX(${pct / 100})`;

  const cardBar = document.getElementById(`disk-mini-rebuild-${rebDisk.index}`);
  const cardPct = document.getElementById(`disk-mini-pct-${rebDisk.index}`);
  if (cardBar) cardBar.style.transform = `scaleX(${pct / 100})`;
  if (cardPct) cardPct.textContent = `${pct}%`;

  refreshLatestIopsSample();
  renderD3IopsLineChart();
}

/**
 * Renderiza el banner de estado del volumen y controles de reconstrucción.
 */
function renderStatusBanner() {
  const failedCount = state.disks.filter((d) => d.status === 'failed').length;
  const isRebuilding = state.volumeStatus === 'RECONSTRUYENDO';
  const isCritical = state.volumeStatus === 'CRITICO';

  dom.volumeStatusBanner.className = 'state-banner';
  if (state.volumeStatus === 'OPTIMO') {
    dom.volumeStatusBanner.classList.add('optimo');
    dom.statusBadgeText.className = 'font-mono-tabular text-sm font-semibold text-emerald-400';
    dom.statusBadgeText.textContent = '● ÓPTIMO (OPERACIÓN NOMINAL)';
  } else if (state.volumeStatus === 'DEGRADADO') {
    dom.volumeStatusBanner.classList.add('degradado');
    dom.statusBadgeText.className = 'font-mono-tabular text-sm font-semibold text-amber-400';
    dom.statusBadgeText.textContent = '▲ DEGRADADO (REDUNDANCIA ACTIVA)';
  } else if (state.volumeStatus === 'RECONSTRUYENDO') {
    dom.volumeStatusBanner.classList.add('reconstruyendo');
    dom.statusBadgeText.className = 'font-mono-tabular text-sm font-semibold text-sky-400';
    dom.statusBadgeText.textContent = '↻ RECONSTRUYENDO (REBUILD EN CURSO)';
  } else {
    dom.volumeStatusBanner.classList.add('critico');
    dom.statusBadgeText.className = 'font-mono-tabular text-sm font-semibold text-red-400';
    dom.statusBadgeText.textContent = '✕ FALLO CRÍTICO (PÉRDIDA DE DATOS)';
  }

  dom.statusExplanation.textContent = state.statusDetail;

  // Habilitar "Reemplazar disco averiado" solo si hay al menos 1 disco averiado y el volumen NO está en Fallo Crítico ni en Rebuild
  dom.btnReplaceDisk.disabled = !(failedCount > 0 && !isCritical && !isRebuilding);

  // Mostrar botón rápido para provocar 2.º fallo durante el rebuild
  if (isRebuilding) {
    dom.btnFailSecondDuringRebuild.classList.remove('hidden');
  } else {
    dom.btnFailSecondDuringRebuild.classList.add('hidden');
  }

  // Panel de barra de progreso de Rebuild
  if (isRebuilding || state.rebuildCrashedBySecondFault) {
    dom.rebuildPanel.classList.remove('hidden');
    const rebDisk =
      state.rebuildingDiskIndex !== null ? state.disks[state.rebuildingDiskIndex] : null;
    const pct = state.rebuildProgress;
    const currentTB = num((pct / 100) * state.diskSizeTB, 2);

    dom.rebuildTargetInfo.textContent = rebDisk
      ? `${rebDisk.id} (${state.diskSizeTB} TB)`
      : 'ABORTADO';
    dom.rebuildTbProgress.textContent = `${currentTB} / ${num(state.diskSizeTB, 2)} TB`;
    dom.rebuildPercent.textContent = `${pct}%`;
    dom.rebuildBarFill.style.transform = `scaleX(${pct / 100})`;

    if (state.rebuildCrashedBySecondFault && isCritical) {
      dom.rebuildTitle.textContent = '✕ REBUILD ABORTADO POR SEGUNDO FALLO CONCURRENTE';
      dom.rebuildTitle.className = 'text-red-400 font-semibold';
      dom.rebuildBarFill.classList.add('rebuild-aborted');
      dom.rebuildTelemetryNote.textContent =
        'La pérdida de una unidad crítica adicional durante la lectura de reconstrucción impide resolver los bloques faltantes.';
      document.getElementById('rebuild-tip')?.classList.add('hidden');
    } else {
      dom.rebuildTitle.textContent = '↻ RECONSTRUYENDO UNIDAD DE REEMPLAZO';
      dom.rebuildTitle.className = 'text-sky-300 font-semibold';
      dom.rebuildBarFill.classList.remove('rebuild-aborted');
      dom.rebuildTelemetryNote.textContent =
        'Leyendo sectores de las unidades sobrevivientes para recalcular bloques y escribirlos en el disco nuevo.';
      document.getElementById('rebuild-tip')?.classList.remove('hidden');
    }
  } else {
    dom.rebuildPanel.classList.add('hidden');
  }
}

/**
 * Genera el marcado HTML de una tarjeta de disco individual dentro del bastidor,
 * incluyendo el icono naranja de Alerta de Pre-fallo S.M.A.R.T. cuando supera el umbral de horas.
 */
function buildDiskBayHTML(disk) {
  const isCritical = state.volumeStatus === 'CRITICO';
  const isArrayRebuilding = state.volumeStatus === 'RECONSTRUYENDO';
  const isPrefail = isDiskInPrefail(disk);

  let stateClass = 'disk-healthy';
  let statusIconHTML = `<span class="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1"></span>`;
  let statusIconAndLabel = 'OPERATIVO';
  let statusTextColor = 'text-emerald-400';
  let actionPrompt = isArrayRebuilding
    ? 'Clic para provocar 2.º fallo en Rebuild'
    : 'Clic para simular avería física';
  let ioLoadText = isArrayRebuilding
    ? 'Lectura intensiva Rebuild (100%)'
    : 'I/O Nominal (Lectura/Escritura)';

  if (disk.status === 'failed') {
    stateClass = 'disk-failed';
    statusIconHTML = `<span class="text-red-400 font-bold mr-1">✕</span>`;
    statusIconAndLabel = 'AVERIADO (OFFLINE)';
    statusTextColor = 'text-red-400';
    actionPrompt = isCritical
      ? 'Volumen perdido: usa «Restaurar arreglo»'
      : isArrayRebuilding
        ? 'Se sustituirá tras el rebuild en curso'
        : 'Clic para sustituirlo y reconstruir';
    ioLoadText = 'Sin señal de motor / Fallo total S.M.A.R.T.';
  } else if (disk.status === 'rebuilding') {
    stateClass = isCritical ? 'disk-unrecoverable' : 'disk-rebuilding';
    statusIconHTML = `<span class="${isCritical ? 'text-red-400' : 'text-sky-300'} font-bold mr-1">${isCritical ? '✕' : '↻'}</span>`;
    statusIconAndLabel = isCritical ? 'REBUILD INTERRUMPIDO' : 'RECONSTRUYENDO';
    statusTextColor = isCritical ? 'text-red-400' : 'text-sky-300';
    actionPrompt = isCritical
      ? 'Sincronización abortada por pérdida de paridad'
      : 'Escribiendo bloques reconstruidos...';
    ioLoadText = isCritical
      ? 'Volumen irrecuperable'
      : `Escritura secuencial (${state.rebuildProgress}%)`;
  } else if (isCritical) {
    stateClass = 'disk-unrecoverable';
    statusIconHTML = `<span class="text-amber-300 font-bold mr-1">!</span>`;
    statusIconAndLabel = 'VOLUMEN CORRUPTO';
    statusTextColor = 'text-amber-300';
    actionPrompt = 'Datos incompletos por caída del arreglo';
    ioLoadText = 'Volumen desmontado por seguridad';
  } else if (isPrefail) {
    // Estado de Alerta de Pre-fallo: el icono cambia a color naranja para advertir avería inminente
    stateClass = 'disk-prefail';
    statusIconHTML = `
      <svg class="w-4 h-4 inline-block mr-1 -mt-0.5 prefail-status-icon shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
      </svg>
    `;
    statusIconAndLabel = 'PRE-FALLO S.M.A.R.T.';
    statusTextColor = 'text-orange-400';
    actionPrompt = '¡Avería inminente! Haz clic para fallo total o reemplaza';
    ioLoadText = `Sectores reasignados (atr. 5): ${disk.reallocatedSectors}`;
  }

  const blocksHTML = disk.blocks
    .map((b) => {
      let chipClass = 'block-data';
      if (disk.status === 'failed') {
        chipClass = 'block-dead';
      } else if (b.type === 'mirror') {
        chipClass = 'block-mirror';
      } else if (b.type === 'parity-p') {
        chipClass = 'block-parity-p';
      } else if (b.type === 'parity-q') {
        chipClass = 'block-parity-q';
      }
      return `<div class="block-chip ${chipClass}" title="Stripe ${b.stripe}: ${b.label}">${b.label}</div>`;
    })
    .join('');

  // Cálculo visual del desgaste de horas de funcionamiento (Power-On Hours) respecto al umbral
  const pohRatioPct = Math.min(
    100,
    Math.round((disk.powerOnHours / state.smartPrefailThresholdHours) * 100)
  );
  const pohBarColor =
    disk.status === 'failed'
      ? 'bg-red-500'
      : isPrefail
        ? 'bg-orange-500'
        : pohRatioPct >= 75
          ? 'bg-amber-400'
          : 'bg-emerald-500';
  const pohTextColor =
    disk.status === 'failed'
      ? 'text-red-400'
      : isPrefail
        ? 'text-orange-400 font-semibold'
        : 'text-slate-400';

  const preventiveReplaceBtnHTML = isPrefail
    ? `
      <button
        type="button"
        data-preventive-replace="${disk.index}"
        class="btn-action btn-prefail-orange w-full text-[11px] py-1 px-2 min-h-0 h-7 mt-1.5 font-mono-tabular"
        title="Sustituir preventivamente esta unidad en pre-fallo por un disco nuevo (0 h) antes de que se averíe"
      >
        🔄 Reemplazo Preventivo (0 h)
      </button>
    `
    : '';

  const rebuildMiniBar =
    disk.status === 'rebuilding'
      ? `
      <div class="mt-2 space-y-1">
        <div class="flex justify-between text-xs font-mono-tabular text-sky-300">
          <span>Sync</span>
          <span id="disk-mini-pct-${disk.index}">${state.rebuildProgress}%</span>
        </div>
        <div class="rebuild-track h-2">
          <div id="disk-mini-rebuild-${disk.index}" class="rebuild-fill ${isCritical ? 'rebuild-aborted' : ''}" style="transform: scaleX(${state.rebuildProgress / 100})"></div>
        </div>
      </div>
    `
      : '';

  return `
    <div
      class="disk-bay ${stateClass}"
      role="button"
      tabindex="0"
      data-disk-index="${disk.index}"
      aria-label="Bahía ${disk.id}, ${state.diskSizeTB} TB, estado ${statusIconAndLabel}, uso ${disk.powerOnHours} horas. ${actionPrompt}"
    >
      <div class="space-y-2">
        <!-- Cabecera de la bahía -->
        <div class="flex items-center justify-between gap-2 border-b border-slate-800/90 pb-2">
          <span class="font-mono-tabular text-xs font-semibold text-slate-200">${disk.id}</span>
          <span class="font-mono-tabular text-xs text-slate-400">${state.diskSizeTB} TB NVMe/SAS</span>
        </div>

        <!-- Estado semántico explícito (Icono naranja en pre-fallo + Texto) -->
        <div class="flex items-center justify-between gap-1">
          <span class="font-mono-tabular text-xs font-semibold flex items-center ${statusTextColor}">
            ${statusIconHTML}<span>${statusIconAndLabel}</span>
          </span>
          ${
            isPrefail
              ? '<span class="font-mono-tabular text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/40">ALERTA</span>'
              : ''
          }
        </div>

        <!-- Medidor S.M.A.R.T. de Tiempo de Funcionamiento (Power-On Hours) -->
        <div class="space-y-1 pt-0.5">
          <div class="flex items-center justify-between text-[11px] font-mono-tabular">
            <span class="text-slate-400">Horas encendido (atr. 9):</span>
            <span class="${pohTextColor}">${disk.powerOnHours.toLocaleString('es-ES')} h (${pohRatioPct}%)</span>
          </div>
          <div class="w-full h-1.5 bg-slate-900/90 border border-slate-800 rounded-full overflow-hidden">
            <div class="h-full ${pohBarColor} transition-all duration-200" style="width: ${pohRatioPct}%"></div>
          </div>
        </div>

        <!-- Bloques de datos/paridad alojados en este disco -->
        <div class="grid grid-cols-2 gap-1.5 pt-1">
          ${blocksHTML}
        </div>

        ${preventiveReplaceBtnHTML}
        ${rebuildMiniBar}
      </div>

      <!-- Pie de telemetría de la bahía -->
      <div class="pt-2.5 mt-2.5 border-t border-slate-800/80 space-y-1">
        <div class="text-xs font-mono-tabular ${isPrefail ? 'text-orange-300' : 'text-slate-400'} truncate">${ioLoadText}</div>
        <div class="text-xs text-slate-300 font-medium">${actionPrompt}</div>
      </div>
    </div>
  `;
}

/**
 * Renderiza el bastidor de discos físicos (con agrupación especial de Subgrupos Espejo cuando es RAID 10).
 */
function renderServerRack() {
  const failedCount = state.disks.filter((d) => d.status === 'failed').length;
  const prefailCount = state.disks.filter((d) => isDiskInPrefail(d)).length;

  dom.rackSummaryRaid.textContent = RAID_SPECS[state.raidLevel].name;
  dom.rackSummaryDisks.textContent = `${state.diskCount} Bahías (${state.diskCount * state.diskSizeTB} TB Brutos)`;

  if (dom.rackSummaryPrefail && dom.rackSummaryPrefailSep) {
    if (prefailCount > 0) {
      dom.rackSummaryPrefail.textContent = `⚠️ ${prefailCount} en Pre-fallo`;
      dom.rackSummaryPrefail.classList.remove('hidden');
      dom.rackSummaryPrefailSep.classList.remove('hidden');
    } else {
      dom.rackSummaryPrefail.classList.add('hidden');
      dom.rackSummaryPrefailSep.classList.add('hidden');
    }
  }

  if (dom.smartThresholdBadge) {
    dom.smartThresholdBadge.textContent = `Umbral de advertencia: ${state.smartPrefailThresholdHours.toLocaleString('es-ES')} h (Colapso crítico: ${state.smartCriticalFailureHours.toLocaleString('es-ES')} h)`;
  }

  dom.rackSummaryHealth.textContent =
    failedCount === 0
      ? '0 Averías'
      : `${failedCount} ${failedCount === 1 ? 'Disco Averiado' : 'Discos Averiados'}`;
  dom.rackSummaryHealth.className =
    failedCount === 0 ? 'text-emerald-400' : 'text-red-400 font-semibold';

  if (state.raidLevel === '10') {
    dom.raid10TopologyNotice.classList.remove('hidden');
    // Renderizar agrupado por Subgrupos Espejo (Pares RAID 1)
    const numSubgroups = state.diskCount / 2;
    let subgroupsHTML = '';

    for (let sg = 0; sg < numSubgroups; sg++) {
      const sgDisks = state.disks.filter((d) => d.subgroupIndex === sg);
      const unavailableInSg = sgDisks.filter((d) => d.status !== 'healthy').length;
      const sgLetter = String.fromCharCode(65 + sg);

      let sgContainerClass = 'subgroup-container';
      let sgStatusLabel = '● Espejo Íntegro (2/2 sanos)';
      let sgStatusColor = 'text-emerald-400';

      if (unavailableInSg === 1) {
        sgContainerClass = 'subgroup-container subgroup-degraded';
        sgStatusLabel = '▲ Subgrupo Degradado (1/2 sano)';
        sgStatusColor = 'text-amber-300';
      } else if (unavailableInSg >= 2) {
        sgContainerClass = 'subgroup-container subgroup-failed';
        sgStatusLabel = '✕ Subgrupo Colapsado (0/2 sanos)';
        sgStatusColor = 'text-red-400 font-semibold';
      }

      subgroupsHTML += `
        <div class="${sgContainerClass} sm:col-span-2 space-y-2.5">
          <div class="flex items-center justify-between text-xs font-mono-tabular px-1">
            <span class="font-semibold text-slate-200">Subgrupo Espejo ${sgLetter} (RAID 1)</span>
            <span class="${sgStatusColor}">${sgStatusLabel}</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${sgDisks.map((d) => buildDiskBayHTML(d)).join('')}
          </div>
        </div>
      `;
    }

    dom.serverRackGrid.innerHTML = subgroupsHTML;
  } else {
    dom.raid10TopologyNotice.classList.add('hidden');
    dom.serverRackGrid.innerHTML = state.disks.map((d) => buildDiskBayHTML(d)).join('');
  }

  // Conectar botones de reemplazo preventivo S.M.A.R.T. sin propagar el clic a la bahía
  const prevButtons = dom.serverRackGrid.querySelectorAll('[data-preventive-replace]');
  prevButtons.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-preventive-replace'), 10);
      replacePrefailDiskPreventively(idx);
    });
  });

  // Conectar manejadores de clic y teclado (Enter / Espacio) en cada bahía de disco
  const bayElements = dom.serverRackGrid.querySelectorAll('[data-disk-index]');
  bayElements.forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-disk-index'), 10);
      toggleDiskFault(idx);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        const idx = parseInt(el.getAttribute('data-disk-index'), 10);
        toggleDiskFault(idx);
      }
    });
  });
}

/**
 * Renderiza la matriz de distribución de Stripes y la explicación matemática de recuperación de bloques.
 */
function renderStripeMatrix() {
  const stripes = [0, 1, 2, 3];
  const headerCells = state.disks
    .map((d) => {
      const stateTag =
        d.status === 'healthy'
          ? '<span class="text-emerald-400">● OK</span>'
          : d.status === 'rebuilding'
            ? '<span class="text-sky-300">↻ SYNC</span>'
            : '<span class="text-red-400">✕ FAIL</span>';
      return `<th class="py-2 px-2.5 border-b border-slate-800">${d.id} ${stateTag}</th>`;
    })
    .join('');

  const bodyRows = stripes
    .map((s) => {
      const cells = state.disks
        .map((d) => {
          const block = d.blocks[s];
          let styleClass = 'text-emerald-300';
          if (d.status === 'failed') {
            styleClass = 'text-red-400 line-through';
          } else if (block.type === 'mirror') {
            styleClass = 'text-sky-300';
          } else if (block.type === 'parity-p') {
            styleClass = 'text-amber-300 font-semibold';
          } else if (block.type === 'parity-q') {
            styleClass = 'text-purple-300 font-semibold';
          }
          return `<td class="py-2 px-2.5 border-b border-slate-800/60 ${styleClass}">${block.label}</td>`;
        })
        .join('');

      return `
        <tr class="hover:bg-slate-900/40">
          <td class="py-2 px-2.5 border-b border-slate-800/60 text-slate-400 font-semibold">Stripe ${s}</td>
          ${cells}
        </tr>
      `;
    })
    .join('');

  dom.stripeMatrixTable.innerHTML = `
    <thead>
      <tr class="text-slate-400">
        <th class="py-2 px-2.5 border-b border-slate-800">Fila / Unidad</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  `;

  // Explicación algebraica contextual en la parte inferior de la matriz
  const unavailable = state.disks.filter((d) => d.status !== 'healthy');
  if (state.volumeStatus === 'CRITICO') {
    dom.parityMathCallout.innerHTML = `
      <div class="text-red-400 font-semibold">✕ Ecuación de Reconstrucción Indeterminada (Pérdida de Datos):</div>
      <p class="text-slate-300">
        Con las unidades <span class="font-mono-tabular text-red-300">${unavailable.map((d) => d.id).join(', ')}</span> fuera de línea, faltan demasiados bloques por fila (Stripe) para despejar las incógnitas mediante el nivel ${RAID_SPECS[state.raidLevel].name}.
      </p>
    `;
  } else if (unavailable.length > 0) {
    dom.parityMathCallout.innerHTML = `
      <div class="text-amber-300 font-semibold">▲ Reconstrucción Matemática al Vuelo Activa (${unavailable.map((d) => d.id).join(', ')}):</div>
      <p class="text-slate-300">
        ${
          state.raidLevel === '5'
            ? 'Cada bloque tachado se despeja en tiempo real aplicando XOR a los bloques restantes de su misma fila: <span class="font-mono-tabular text-emerald-300">D_faltante = D_sanos ⊕ P_s</span>.'
            : state.raidLevel === '6'
              ? 'Los bloques faltantes se despejan resolviendo el sistema lineal formado por el síndrome XOR (<span class="font-mono-tabular text-amber-300">P</span>) y el polinomio Reed-Solomon en Campos de Galois (<span class="font-mono-tabular text-purple-300">Q</span>).'
              : 'Las lecturas destinadas a la unidad caída son redirigidas transparentemente hacia su réplica espejo (<span class="font-mono-tabular text-sky-300">Esp</span>) sin cálculo de paridad.'
        }
      </p>
    `;
  } else {
    dom.parityMathCallout.innerHTML = `
      <div class="text-emerald-400 font-semibold">● Verificación de Consistencia de Stripes Nominal:</div>
      <p class="text-slate-300">
        Todos los bloques de datos y síndromes de redundancia se encuentran sincronizados. Haz clic sobre cualquier unidad del bastidor superior para observar cómo se degrada o reconstruye cada Stripe.
      </p>
    `;
  }
}

/**
 * Renderiza el panel de estadísticas, barra de capacidad y fórmulas matemáticas en tiempo real.
 */
function renderStatisticsPanel() {
  const metrics = calculateCapacityMetrics();
  const spec = RAID_SPECS[state.raidLevel];

  // Actualizar pestañas activas de RAID
  dom.raidTabs.forEach((btn) => {
    const isSelected = btn.getAttribute('data-raid') === state.raidLevel;
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-checked', String(isSelected));
  });

  dom.raidLevelTag.textContent = spec.tag;
  dom.raidConstraintHint.textContent = spec.constraintText;
  dom.displayDiskCount.textContent = `${state.diskCount} discos`;
  dom.displayDiskSize.textContent = `${state.diskSizeTB} TB / unidad`;

  // Leyendas de capacidad útil vs redundancia
  dom.statEfficiencyLabel.textContent = `Eficiencia: ${num(metrics.efficiencyPct, 1)}%`;
  dom.barUsableSegment.style.width = `${metrics.efficiencyPct}%`;
  dom.barParitySegment.style.width = `${metrics.redundancyPct}%`;

  dom.legendUsable.textContent = `${num(metrics.usableTB, 1)} TB (${num(metrics.efficiencyPct, 0)}%)`;
  dom.legendRedundancy.textContent = `${num(metrics.redundancyTB, 1)} TB (${num(metrics.redundancyPct, 0)}%)`;

  // Actualizar el Gráfico de Anillos D3.js en tiempo real
  renderD3CapacityDonut(metrics);

  // Tarjetas numéricas
  dom.statRawCapacity.textContent = `${num(metrics.rawTB, 1)} TB`;
  dom.statRawSub.textContent = `${metrics.N} discos × ${metrics.S} TB`;

  if (state.volumeStatus === 'CRITICO') {
    dom.statUsableCapacity.textContent = `0,0 TB (Inaccesible)`;
    dom.statUsableCapacity.className = 'font-mono-tabular text-lg font-bold text-red-400 mt-0.5 block';
  } else {
    dom.statUsableCapacity.textContent = `${num(metrics.usableTB, 1)} TB`;
    dom.statUsableCapacity.className = 'font-mono-tabular text-xl font-bold text-emerald-400 mt-0.5 block';
  }
  dom.statUsableSub.textContent = spec.formulaSymbolic;

  dom.statRedundancyCapacity.textContent = `${num(metrics.redundancyTB, 1)} TB`;
  dom.statRedundancySub.textContent =
    metrics.redundancyTB === 0
      ? 'Sin bloques de respaldo'
      : `${num(metrics.redundancyTB / metrics.S, 0)} ${metrics.redundancyTB / metrics.S === 1 ? 'disco equivalente' : 'discos equivalentes'}`;

  // Cálculo del margen de fallos adicionales antes de perder datos
  const unavailableCount = state.disks.filter((d) => d.status !== 'healthy').length;
  dom.statFaultTolerance.textContent = metrics.faultToleranceLabel;

  if (state.volumeStatus === 'CRITICO') {
    dom.statFaultSub.textContent = 'Margen superado (Pérdida)';
    dom.statFaultSub.className = 'text-xs font-mono-tabular text-red-400';
  } else if (state.raidLevel === '10') {
    dom.statFaultSub.textContent = '*Si caen en distinto subgrupo';
    dom.statFaultSub.className = 'text-xs font-mono-tabular text-sky-300';
  } else {
    const remaining = Math.max(0, metrics.maxGuaranteedFaults - unavailableCount);
    dom.statFaultSub.textContent = `Margen adicional: ${remaining} ${remaining === 1 ? 'disco' : 'discos'}`;
    dom.statFaultSub.className =
      remaining === 0
        ? 'text-xs font-mono-tabular text-amber-300'
        : 'text-xs font-mono-tabular text-slate-400';
  }

  // Fórmula matemática detallada
  dom.formulaRaidName.textContent = spec.name;
  dom.formulaExpression.textContent = metrics.formulaEvaluated;
  dom.formulaExplanation.textContent = spec.formulaNote;
}

/**
 * ============================================================================
 * VISUALIZACIÓN D3.JS: GRÁFICO DE ANILLOS INTERACTIVO (CAPACIDAD ÚTIL VS REDUNDANCIA)
 * ============================================================================
 * Utiliza d3.pie() y d3.arc() con interpolación suave de ángulos e interacción
 * por ratón/teclado para inspeccionar el desglose exacto de Terabytes y porcentaje.
 */
let d3ChartInstance = null;
let activeDonutSegmentKey = null;

function setDonutCenterReadout(segmentData, metrics) {
  const isCritical = state.volumeStatus === 'CRITICO';
  if (!segmentData) {
    if (isCritical) {
      dom.d3DonutCenterTitle.textContent = 'VOLUMEN CAÍDO';
      dom.d3DonutCenterValue.textContent = '0,0 TB';
      dom.d3DonutCenterValue.className = 'font-mono-tabular text-xl font-bold text-red-400 mt-0.5';
      dom.d3DonutCenterSub.textContent = `${num(metrics.usableTB, 1)} TB inaccesibles`;
    } else {
      dom.d3DonutCenterTitle.textContent = 'CAPACIDAD ÚTIL';
      dom.d3DonutCenterValue.textContent = `${num(metrics.usableTB, 1)} TB`;
      dom.d3DonutCenterValue.className = 'font-mono-tabular text-xl font-bold text-emerald-400 mt-0.5';
      dom.d3DonutCenterSub.textContent = `${num(metrics.efficiencyPct, 1)}% de ${num(metrics.rawTB, 0)} TB`;
    }
    return;
  }

  dom.d3DonutCenterTitle.textContent = segmentData.shortTitle;
  dom.d3DonutCenterValue.textContent = `${num(segmentData.value, 1)} TB`;
  dom.d3DonutCenterValue.className = `font-mono-tabular text-xl font-bold mt-0.5 ${segmentData.textColorClass}`;
  dom.d3DonutCenterSub.textContent = `${num(segmentData.pct, 1)}% (${segmentData.disksEq} ${segmentData.disksEq === 1 ? 'disco' : 'discos'})`;
}

function highlightDonutSegment(segmentKey, metrics) {
  activeDonutSegmentKey = segmentKey;
  dom.btnLegendUsable.classList.toggle('active-segment', segmentKey === 'usable');
  dom.btnLegendRedundancy.classList.toggle('active-segment', segmentKey === 'redundancy');

  if (!d3ChartInstance) return;
  const { svgGroup, arcGenerator, arcHoverGenerator } = d3ChartInstance;

  svgGroup
    .selectAll('path.d3-arc-slice')
    .transition()
    .duration(150)
    .attr('d', (d) => (d.data.key === segmentKey ? arcHoverGenerator(d) : arcGenerator(d)))
    .style('opacity', (d) => (!segmentKey || d.data.key === segmentKey ? 1 : 0.45));

  if (!segmentKey) {
    setDonutCenterReadout(null, metrics);
    dom.d3DonutTooltip.classList.remove('visible');
  } else {
    const found = d3ChartInstance.currentDataset.find((item) => item.key === segmentKey);
    if (found) {
      setDonutCenterReadout(found, metrics);
    }
  }
}

function renderD3CapacityDonut(metrics) {
  if (!dom.d3DonutContainer) return;

  const palette = getD3ThemePalette();
  const isCritical = state.volumeStatus === 'CRITICO';
  const usableDisksEq = metrics.S > 0 ? metrics.usableTB / metrics.S : 0;
  const redundancyDisksEq = metrics.S > 0 ? metrics.redundancyTB / metrics.S : 0;

  const dataset = [
    {
      key: 'usable',
      label: isCritical ? 'Capacidad Útil (Inaccesible)' : 'Capacidad Útil Efectiva',
      shortTitle: isCritical ? 'ÚTIL COMPROMETIDA' : 'CAPACIDAD ÚTIL',
      value: metrics.usableTB,
      pct: metrics.efficiencyPct,
      disksEq: usableDisksEq,
      color: isCritical ? palette.criticalPrimary : palette.usableColor,
      textColorClass: isCritical ? 'text-red-400' : 'text-emerald-400',
    },
    {
      key: 'redundancy',
      label: 'Redundancia / Paridad',
      shortTitle: 'REDUNDANCIA',
      value: metrics.redundancyTB,
      pct: metrics.redundancyPct,
      disksEq: redundancyDisksEq,
      color: isCritical ? palette.criticalSecondary : palette.redundancyColor,
      textColorClass: isCritical ? 'text-red-300' : 'text-sky-400',
    },
  ];

  // Actualizar lectura central por defecto
  setDonutCenterReadout(null, metrics);

  // Si D3 está disponible, renderizar y animar con d3.pie() y d3.arc()
  if (true) {
    const size = 210;
    const outerRadius = 90;
    const innerRadius = 64;

    if (!d3ChartInstance) {
      dom.d3DonutContainer.innerHTML = '';
      const svg = d3
        .select(dom.d3DonutContainer)
        .append('svg')
        .attr('width', size)
        .attr('height', size)
        .attr('viewBox', `0 0 ${size} ${size}`)
        .attr('role', 'img')
        .attr('aria-label', 'Distribución de Capacidad Útil frente a Redundancia');

      // Anillo de fondo sutil (pista del gráfico)
      const bgGroup = svg
        .append('g')
        .attr('transform', `translate(${size / 2}, ${size / 2})`);

      const trackArc = d3
        .arc()
        .innerRadius(innerRadius)
        .outerRadius(outerRadius)
        .startAngle(0)
        .endAngle(Math.PI * 2);

      const trackPath = bgGroup
        .append('path')
        .attr('d', trackArc())
        .attr('fill', palette.trackFill)
        .attr('stroke', palette.trackStroke)
        .attr('stroke-width', 1);

      const svgGroup = svg
        .append('g')
        .attr('transform', `translate(${size / 2}, ${size / 2})`);

      const pieGenerator = d3
        .pie()
        .value((d) => Math.max(0, d.value))
        .sort(null)
        .padAngle(metrics.redundancyTB > 0 ? 0.025 : 0);

      const arcGenerator = d3
        .arc()
        .innerRadius(innerRadius)
        .outerRadius(outerRadius)
        .cornerRadius(4);

      const arcHoverGenerator = d3
        .arc()
        .innerRadius(innerRadius - 2)
        .outerRadius(outerRadius + 6)
        .cornerRadius(5);

      d3ChartInstance = {
        svg,
        svgGroup,
        trackPath,
        pieGenerator,
        arcGenerator,
        arcHoverGenerator,
        currentDataset: dataset,
      };
    }

    if (d3ChartInstance.trackPath) {
      d3ChartInstance.trackPath
        .transition()
        .duration(220)
        .attr('fill', palette.trackFill)
        .attr('stroke', palette.trackStroke);
    }

    d3ChartInstance.currentDataset = dataset;
    d3ChartInstance.pieGenerator.padAngle(metrics.redundancyTB > 0 ? 0.025 : 0);

    const pieData = d3ChartInstance.pieGenerator(dataset);
    const paths = d3ChartInstance.svgGroup
      .selectAll('path.d3-arc-slice')
      .data(pieData, (d) => d.data.key);

    // Enter + Update con interpolación suave de ángulos en D3
    const mergedPaths = paths
      .enter()
      .append('path')
      .attr('class', 'd3-arc-slice')
      .attr('tabindex', '0')
      .attr('stroke', palette.sliceStroke)
      .attr('stroke-width', 2)
      .each(function (d) {
        this._currentAngle = d;
      })
      .merge(paths);

    mergedPaths
      .attr('aria-label', (d) => `${d.data.label}: ${num(d.data.value, 1)} TB (${num(d.data.pct, 1)}%)`)
      .on('mouseenter', function (event, d) {
        highlightDonutSegment(d.data.key, metrics);
        dom.d3DonutTooltip.textContent = `${d.data.label}: ${num(d.data.value, 1)} TB (${num(d.data.pct, 1)}%)`;
        dom.d3DonutTooltip.classList.add('visible');
      })
      .on('mousemove', function (event) {
        const rect = dom.d3DonutContainer.getBoundingClientRect();
        const relX = event.clientX - rect.left;
        const relY = event.clientY - rect.top;
        dom.d3DonutTooltip.style.left = `${Math.min(110, Math.max(4, relX - 55))}px`;
        dom.d3DonutTooltip.style.top = `${Math.max(4, relY - 36)}px`;
      })
      .on('mouseleave', function () {
        highlightDonutSegment(null, metrics);
      })
      .on('focus', function (event, d) {
        highlightDonutSegment(d.data.key, metrics);
      })
      .on('blur', function () {
        highlightDonutSegment(null, metrics);
      });

    mergedPaths
      .transition()
      .duration(280)
      .attr('stroke', palette.sliceStroke)
      .attr('fill', (d) => d.data.color)
      .attrTween('d', function (d) {
        const interpolate = d3.interpolate(this._currentAngle || d, d);
        this._currentAngle = interpolate(1);
        return function (t) {
          return d3ChartInstance.arcGenerator(interpolate(t));
        };
      });

    paths.exit().remove();
  }
}

function calculateNominalIops() {
  return iopsNominales(state.raidLevel, state.diskCount);
}

function computeCurrentIopsSnapshot(customNoise = null) {
  const maxNominal = calculateNominalIops();
  const ruido = customNoise !== null ? customNoise : (Math.random() - 0.5) * (maxNominal * 0.03);
  const averiados = state.disks.filter((d) => d.status === 'failed').length;
  return instantaneaIops(state.raidLevel, state.diskCount, state.volumeStatus, averiados, ruido);
}

function seedInitialIopsHistory() {
  state.iopsHistory = [];
  state.iopsTickCounter = 0;
  for (let i = 0; i < SEGUNDOS_GRAFICO_IOPS; i++) {
    state.iopsTickCounter += 1;
    const snap = computeCurrentIopsSnapshot(Math.sin(i * 0.6) * (calculateNominalIops() * 0.012));
    state.iopsHistory.push({ tick: state.iopsTickCounter, ...snap });
  }
}

function recordIopsSample() {
  state.iopsTickCounter += 1;
  state.iopsHistory.push({ tick: state.iopsTickCounter, ...computeCurrentIopsSnapshot() });
  if (state.iopsHistory.length > SEGUNDOS_GRAFICO_IOPS) {
    state.iopsHistory.shift();
  }
}

function refreshLatestIopsSample() {
  if (state.iopsHistory.length === 0) return;
  const ultima = state.iopsHistory[state.iopsHistory.length - 1];
  state.iopsHistory[state.iopsHistory.length - 1] = { tick: ultima.tick, ...computeCurrentIopsSnapshot() };
}

function renderD3IopsLineChart() {
  if (!dom.d3IopsChartContainer) return;
  if (!state.iopsHistory || state.iopsHistory.length === 0) {
    seedInitialIopsHistory();
  }

  const latest = state.iopsHistory[state.iopsHistory.length - 1];
  const maxNominal = latest.maxNominal;

  // Actualizar insignia superior y nota pedagógica
  if (latest.phase === 'CRITICO') {
    dom.iopsLiveBadge.textContent = '0 IOPS (0% · VOLUMEN CAÍDO)';
    dom.iopsLiveBadge.className = 'text-red-400 font-semibold';
    dom.iopsImpactNote.textContent =
      'Caída a 0 IOPS: el controlador ha desmontado el volumen lógico por pérdida irreversible de bloques.';
    dom.iopsImpactNote.className = 'text-xs text-red-300 leading-snug';
  } else if (latest.phase === 'RECONSTRUYENDO') {
    const dropPct = 100 - latest.pctOfNominal;
    dom.iopsLiveBadge.textContent = `${latest.hostIops.toLocaleString('es-ES')} IOPS (−${dropPct}% en Rebuild)`;
    dom.iopsLiveBadge.className = 'text-sky-300 font-semibold';
    dom.iopsImpactNote.textContent = `Rendimiento degradado un ${dropPct}% durante el Rebuild (${state.rebuildProgress}%): el controlador consume ~${latest.rebuildIops.toLocaleString('es-ES')} IOPS internos reconstruyendo sectores.`;
    dom.iopsImpactNote.className = 'text-xs text-sky-300 leading-snug';
  } else if (latest.phase === 'DEGRADADO') {
    const dropPct = 100 - latest.pctOfNominal;
    dom.iopsLiveBadge.textContent = `${latest.hostIops.toLocaleString('es-ES')} IOPS (−${dropPct}% Degradado)`;
    dom.iopsLiveBadge.className = 'text-amber-300 font-semibold';
    dom.iopsImpactNote.textContent = `Penalización de lectura (−${dropPct}% IOPS): cada bloque del disco averiado debe recalcularse en vivo desde las unidades sanas.`;
    dom.iopsImpactNote.className = 'text-xs text-amber-300 leading-snug';
  } else {
    dom.iopsLiveBadge.textContent = `${latest.hostIops.toLocaleString('es-ES')} IOPS (${latest.pctOfNominal}% Nominal)`;
    dom.iopsLiveBadge.className = 'text-emerald-400 font-semibold';
    dom.iopsImpactNote.textContent =
      `Nominal (carga ${Math.round(FRACCION_LECTURA * 100)} % lectura / ${Math.round((1 - FRACCION_LECTURA) * 100)} % escritura, ${IOPS_POR_DISCO.toLocaleString('es-ES')} IOPS por disco): ${state.diskCount} × ${IOPS_POR_DISCO.toLocaleString('es-ES')} / (${num(FRACCION_LECTURA, 1)} + ${num(1 - FRACCION_LECTURA, 1)} × ${penalizacionEscritura(state.raidLevel, state.diskCount)}), donde ${penalizacionEscritura(state.raidLevel, state.diskCount)} es la penalización de escritura de ${RAID_SPECS[state.raidLevel].name}. Provoca una avería para ver la caída.`;
    dom.iopsImpactNote.className = 'text-xs text-slate-400 leading-snug';
  }

  const palette = getD3ThemePalette();

  const width = 340;
  const height = 122;
  const margin = { top: 10, right: 10, bottom: 20, left: 38 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  dom.d3IopsChartContainer.innerHTML = '';

  const svg = d3
    .select(dom.d3IopsChartContainer)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('class', 'w-full h-full overflow-visible');

  // Gradiente vertical para el área bajo la curva de IOPS Host
  const defs = svg.append('defs');
  const mainColor =
    latest.phase === 'CRITICO'
      ? palette.criticalPrimary
      : latest.phase === 'RECONSTRUYENDO'
        ? palette.rebuildColor
        : latest.phase === 'DEGRADADO'
          ? palette.degradedColor
          : palette.usableColor;

  const grad = defs
    .append('linearGradient')
    .attr('id', 'iops-area-grad')
    .attr('x1', '0%')
    .attr('y1', '0%')
    .attr('x2', '0%')
    .attr('y2', '100%');

  grad.append('stop').attr('offset', '0%').attr('stop-color', mainColor).attr('stop-opacity', 0.32);
  grad.append('stop').attr('offset', '100%').attr('stop-color', mainColor).attr('stop-opacity', 0.02);

  const g = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top})`);

  const xScale = d3
    .scaleLinear()
    .domain([0, Math.max(1, state.iopsHistory.length - 1)])
    .range([0, innerW]);

  const yScale = d3
    .scaleLinear()
    .domain([0, maxNominal * 1.08])
    .range([innerH, 0]);

  // Líneas guía horizontales (0%, 50%, 100% nominal)
  const yTicks = [0, Math.round(maxNominal * 0.5), maxNominal];
  g.selectAll('line.grid-line')
    .data(yTicks)
    .enter()
    .append('line')
    .attr('class', 'grid-line')
    .attr('x1', 0)
    .attr('x2', innerW)
    .attr('y1', (d) => yScale(d))
    .attr('y2', (d) => yScale(d))
    .attr('stroke', palette.gridLine)
    .attr('stroke-dasharray', (d) => (d === maxNominal ? '2,2' : 'none'))
    .attr('stroke-width', 1);

  // Etiquetas del eje Y en miles de IOPS (k)
  g.selectAll('text.y-label')
    .data(yTicks)
    .enter()
    .append('text')
    .attr('class', 'y-label')
    .attr('x', -6)
    .attr('y', (d) => yScale(d) + 3)
    .attr('text-anchor', 'end')
    .attr('fill', palette.axisText)
    .attr('font-size', '9px')
    .attr('font-family', 'IBM Plex Mono, monospace')
    .text((d) => `${Math.round(d / 1000)}k`);

  // Área sombreada bajo la curva de IOPS útiles del Host
  const areaHost = d3
    .area()
    .x((_, i) => xScale(i))
    .y0(innerH)
    .y1((d) => yScale(d.hostIops))
    .curve(d3.curveMonotoneX);

  g.append('path')
    .datum(state.iopsHistory)
    .attr('fill', 'url(#iops-area-grad)')
    .attr('d', areaHost);

  // Línea punteada secundaria: Tráfico Interno de Rebuild / Paridad
  const lineRebuild = d3
    .line()
    .x((_, i) => xScale(i))
    .y((d) => yScale(d.rebuildIops))
    .curve(d3.curveMonotoneX);

  g.append('path')
    .datum(state.iopsHistory)
    .attr('fill', 'none')
    .attr('stroke', palette.redundancyColor)
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '3,3')
    .attr('opacity', 0.85)
    .attr('d', lineRebuild);

  // Línea principal: IOPS de Lectura/Escritura de Aplicaciones (Host)
  const lineHost = d3
    .line()
    .x((_, i) => xScale(i))
    .y((d) => yScale(d.hostIops))
    .curve(d3.curveMonotoneX);

  g.append('path')
    .datum(state.iopsHistory)
    .attr('fill', 'none')
    .attr('stroke', mainColor)
    .attr('stroke-width', 2.2)
    .attr('d', lineHost);

  // Punto final indicador del valor actual en tiempo real
  const lastIndex = state.iopsHistory.length - 1;
  g.append('circle')
    .attr('cx', xScale(lastIndex))
    .attr('cy', yScale(latest.hostIops))
    .attr('r', 3.5)
    .attr('fill', mainColor)
    .attr('stroke', palette.sliceStroke)
    .attr('stroke-width', 1.5);

  // Etiquetas del eje X (Ventana de tiempo reciente)
  g.append('text')
    .attr('x', 0)
    .attr('y', innerH + 14)
    .attr('fill', palette.axisText)
    .attr('font-size', '9px')
    .attr('font-family', 'IBM Plex Mono, monospace')
    .text(`−${state.iopsHistory.length - 1} s`);

  g.append('text')
    .attr('x', innerW)
    .attr('y', innerH + 14)
    .attr('text-anchor', 'end')
    .attr('fill', palette.axisTextStrong)
    .attr('font-size', '9px')
    .attr('font-family', 'IBM Plex Mono, monospace')
    .text('ahora');
}

/**
 * Renderiza toda la interfaz sincronizada con el estado actual.
 */
function renderAll() {
  refreshLatestIopsSample();
  renderStatusBanner();
  renderServerRack();
  renderStripeMatrix();
  renderStatisticsPanel();
  renderD3IopsLineChart();
  if (state.tutorialActive) {
    syncGuidedTutorialUI(false);
  }
}

/**
 * ============================================================================
 * MODO TUTORIAL GUIADO INTERACTIVO (PARIDAD, DEGRADACIÓN Y RECONSTRUCCIÓN)
 * ============================================================================
 * Resalta paneles clave de la interfaz mediante un foco visual (.tutorial-highlight-target)
 * y posiciona un tooltip flotante que explica los fundamentos matemáticos y reacciona
 * en tiempo real cuando el estudiante interactúa con los discos o controles.
 */
const TUTORIAL_STEPS = [
  {
    targetId: 'panel-config-raid',
    targetLabel: 'Panel 01 · Configuración RAID',
    title: '1. ¿Por qué necesitamos Paridad en un Arreglo?',
    body: 'En un arreglo con paridad distribuida (como RAID 5), no duplicamos todos los discos como en RAID 1. En su lugar, reservamos la capacidad equivalente de 1 sola unidad física para almacenar bloques matemáticos de verificación (Paridad XOR) repartidos entre todos los discos.',
    onEnter: () => {
      if (state.raidLevel !== '5' || state.diskCount !== 4 || state.volumeStatus !== 'OPTIMO') {
        state.raidLevel = '5';
        state.diskCount = 4;
        state.diskSizeTB = 4;
        createArray('Tutorial Paso 1: Configurado arreglo base RAID 5 de 4 × 4 TB en estado Óptimo.');
      }
    },
    getDynamicStatus: () => {
      const m = calculateCapacityMetrics();
      return {
        formula: `Nivel activo: ${RAID_SPECS[state.raidLevel].name} (${m.N} discos × ${m.S} TB)`,
        feedback:
          state.raidLevel === '5' || state.raidLevel === '6'
            ? `✓ Arreglo con paridad activa: ${num(m.usableTB, 1)} TB útiles y ${num(m.redundancyTB, 1)} TB dedicados a paridad.`
            : `Estás explorando ${RAID_SPECS[state.raidLevel].name}. Pulsa el botón inferior para volver a RAID 5 y analizar la paridad XOR.`,
        actionLabel:
          state.raidLevel !== '5' ? 'Restablecer ejemplo RAID 5 (4 × 4 TB)' : null,
        onAction: () => {
          state.raidLevel = '5';
          state.diskCount = 4;
          state.diskSizeTB = 4;
          createArray('Tutorial: Arreglo RAID 5 (4 × 4 TB) configurado.');
        },
      };
    },
  },
  {
    targetId: 'mapa-bloques',
    targetLabel: 'Panel 03 · Matriz de Bloques',
    title: '2. Álgebra XOR y Paridad Distribuida Rotativa',
    body: 'Observa los bloques ámbar de Paridad P en la tabla. En cada fila horizontal (Stripe), el controlador calcula la operación lógica OR Exclusivo (XOR, símbolo ⊕) de los bloques de datos. Además, la paridad rota diagonalmente de disco en cada fila para evitar que un solo disco sufra todo el cuello de botella de escritura.',
    onEnter: () => {},
    getDynamicStatus: () => {
      return {
        formula: 'Ecuación por Stripe: P₁ = D1 ⊕ D2 ⊕ D3',
        feedback:
          'Propiedad clave de XOR: es reversible. Si pierdes cualquier bloque de datos (ej. D2), basta con calcular D2 = D1 ⊕ D3 ⊕ P₁ en tiempo real.',
        actionLabel: null,
        onAction: null,
      };
    },
  },
  {
    targetId: 'd3-donut-card',
    targetLabel: 'Panel 04 · Capacidad D3.js',
    title: '3. Coste de Capacidad: Útil vs. Redundancia',
    body: 'El gráfico de anillos D3.js muestra cómo impacta la paridad en el almacenamiento. Con 4 discos de 4 TB en RAID 5 (16 TB brutos), 12 TB (75%) son Capacidad Útil y 4 TB (25%, equivalente a 1 disco) se destinan a Redundancia XOR. Pasa el cursor por el anillo para inspeccionar cada segmento.',
    onEnter: () => {
      highlightDonutSegment('redundancy', calculateCapacityMetrics());
    },
    getDynamicStatus: () => {
      const m = calculateCapacityMetrics();
      return {
        formula: m.formulaEvaluated,
        feedback: `Eficiencia actual: ${num(m.efficiencyPct, 1)}% | Redundancia: ${num(m.redundancyTB, 1)} TB (${num(m.redundancyPct, 1)}%).`,
        actionLabel: 'Alternar enfoque en el anillo D3.js',
        onAction: () => {
          const nextSeg = activeDonutSegmentKey === 'usable' ? 'redundancy' : 'usable';
          highlightDonutSegment(nextSeg, calculateCapacityMetrics());
        },
      };
    },
  },
  {
    targetId: 'panel-server-rack',
    targetLabel: 'Panel 02 · Bastidor Hot-Swap',
    title: '4. Provocar una Avería: El Estado DEGRADADO',
    body: '¡Hora de interactuar! Haz clic directamente sobre cualquier disco verde del bastidor (ej. BAY-02) para simular un fallo electromecánico. Verás que el volumen pasa a estado DEGRADADO: no se pierde ni un solo byte, porque los bloques del disco caído se reconstruyen al vuelo mediante XOR.',
    onEnter: () => {
      highlightDonutSegment(null, calculateCapacityMetrics());
    },
    getDynamicStatus: () => {
      const failedDisks = state.disks.filter((d) => d.status === 'failed');
      if (state.volumeStatus === 'DEGRADADO' && failedDisks.length > 0) {
        return {
          formula: `Reconstrucción en vivo: ${failedDisks[0].id} = ⊕ (Discos Sanos + Paridad P)`,
          feedback: `✓ ¡Excelente! Has provocado una avería en ${failedDisks.map((d) => d.id).join(', ')}. El volumen está DEGRADADO pero 100% operativo sin pérdida de datos.`,
          actionLabel: null,
          onAction: null,
        };
      }
      return {
        formula: 'Acción requerida: Haz clic en un disco del bastidor',
        feedback:
          'Todavía no hay discos averiados. Haz clic en una bahía del servidor o usa el botón rápido inferior para simular la caída de BAY-02.',
        actionLabel: '⚡ Simular avería en BAY-02 ahora',
        onAction: () => {
          if (state.disks.length > 1) {
            toggleDiskFault(1);
          }
        },
      };
    },
  },
  {
    targetId: 'volume-status-banner',
    targetLabel: 'Panel Superior · Control Rebuild',
    title: '5. Reemplazo en Caliente y Proceso de Rebuild',
    body: 'Operar en estado Degradado es peligroso porque ya no queda margen ante un segundo fallo en RAID 5. Cuando el técnico inserta un disco nuevo, el controlador inicia el REBUILD: lee secuencialmente todos los discos sanos para recalcular y escribir cada sector en la unidad de reemplazo.',
    onEnter: () => {
      const hasFailed = state.disks.some((d) => d.status === 'failed');
      const isRebuilding = state.volumeStatus === 'RECONSTRUYENDO';
      if (!hasFailed && !isRebuilding && state.disks.length > 1) {
        state.disks[1].status = 'failed';
        recalculateArrayState();
        renderAll();
      }
    },
    getDynamicStatus: () => {
      if (state.volumeStatus === 'RECONSTRUYENDO') {
        return {
          formula: `Rebuild activo en curso: ${state.rebuildProgress}% completado`,
          feedback:
            '✓ ¡Rebuild en marcha! Observa la barra de progreso azul recalculando Terabytes desde las unidades sobrevivientes.',
          actionLabel: null,
          onAction: null,
        };
      }
      return {
        formula: 'Estado actual: Unidad averiada esperando reemplazo',
        feedback:
          'Haz clic en el botón azul "Reemplazar disco averiado" del banner resaltado (o usa el botón inferior) para iniciar la reconstrucción.',
        actionLabel: '🔧 Iniciar Rebuild de unidad averiada',
        onAction: () => {
          const hasFailed = state.disks.some((d) => d.status === 'failed');
          if (!hasFailed && state.disks.length > 1) {
            state.disks[1].status = 'failed';
            recalculateArrayState();
          }
          startRebuildSimulation();
        },
      };
    },
  },
  {
    targetId: 'bitacora',
    targetLabel: 'Panel 05 · Telemetría IOPS D3.js',
    title: '6. Penalización de Lectura/Escritura (Caída de IOPS)',
    body: 'Observa el gráfico lineal D3.js en la Bitácora. Cuando un arreglo entra en Degradación o Rebuild, los discos sanos están saturados leyendo bloques de datos y paridad (línea punteada). Como resultado, los IOPS disponibles para las aplicaciones del servidor (curva principal) sufren una caída severa.',
    onEnter: () => {},
    getDynamicStatus: () => {
      const latest =
        state.iopsHistory && state.iopsHistory.length > 0
          ? state.iopsHistory[state.iopsHistory.length - 1]
          : computeCurrentIopsSnapshot(0);
      return {
        formula: `Host IOPS: ${latest.hostIops.toLocaleString('es-ES')} (${latest.pctOfNominal}% del nominal) | Tráfico Rebuild: ${latest.rebuildIops.toLocaleString('es-ES')} IOPS`,
        feedback:
          state.volumeStatus === 'RECONSTRUYENDO' || state.volumeStatus === 'DEGRADADO'
            ? '✓ Estás visualizando en vivo la caída de rendimiento I/O causada por el cálculo de paridad.'
            : 'Inicia un Rebuild o degrada un disco para observar cómo se desploma la curva de IOPS en tiempo real.',
        actionLabel:
          state.volumeStatus === 'OPTIMO'
            ? '⚡ Simular Rebuild para ver caída de IOPS'
            : null,
        onAction: () => {
          if (state.disks.length > 1) {
            state.disks[1].status = 'failed';
            recalculateArrayState();
            startRebuildSimulation();
          }
        },
      };
    },
  },
  {
    targetId: 'panel-server-rack',
    targetLabel: 'Panel 02 · Tolerancia Límite',
    title: '7. Fallo Crítico en Rebuild vs. Doble Paridad (RAID 6)',
    body: 'Durante el Rebuild de un RAID 5, todas las unidades restantes leen al 100% de su capacidad. Si un 2.º disco sufre un fallo en ese momento, una sola ecuación XOR tiene 2 incógnitas (sistema irresoluble) y ocurre un FALLO CRÍTICO con pérdida total. En cambio, RAID 6 añade un segundo síndrome algebraico Q (Campos de Galois) para soportar 2 discos caídos.',
    onEnter: () => {},
    getDynamicStatus: () => {
      if (state.volumeStatus === 'CRITICO') {
        return {
          formula: 'D_caído1 ⊕ D_caído2 = Constante (2 incógnitas → Irresoluble)',
          feedback:
            '💥 Has comprobado el Fallo Crítico en RAID 5. Pulsa el botón inferior para comparar cómo RAID 6 sobrevive a 2 discos averiados simultáneamente.',
          actionLabel: '🛡️ Probar el mismo doble fallo en RAID 6 (P+Q)',
          onAction: () => {
            runEducationalScenario('raid6-dual-fault');
          },
        };
      }
      if (state.raidLevel === '6' && state.volumeStatus === 'DEGRADADO') {
        return {
          formula: 'Sistema de 2 ecuaciones (Síndrome P + Síndrome Q) → Soluble',
          feedback:
            '✓ ¡Observa cómo RAID 6 mantiene todos los datos íntegros incluso con 2 discos físicos averiados a la vez!',
          actionLabel: null,
          onAction: null,
        };
      }
      return {
        formula: 'Experimento final: Provoca un 2.º fallo en otro disco del bastidor',
        feedback:
          'Haz clic en un segundo disco sano durante el Rebuild (o usa el botón inferior) para demostrar el colapso de paridad simple.',
        actionLabel: '💥 Provocar 2.º fallo catastrófico ahora',
        onAction: () => {
          if (state.raidLevel !== '5') {
            state.raidLevel = '5';
            state.diskCount = 4;
            createArray();
          }
          if (state.volumeStatus === 'OPTIMO') {
            state.disks[1].status = 'failed';
            recalculateArrayState();
          }
          // El paso 5 puede dejar el volumen degradado sin rebuild: el 2.º fallo
          // solo demuestra algo si llega con la reconstrucción en marcha.
          if (state.volumeStatus === 'DEGRADADO') {
            startRebuildSimulation();
          }
          triggerSecondFaultDuringRebuild();
        },
      };
    },
  },
];

let currentHighlightedEl = null;

function clearTutorialHighlight() {
  if (currentHighlightedEl) {
    currentHighlightedEl.classList.remove('tutorial-highlight-target');
    currentHighlightedEl = null;
  }
  document
    .querySelectorAll('.tutorial-highlight-target')
    .forEach((el) => el.classList.remove('tutorial-highlight-target'));
}

function positionTutorialTooltip(targetEl) {
  if (!dom.guidedTutorialPopover || !targetEl) return;
  const pop = dom.guidedTutorialPopover;
  const arrow = dom.tutorialPopoverArrow;

  const rect = targetEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 14;

  let top = 0;
  let left = 0;
  let arrowPlaced = false;

  // En pantallas anchas intentamos colocar el tooltip al lado derecho o izquierdo del panel resaltado
  if (vw >= 1024) {
    const spaceRight = vw - rect.right;
    const spaceLeft = rect.left;

    if (spaceRight >= popRect.width + 24) {
      left = rect.right + 16;
      top = Math.max(margin, Math.min(vh - popRect.height - margin, rect.top + 12));
      if (arrow) {
        arrow.className = 'tutorial-popover-arrow';
        arrow.style.left = '-7px';
        arrow.style.right = 'auto';
        arrow.style.top = `${Math.max(18, Math.min(popRect.height - 26, rect.top - top + 28))}px`;
        arrow.style.bottom = 'auto';
        arrow.style.transform = 'rotate(-45deg)';
        arrowPlaced = true;
      }
    } else if (spaceLeft >= popRect.width + 24) {
      left = rect.left - popRect.width - 16;
      top = Math.max(margin, Math.min(vh - popRect.height - margin, rect.top + 12));
      if (arrow) {
        arrow.className = 'tutorial-popover-arrow';
        arrow.style.right = '-7px';
        arrow.style.left = 'auto';
        arrow.style.top = `${Math.max(18, Math.min(popRect.height - 26, rect.top - top + 28))}px`;
        arrow.style.bottom = 'auto';
        arrow.style.transform = 'rotate(135deg)';
        arrowPlaced = true;
      }
    }
  }

  // Si no cabe lateralmente o estamos en móvil/tablet, posicionar debajo o encima sin tapar los controles interactivos del elemento
  if (!arrowPlaced) {
    left = Math.max(
      margin,
      Math.min(vw - popRect.width - margin, rect.left + rect.width / 2 - popRect.width / 2)
    );
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;

    if (spaceBelow >= popRect.height + 20) {
      top = rect.bottom + 14;
      if (arrow) {
        arrow.className = 'tutorial-popover-arrow';
        arrow.style.top = '-7px';
        arrow.style.bottom = 'auto';
        arrow.style.left = `${Math.round(popRect.width / 2 - 6)}px`;
        arrow.style.right = 'auto';
        arrow.style.transform = 'rotate(45deg)';
      }
    } else if (spaceAbove >= popRect.height + 20) {
      top = rect.top - popRect.height - 14;
      if (arrow) {
        arrow.className = 'tutorial-popover-arrow';
        arrow.style.bottom = '-7px';
        arrow.style.top = 'auto';
        arrow.style.left = `${Math.round(popRect.width / 2 - 6)}px`;
        arrow.style.right = 'auto';
        arrow.style.transform = 'rotate(225deg)';
      }
    } else {
      // Anclar en la esquina inferior derecha de forma flotante para dejar libre el panel
      top = Math.max(margin, vh - popRect.height - margin);
      left = Math.max(margin, vw - popRect.width - margin);
      if (arrow) {
        arrow.classList.add('hidden');
      }
    }
  }

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

function syncGuidedTutorialUI(scrollToTarget = false) {
  if (!state.tutorialActive || !dom.guidedTutorialPopover) return;

  const stepIdx = state.tutorialStepIndex;
  const step = TUTORIAL_STEPS[stepIdx];
  if (!step) return;

  const targetEl = document.getElementById(step.targetId);
  clearTutorialHighlight();
  if (targetEl) {
    targetEl.classList.add('tutorial-highlight-target');
    currentHighlightedEl = targetEl;
    if (scrollToTarget) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  dom.tutorialStepBadge.textContent = `PASO ${stepIdx + 1} DE ${TUTORIAL_STEPS.length}`;
  dom.tutorialTargetTag.textContent = step.targetLabel;
  dom.tutorialStepTitle.textContent = step.title;
  dom.tutorialStepBody.textContent = step.body;

  // Renderizar indicadores de progreso por paso
  dom.tutorialProgressDots.innerHTML = TUTORIAL_STEPS.map((_, idx) => {
    const cls =
      idx === stepIdx
        ? 'tutorial-step-dot active'
        : idx < stepIdx
          ? 'tutorial-step-dot completed'
          : 'tutorial-step-dot';
    return `<span class="${cls}"></span>`;
  }).join('');

  // Actualizar estado interactivo en vivo según lo que el usuario haya hecho en el simulador
  const dyn = step.getDynamicStatus();
  dom.tutorialFormulaLine.textContent = dyn.formula;
  dom.tutorialLiveFeedback.textContent = dyn.feedback;

  if (dyn.actionLabel && typeof dyn.onAction === 'function') {
    dom.tutorialActionWrapper.classList.remove('hidden');
    dom.btnTutorialAction.textContent = dyn.actionLabel;
    dom.btnTutorialAction.onclick = () => {
      dyn.onAction();
      syncGuidedTutorialUI(false);
    };
  } else {
    dom.tutorialActionWrapper.classList.add('hidden');
    dom.btnTutorialAction.onclick = null;
  }

  dom.btnTutorialPrev.disabled = stepIdx === 0;
  dom.btnTutorialNext.textContent =
    stepIdx === TUTORIAL_STEPS.length - 1 ? 'Finalizar Tutorial ✓' : 'Siguiente →';

  dom.guidedTutorialPopover.classList.remove('hidden');

  if (targetEl) {
    requestAnimationFrame(() => {
      positionTutorialTooltip(targetEl);
    });
    if (scrollToTarget) {
      setTimeout(() => positionTutorialTooltip(targetEl), 340);
    }
  }
}

function goToTutorialStep(index) {
  if (index < 0 || index >= TUTORIAL_STEPS.length) {
    stopGuidedTutorial();
    return;
  }
  state.tutorialStepIndex = index;
  const step = TUTORIAL_STEPS[index];
  if (step && typeof step.onEnter === 'function') {
    step.onEnter();
  }
  syncGuidedTutorialUI(true);
}

function startGuidedTutorial() {
  state.tutorialActive = true;
  state.tutorialStepIndex = 0;
  if (dom.btnStartTutorial) {
    dom.btnStartTutorial.setAttribute('aria-expanded', 'true');
    dom.btnStartTutorial.textContent = '🎓 Tutorial Activo (Salir)';
  }
  addControllerLog(
    'ok',
    'Modo Tutorial Guiado iniciado: recorrido interactivo sobre Paridad, Degradación y Reconstrucción.'
  );
  goToTutorialStep(0);
}

function stopGuidedTutorial() {
  state.tutorialActive = false;
  clearTutorialHighlight();
  highlightDonutSegment(null, calculateCapacityMetrics());
  if (dom.guidedTutorialPopover) {
    dom.guidedTutorialPopover.classList.add('hidden');
  }
  if (dom.btnStartTutorial) {
    dom.btnStartTutorial.setAttribute('aria-expanded', 'false');
    dom.btnStartTutorial.textContent = '🎓 Tutorial Guiado (Paso a Paso)';
  }
  addControllerLog('ok', 'Modo Tutorial Guiado finalizado.');
}

/**
 * ============================================================================
 * ESCENARIOS EDUCATIVOS PRECONFIGURADOS PARA DEMOSTRACIÓN EN CLASE
 * ============================================================================
 */
function runEducationalScenario(scenarioKey) {
  stopRebuildTimer();

  if (scenarioKey === 'raid5-catastrophe') {
    state.raidLevel = '5';
    state.diskCount = 4;
    state.diskSizeTB = 8;
    createArray('Escenario 1 cargado: Arreglo RAID 5 de 4 × 8 TB.');
    // Provocar primer fallo e iniciar rebuild para que el alumno vea el riesgo y pueda causar el 2.º fallo
    state.disks[1].status = 'failed';
    recalculateArrayState();
    addControllerLog(
      'warn',
      'Escenario 1: BAY-02 ha fallado (Estado Degradado). Iniciando Rebuild automático; haz clic en cualquier otro disco o en "Provocar 2.º fallo en Rebuild" para observar el colapso.'
    );
    startRebuildSimulation();
  } else if (scenarioKey === 'raid6-dual-fault') {
    state.raidLevel = '6';
    state.diskCount = 6;
    state.diskSizeTB = 8;
    createArray('Escenario 2 cargado: Arreglo RAID 6 de 6 × 8 TB con doble paridad P+Q.');
    state.disks[1].status = 'failed';
    state.disks[4].status = 'failed';
    recalculateArrayState();
    addControllerLog(
      'warn',
      'Escenario 2: Dos unidades (BAY-02 y BAY-05) han fallado simultáneamente. Observa cómo RAID 6 mantiene el volumen íntegro resolviendo los síndromes P y Q.'
    );
    renderAll();
  } else if (scenarioKey === 'raid10-subgroups') {
    state.raidLevel = '10';
    state.diskCount = 6;
    state.diskSizeTB = 4;
    createArray('Escenario 3 cargado: Arreglo RAID 10 de 6 discos (3 Subgrupos Espejo A, B y C).');
    // Fallar 1 disco de cada subgrupo distinto (3 discos caídos en total y el arreglo sigue vivo)
    state.disks[0].status = 'failed'; // Subgrupo A
    state.disks[2].status = 'failed'; // Subgrupo B
    state.disks[4].status = 'failed'; // Subgrupo C
    recalculateArrayState();
    addControllerLog(
      'warn',
      'Escenario 3: ¡3 discos averiados (BAY-01, BAY-03 y BAY-05) y el volumen RAID 10 sigue vivo! Esto ocurre porque cada fallo cayó en un subgrupo espejo distinto. Si haces clic en BAY-02 ahora, caerá el Subgrupo A completo y perderás todos los datos.'
    );
    renderAll();
  }
}

/**
 * ============================================================================
 * REGISTRO DE EVENTOS INTERACTIVOS DEL DOM
 * ============================================================================
 */
function bindEventListeners() {
  // Selección de nivel RAID
  dom.raidTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const newRaid = btn.getAttribute('data-raid');
      if (!newRaid) return;
      state.raidLevel = newRaid;
      state.diskCount = validateAndNormalizeDiskCount(newRaid, state.diskCount, true);
      createArray();
    });
  });

  // Slider de número de discos
  dom.inputDiskCount.addEventListener('input', (e) => {
    state.diskCount = validateAndNormalizeDiskCount(state.raidLevel, e.target.value, true);
    dom.inputDiskCount.value = state.diskCount;
    createArray();
  });

  // Botones +/- de número de discos
  dom.btnDecDisks.addEventListener('click', () => {
    const step = RAID_SPECS[state.raidLevel].requireEven ? 2 : 1;
    state.diskCount = validateAndNormalizeDiskCount(
      state.raidLevel,
      state.diskCount - step,
      true
    );
    createArray();
  });

  dom.btnIncDisks.addEventListener('click', () => {
    const step = RAID_SPECS[state.raidLevel].requireEven ? 2 : 1;
    state.diskCount = validateAndNormalizeDiskCount(
      state.raidLevel,
      state.diskCount + step,
      true
    );
    createArray();
  });

  // Slider de tamaño en TB
  dom.inputDiskSize.addEventListener('input', (e) => {
    state.diskSizeTB = parseInt(e.target.value, 10) || 4;
    renderAll();
  });

  // Botones de presets rápidos de TB
  dom.sizePresetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = parseInt(btn.getAttribute('data-size-preset'), 10);
      if (!isNaN(size)) {
        state.diskSizeTB = size;
        dom.inputDiskSize.value = size;
        addControllerLog(
          'ok',
          `Capacidad por unidad actualizada a ${size} TB (Capacidad útil: ${num(calculateCapacityMetrics().usableTB, 1)} TB).`
        );
        renderAll();
      }
    });
  });

  // Botón Crear Arreglo
  dom.btnCreateArray.addEventListener('click', () => {
    dom.diskValidationMsg.classList.add('hidden');
    createArray(
      `Nuevo arreglo ${RAID_SPECS[state.raidLevel].name} construido manualmente (${state.diskCount} × ${state.diskSizeTB} TB). Todas las unidades óptimas.`
    );
  });

  // Botón Reemplazar disco averiado (Iniciar Rebuild)
  dom.btnReplaceDisk.addEventListener('click', () => {
    startRebuildSimulation();
  });

  // Botón Provocar 2.º fallo durante Rebuild
  dom.btnFailSecondDuringRebuild.addEventListener('click', () => {
    triggerSecondFaultDuringRebuild();
  });

  // Botón Restaurar Arreglo
  dom.btnRestoreAll.addEventListener('click', () => {
    createArray(
      `Arreglo ${RAID_SPECS[state.raidLevel].name} restaurado a estado ÓPTIMO con todas las unidades en línea.`
    );
  });

  // Botón limpiar bitácora
  dom.btnClearLog.addEventListener('click', () => {
    state.logs = [];
    renderEventLog();
  });

  // Botones de escenarios educativos
  dom.scenarioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-scenario');
      if (key) runEducationalScenario(key);
    });
  });

  // Interacción de la leyenda con los segmentos del gráfico de anillos D3.js
  [dom.btnLegendUsable, dom.btnLegendRedundancy].forEach((btn) => {
    if (!btn) return;
    const segKey = btn.getAttribute('data-donut-segment');
    btn.addEventListener('mouseenter', () => {
      highlightDonutSegment(segKey, calculateCapacityMetrics());
    });
    btn.addEventListener('mouseleave', () => {
      highlightDonutSegment(null, calculateCapacityMetrics());
    });
    btn.addEventListener('click', () => {
      const nextKey = activeDonutSegmentKey === segKey ? null : segKey;
      highlightDonutSegment(nextKey, calculateCapacityMetrics());
    });
  });

  // Botón para descargar este mismo archivo index.html autónomo
  dom.btnDownloadHtml.addEventListener('click', async () => {
    try {
      const res = await fetch(OFFLINE_FILE, { method: 'HEAD', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      addControllerLog('warn', 'La versión offline solo está disponible en la web publicada (se genera con npm run build).');
      return;
    }
    const a = document.createElement('a');
    a.href = OFFLINE_FILE;
    a.download = OFFLINE_FILE;
    document.body.appendChild(a);
    a.click();
    a.remove();
    addControllerLog('ok', `Descargado ${OFFLINE_FILE}: el simulador completo en un único archivo que funciona sin conexión.`);
  });

  // Eventos del Modal de Exportación de Informe de Simulación (PDF y TXT)
  [dom.btnExportReport, dom.btnExportReportTop].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      openReportExportModal();
    });
  });

  if (dom.btnCloseReportModal) {
    dom.btnCloseReportModal.addEventListener('click', () => {
      closeReportExportModal();
    });
  }

  if (dom.reportExportModal) {
    dom.reportExportModal.addEventListener('click', (e) => {
      if (e.target === dom.reportExportModal) {
        closeReportExportModal();
      }
    });
  }

  [dom.inputStudentName, dom.inputStudentNotes].forEach((inp) => {
    if (!inp) return;
    inp.addEventListener('input', () => {
      if (dom.reportPreviewText) {
        dom.reportPreviewText.textContent = buildSimulationReportPlainText();
      }
    });
  });

  if (dom.btnCopyReportTxt) {
    dom.btnCopyReportTxt.addEventListener('click', () => {
      const reportText = buildSimulationReportPlainText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(reportText).then(() => {
          dom.reportCopyFeedback.classList.remove('hidden');
          setTimeout(() => dom.reportCopyFeedback.classList.add('hidden'), 2500);
        });
      }
      addControllerLog('ok', 'Informe de simulación copiado al portapapeles.');
    });
  }

  if (dom.btnDownloadReportTxt) {
    dom.btnDownloadReportTxt.addEventListener('click', () => {
      downloadSimulationReportTxt();
    });
  }

  if (dom.btnDownloadReportPdf) {
    dom.btnDownloadReportPdf.addEventListener('click', () => {
      downloadSimulationReportPdf();
    });
  }

  // Conmutador de Tema: Hacker/Terminal (Oscuro) vs Technical/Blueprint (Claro Alto Contraste)
  if (dom.btnThemeToggle) {
    dom.btnThemeToggle.addEventListener('click', () => {
      const nextTheme = state.theme === 'blueprint' ? 'hacker' : 'blueprint';
      applyTheme(nextTheme, true);
      if (state.tutorialActive) {
        syncGuidedTutorialUI(false);
      }
    });
  }

  // Eventos del Modo Tutorial Guiado Paso a Paso
  if (dom.btnStartTutorial) {
    dom.btnStartTutorial.addEventListener('click', () => {
      if (state.tutorialActive) {
        stopGuidedTutorial();
      } else {
        startGuidedTutorial();
      }
    });
  }

  if (dom.btnTutorialClose) {
    dom.btnTutorialClose.addEventListener('click', () => {
      stopGuidedTutorial();
    });
  }

  if (dom.btnTutorialPrev) {
    dom.btnTutorialPrev.addEventListener('click', () => {
      if (state.tutorialStepIndex > 0) {
        goToTutorialStep(state.tutorialStepIndex - 1);
      }
    });
  }

  if (dom.btnTutorialNext) {
    dom.btnTutorialNext.addEventListener('click', () => {
      if (state.tutorialStepIndex < TUTORIAL_STEPS.length - 1) {
        goToTutorialStep(state.tutorialStepIndex + 1);
      } else {
        stopGuidedTutorial();
      }
    });
  }

  // Reposicionar el tooltip del tutorial al hacer scroll o redimensionar la ventana
  window.addEventListener(
    'scroll',
    () => {
      if (state.tutorialActive && currentHighlightedEl) {
        positionTutorialTooltip(currentHighlightedEl);
      }
    },
    { passive: true }
  );

  window.addEventListener('resize', () => {
    if (state.tutorialActive && currentHighlightedEl) {
      positionTutorialTooltip(currentHighlightedEl);
    }
  });

  // Eventos del Sistema S.M.A.R.T. de Alertas de Pre-fallo por Tiempo de Funcionamiento
  if (dom.btnTriggerPrefail) {
    dom.btnTriggerPrefail.addEventListener('click', () => {
      triggerSimulatedPrefailOnDisk();
    });
  }

  if (dom.btnToggleSmartAging) {
    dom.btnToggleSmartAging.addEventListener('click', () => {
      toggleSmartAutoAging();
    });
  }

  if (dom.inputSmartThreshold) {
    dom.inputSmartThreshold.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10) || 40000;
      state.smartPrefailThresholdHours = val;
      if (dom.displaySmartThreshold) {
        dom.displaySmartThreshold.textContent = `${val.toLocaleString('es-ES')} h`;
      }
      evaluateSmartPrefailAlerts(false);
      renderAll();
    });
  }

  // Permitir salir del tutorial o cerrar el modal con la tecla Escape, y avanzar con flechas
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.tutorialActive) {
        stopGuidedTutorial();
      }
      if (dom.reportExportModal && !dom.reportExportModal.classList.contains('hidden')) {
        closeReportExportModal();
      }
    }
  });
}

/**
 * ============================================================================
 * GENERADOR DE INFORME TÉCNICO DE SIMULACIÓN (TEXTO PLANO .TXT Y DOCUMENTO .PDF)
 * ============================================================================
 * Recopila el estado final del arreglo, parámetros físicos, cálculos de eficiencia,
 * telemetría IOPS, estado de cada bahía del servidor e historial de eventos.
 */
function buildSimulationReportPlainText() {
  const now = new Date();
  const timestamp = now.toLocaleString('es-ES');
  const spec = RAID_SPECS[state.raidLevel];
  const metrics = calculateCapacityMetrics();
  const iopsSnap =
    state.iopsHistory && state.iopsHistory.length > 0
      ? state.iopsHistory[state.iopsHistory.length - 1]
      : computeCurrentIopsSnapshot(0);

  const studentName =
    (dom.inputStudentName && dom.inputStudentName.value.trim()) || 'No especificado';
  const studentNotes =
    (dom.inputStudentNotes && dom.inputStudentNotes.value.trim()) ||
    'Sin observaciones adicionales';

  const statusHuman =
    state.volumeStatus === 'OPTIMO'
      ? 'ÓPTIMO (Operación Nominal)'
      : state.volumeStatus === 'DEGRADADO'
        ? 'DEGRADADO (Operando con Redundancia Activa)'
        : state.volumeStatus === 'RECONSTRUYENDO'
          ? `RECONSTRUYENDO (Rebuild en curso: ${state.rebuildProgress}%)`
          : 'FALLO CRÍTICO (Pérdida Irreversible de Datos)';

  const disksLines = state.disks
    .map((d) => {
      const sgInfo =
        d.subgroupIndex !== null
          ? ` [Subgrupo Espejo ${String.fromCharCode(65 + d.subgroupIndex)}]`
          : '';
      const prefailFlag = isDiskInPrefail(d);
      const stLabel =
        d.status === 'healthy'
          ? prefailFlag
            ? `ALERTA PRE-FALLO S.M.A.R.T. (${d.powerOnHours.toLocaleString('es-ES')} h)`
            : `OPERATIVO (${d.powerOnHours.toLocaleString('es-ES')} h)`
          : d.status === 'rebuilding'
            ? `RECONSTRUYENDO (${state.rebuildProgress}%)`
            : 'AVERIADO (OFFLINE)';
      const blocksStr = d.blocks.map((b) => b.label).join(' | ');
      return `  - ${d.id}${sgInfo}: ${state.diskSizeTB} TB -> Estado: ${stLabel} | Bloques: [${blocksStr}]`;
    })
    .join('\n');

  // Ordenar historial cronológicamente (del más antiguo al más reciente para lectura secuencial)
  const chronologicalLogs = [...state.logs].reverse();
  const logsLines =
    chronologicalLogs.length > 0
      ? chronologicalLogs
          .map((l, idx) => `  ${String(idx + 1).padStart(2, '0')}. [${l.time}] [${l.level.toUpperCase()}] ${l.message}`)
          .join('\n')
      : '  (Sin eventos registrados)';

  return [
    '================================================================================',
    '      UN FANTASMA EN EL SISTEMA · RAIDLAB — INFORME TÉCNICO DE SIMULACIÓN       ',
    '                     https://www.unfantasmaenelsistema.com/                     ',
    '================================================================================',
    `Fecha y Hora de Emisión : ${timestamp}`,
    `Estudiante / Grupo      : ${studentName}`,
    `Observaciones Práctica  : ${studentNotes}`,
    '--------------------------------------------------------------------------------',
    '1. CONFIGURACIÓN DEL ARREGLO Y ESTADO FINAL DEL VOLUMEN',
    '--------------------------------------------------------------------------------',
    `Nivel de RAID           : ${spec.name} (${spec.tag})`,
    `Unidades Físicas (N)    : ${metrics.N} discos instalados`,
    `Capacidad por Disco (S) : ${num(metrics.S, 1)} TB por unidad`,
    `ESTADO FINAL VOLUMEN    : ${statusHuman}`,
    `Diagnóstico Controlador : ${state.statusDetail}`,
    '--------------------------------------------------------------------------------',
    '2. CÁLCULOS DE CAPACIDAD, EFICIENCIA Y TOLERANCIA A FALLOS',
    '--------------------------------------------------------------------------------',
    `Capacidad Bruta Total   : ${num(metrics.rawTB, 2)} TB (${metrics.N} × ${metrics.S} TB)`,
    `Capacidad Útil Efectiva : ${state.volumeStatus === 'CRITICO' ? `0,00 TB (Inaccesible — Teórica: ${num(metrics.usableTB, 2)} TB)` : `${num(metrics.usableTB, 2)} TB`}`,
    `Capacidad Redundancia   : ${num(metrics.redundancyTB, 2)} TB (${num(metrics.redundancyPct, 1)}%)`,
    `Eficiencia de Almacén   : ${num(metrics.efficiencyPct, 1)}%`,
    `Tolerancia a Fallos     : ${metrics.faultToleranceLabel}`,
    `Fórmula Algebraica      : ${metrics.formulaEvaluated}`,
    `Fundamento Matemático   : ${spec.formulaNote}`,
    '--------------------------------------------------------------------------------',
    '3. TELEMETRÍA DE RENDIMIENTO I/O (IOPS SIMULADOS)',
    '--------------------------------------------------------------------------------',
    `Tasa Nominal Máxima     : ${iopsSnap.maxNominal.toLocaleString('es-ES')} IOPS`,
    `Tasa Actual Host (Útil) : ${iopsSnap.hostIops.toLocaleString('es-ES')} IOPS (${iopsSnap.pctOfNominal}% del nominal)`,
    `Tráfico Interno Rebuild : ${iopsSnap.rebuildIops.toLocaleString('es-ES')} IOPS`,
    '--------------------------------------------------------------------------------',
    '4. INVENTARIO Y ESTADO DE LAS BAHÍAS FÍSICAS DEL SERVIDOR',
    '--------------------------------------------------------------------------------',
    disksLines,
    '--------------------------------------------------------------------------------',
    '5. HISTORIAL CRONOLÓGICO DE EVENTOS (BITÁCORA DEL CONTROLADOR RAID)',
    '--------------------------------------------------------------------------------',
    logsLines,
    '================================================================================',
    'Fin del Informe · Un Fantasma en el Sistema (https://www.unfantasmaenelsistema.com/)',
    '================================================================================',
  ].join('\n');
}

function openReportExportModal() {
  if (!dom.reportExportModal) return;
  dom.reportPreviewText.textContent = buildSimulationReportPlainText();
  dom.reportExportModal.classList.remove('hidden');
  dom.reportExportModal.classList.add('flex');
}

function closeReportExportModal() {
  if (!dom.reportExportModal) return;
  dom.reportExportModal.classList.add('hidden');
  dom.reportExportModal.classList.remove('flex');
}

function downloadSimulationReportTxt() {
  const text = buildSimulationReportPlainText();
  const fileSlug = `informe-raid${state.raidLevel}-${state.diskCount}discos-${state.volumeStatus.toLowerCase()}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileSlug;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addControllerLog('ok', `Informe en texto plano (${fileSlug}) descargado correctamente.`);
}

function downloadSimulationReportPdf() {
  {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const reportLines = textoParaPdf(buildSimulationReportPlainText()).split('\n');

    // Encabezado técnico oscuro en la primera página
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 210, 24, 'F');
    doc.setFont('courier', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(16, 185, 129);
    doc.text('RAIDLAB SYSTEMS — INFORME DE SIMULACION DE ARREGLO RAID', 12, 11);
    doc.setFontSize(8.5);
    doc.setTextColor(203, 213, 225);
    doc.text(
      `Nivel: ${RAID_SPECS[state.raidLevel].name} | Discos: ${state.diskCount} x ${state.diskSizeTB} TB | Estado: ${state.volumeStatus}`,
      12,
      18
    );

    // Cuerpo monoespaciado con paginación automática
    doc.setFont('courier', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(20, 25, 35);

    let y = 32;
    const lineHeight = 4.4;
    const pageHeight = 282;

    reportLines.forEach((rawLine) => {
      const wrapped = doc.splitTextToSize(rawLine, 186);
      wrapped.forEach((line) => {
        if (y > pageHeight) {
          doc.addPage();
          y = 16;
        }
        if (
          line.startsWith('1. ') ||
          line.startsWith('2. ') ||
          line.startsWith('3. ') ||
          line.startsWith('4. ') ||
          line.startsWith('5. ')
        ) {
          doc.setFont('courier', 'bold');
          doc.text(line, 12, y);
          doc.setFont('courier', 'normal');
        } else {
          doc.text(line, 12, y);
        }
        y += lineHeight;
      });
    });

    const pdfName = `informe-raid${state.raidLevel}-${state.diskCount}discos-${state.volumeStatus.toLowerCase()}.pdf`;
    doc.save(pdfName);
    addControllerLog('ok', `Informe PDF (${pdfName}) generado y descargado correctamente.`);
  }
}

// Inicialización al cargar el documento
document.addEventListener('DOMContentLoaded', () => {
  bindEventListeners();
  let savedTheme = 'hacker';
  try {
    const guardado = localStorage.getItem('raidlab-theme');
    if (guardado === 'blueprint' || (!guardado && window.matchMedia('(prefers-color-scheme: light)').matches)) {
      savedTheme = 'blueprint';
    }
  } catch (e) {
    // Ignorar restricciones de almacenamiento
  }
  createArray();
  // Una muestra de IOPS por segundo para que el eje temporal del gráfico sea real
  setInterval(() => {
    recordIopsSample();
    renderD3IopsLineChart();
  }, 1000);
  if (savedTheme === 'blueprint') {
    applyTheme('blueprint', false);
  }
});
