const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("status");

const dbValue = document.getElementById("dbValue");
const dbaValue = document.getElementById("dbaValue");
const avgDbText = document.getElementById("avgDb");
const maxDbText = document.getElementById("maxDb");
const minDbText = document.getElementById("minDb");

const dbTrendCanvas = document.getElementById("dbTrendCanvas");
const dbTrendCtx = dbTrendCanvas.getContext("2d");

const spectrogramCanvas = document.getElementById("spectrogramCanvas");
const spectrogramCtx = spectrogramCanvas.getContext("2d");

let audioContext = null;
let analyser = null;
let microphone = null;
let timeDataArray = null;
let frequencyDataArray = null;
let animationId = null;
let stream = null;

let smoothedDb = 0;
let smoothedDba = 0;

let maxDb = -Infinity;
let minDb = Infinity;
let totalDb = 0;
let sampleCount = 0;

let dbHistory = [];
let lastTrendTime = 0;
let lastSpectrogramTime = 0;

const CALIBRATION_OFFSET = 100;
const A_WEIGHTING_OFFSET = 100;

const SMOOTHING = 0.85;

const DB_TREND_INTERVAL = 100;
const DB_TREND_MIN = 0;
const DB_TREND_MAX = 120;

const SPECTROGRAM_INTERVAL = 50;
const SPECTROGRAM_MAX_FREQ = 8000;

const OCTAVE_BANDS = [
  31.5,
  63,
  125,
  250,
  500,
  1000,
  2000,
  4000,
  8000
];

clearDbTrend();
clearSpectrogram();

startBtn.addEventListener("click", async () => {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusText.textContent = "此瀏覽器不支援麥克風功能";
      return;
    }

    statusText.textContent = "正在要求麥克風權限...";

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.75;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;

    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    timeDataArray = new Float32Array(analyser.fftSize);
    frequencyDataArray = new Float32Array(analyser.frequencyBinCount);

    resetStatistics();
    resetOctaveBars();
    clearDbTrend();
    clearSpectrogram();

    startBtn.disabled = true;
    stopBtn.disabled = false;

    statusText.textContent = "量測中";

    lastTrendTime = performance.now();
    lastSpectrogramTime = performance.now();

    updateMeasurement();

  } catch (error) {
    console.error(error);
    statusText.textContent = "麥克風啟動失敗，請確認瀏覽器有允許麥克風權限";
    stopMeasurement();
  }
});

stopBtn.addEventListener("click", () => {
  stopMeasurement();
});

function updateMeasurement() {
  if (!analyser || !timeDataArray || !frequencyDataArray) {
    return;
  }

  analyser.getFloatTimeDomainData(timeDataArray);
  analyser.getFloatFrequencyData(frequencyDataArray);

  const db = calculateDbFromTimeData(timeDataArray);
  const dba = calculateAWeightedDb();

  if (smoothedDb === 0) {
    smoothedDb = db;
  } else {
    smoothedDb = smoothedDb * SMOOTHING + db * (1 - SMOOTHING);
  }

  if (smoothedDba === 0) {
    smoothedDba = dba;
  } else {
    smoothedDba = smoothedDba * SMOOTHING + dba * (1 - SMOOTHING);
  }

  updateStatistics(smoothedDb);
  updateDbDisplay(smoothedDb, smoothedDba);
  updateOctaveBands();

  const now = performance.now();

  if (now - lastTrendTime >= DB_TREND_INTERVAL) {
    updateDbTrend(smoothedDb);
    lastTrendTime = now;
  }

  if (now - lastSpectrogramTime >= SPECTROGRAM_INTERVAL) {
    updateSpectrogram();
    lastSpectrogramTime = now;
  }

  animationId = requestAnimationFrame(updateMeasurement);
}

function calculateDbFromTimeData(dataArray) {
  let sum = 0;

  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }

  const rms = Math.sqrt(sum / dataArray.length);

  let db = 20 * Math.log10(rms) + CALIBRATION_OFFSET;

  if (!isFinite(db)) {
    db = 0;
  }

  return Math.max(0, db);
}

function calculateAWeightedDb() {
  if (!audioContext || !frequencyDataArray) {
    return 0;
  }

  const sampleRate = audioContext.sampleRate;
  const nyquist = sampleRate / 2;
  const binCount = frequencyDataArray.length;

  let weightedEnergySum = 0;
  let validCount = 0;

  for (let i = 1; i < binCount; i++) {
    const freq = (i * nyquist) / binCount;

    if (freq < 20 || freq > 20000) {
      continue;
    }

    const rawDb = frequencyDataArray[i];

    if (!isFinite(rawDb)) {
      continue;
    }

    const aCorrection = getAWeightingCorrection(freq);
    const weightedDb = rawDb + aCorrection;
    const linearEnergy = Math.pow(10, weightedDb / 10);

    weightedEnergySum += linearEnergy;
    validCount++;
  }

  if (validCount === 0 || weightedEnergySum <= 0) {
    return 0;
  }

  const weightedDbFs = 10 * Math.log10(weightedEnergySum / validCount);

  let dba = weightedDbFs + A_WEIGHTING_OFFSET;

  if (!isFinite(dba)) {
    dba = 0;
  }

  return Math.max(0, dba);
}

function getAWeightingCorrection(freq) {
  const f2 = freq * freq;

  const raNumerator = Math.pow(12200, 2) * Math.pow(f2, 2);

  const raDenominator =
    (f2 + Math.pow(20.6, 2)) *
    Math.sqrt((f2 + Math.pow(107.7, 2)) * (f2 + Math.pow(737.9, 2))) *
    (f2 + Math.pow(12200, 2));

  const ra = raNumerator / raDenominator;
  const a = 20 * Math.log10(ra) + 2.0;

  if (!isFinite(a)) {
    return 0;
  }

  return a;
}

function updateStatistics(db) {
  sampleCount++;
  totalDb += db;

  if (db > maxDb) {
    maxDb = db;
  }

  if (db < minDb) {
    minDb = db;
  }
}

function updateDbDisplay(db, dba) {
  const avgDb = totalDb / sampleCount;

  dbValue.textContent = `${db.toFixed(1)} dB`;
  dbaValue.textContent = `${dba.toFixed(1)} dB(A)`;
  avgDbText.textContent = avgDb.toFixed(1);
  maxDbText.textContent = maxDb.toFixed(1);
  minDbText.textContent = minDb.toFixed(1);
}

function updateDbTrend(db) {
  dbHistory.push(db);

  const maxPoints = dbTrendCanvas.width;

  if (dbHistory.length > maxPoints) {
    dbHistory.shift();
  }

  drawDbTrend();
}

function drawDbTrend() {
  const width = dbTrendCanvas.width;
  const height = dbTrendCanvas.height;

  dbTrendCtx.fillStyle = "#020617";
  dbTrendCtx.fillRect(0, 0, width, height);

  drawTrendGrid(width, height);

  if (dbHistory.length < 2) {
    return;
  }

  dbTrendCtx.beginPath();
  dbTrendCtx.strokeStyle = "#ef4444";
  dbTrendCtx.lineWidth = 2;

  for (let i = 0; i < dbHistory.length; i++) {
    const db = Math.max(DB_TREND_MIN, Math.min(DB_TREND_MAX, dbHistory[i]));

    const x = (i / (dbHistory.length - 1)) * width;
    const y = height - ((db - DB_TREND_MIN) / (DB_TREND_MAX - DB_TREND_MIN)) * height;

    if (i === 0) {
      dbTrendCtx.moveTo(x, y);
    } else {
      dbTrendCtx.lineTo(x, y);
    }
  }

  dbTrendCtx.stroke();
}

function drawTrendGrid(width, height) {
  dbTrendCtx.strokeStyle = "#334155";
  dbTrendCtx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = (height / 4) * i;
    dbTrendCtx.beginPath();
    dbTrendCtx.moveTo(0, y);
    dbTrendCtx.lineTo(width, y);
    dbTrendCtx.stroke();
  }

  for (let i = 0; i <= 4; i++) {
    const x = (width / 4) * i;
    dbTrendCtx.beginPath();
    dbTrendCtx.moveTo(x, 0);
    dbTrendCtx.lineTo(x, height);
    dbTrendCtx.stroke();
  }
}

function clearDbTrend() {
  dbHistory = [];
  const width = dbTrendCanvas.width;
  const height = dbTrendCanvas.height;

  dbTrendCtx.fillStyle = "#020617";
  dbTrendCtx.fillRect(0, 0, width, height);
  drawTrendGrid(width, height);
}

function updateOctaveBands() {
  const sampleRate = audioContext.sampleRate;
  const binCount = frequencyDataArray.length;
  const nyquist = sampleRate / 2;

  for (const centerFreq of OCTAVE_BANDS) {
    const lowerFreq = centerFreq / Math.sqrt(2);
    const upperFreq = centerFreq * Math.sqrt(2);

    let energySum = 0;
    let count = 0;

    for (let i = 0; i < binCount; i++) {
      const freq = (i * nyquist) / binCount;

      if (freq >= lowerFreq && freq < upperFreq) {
        const valueDb = frequencyDataArray[i];

        if (isFinite(valueDb)) {
          const linearEnergy = Math.pow(10, valueDb / 10);
          energySum += linearEnergy;
          count++;
        }
      }
    }

    let bandDb = -100;

    if (count > 0 && energySum > 0) {
      bandDb = 10 * Math.log10(energySum / count);
    }

    let percent = ((bandDb + 100) / 80) * 100;
    percent = Math.max(0, Math.min(100, percent));

    const bar = document.querySelector(`.bar[data-band="${centerFreq}"]`);
    const text = document.getElementById(`band-${centerFreq}`);

    if (bar) {
      bar.style.width = `${percent}%`;
    }

    if (text) {
      text.textContent = `${Math.round(percent)}%`;
    }
  }
}

function updateSpectrogram() {
  const width = spectrogramCanvas.width;
  const height = spectrogramCanvas.height;

  const oldImage = spectrogramCtx.getImageData(1, 0, width - 1, height);
  spectrogramCtx.putImageData(oldImage, 0, 0);

  const sampleRate = audioContext.sampleRate;
  const nyquist = sampleRate / 2;
  const binCount = frequencyDataArray.length;

  for (let y = 0; y < height; y++) {
    const freqRatio = 1 - y / height;
    const freq = freqRatio * SPECTROGRAM_MAX_FREQ;

    const binIndex = Math.floor((freq / nyquist) * binCount);
    const safeIndex = Math.max(0, Math.min(binCount - 1, binIndex));

    const valueDb = frequencyDataArray[safeIndex];

    let intensity = (valueDb - analyser.minDecibels) / (analyser.maxDecibels - analyser.minDecibels);
    intensity = Math.max(0, Math.min(1, intensity));

    const color = getHeatColor(intensity);

    spectrogramCtx.fillStyle = color;
    spectrogramCtx.fillRect(width - 1, y, 1, 1);
  }
}

function getHeatColor(value) {
  const v = Math.max(0, Math.min(1, value));

  let r = 0;
  let g = 0;
  let b = 0;

  if (v < 0.25) {
    r = 0;
    g = Math.round(80 * (v / 0.25));
    b = 120;
  } else if (v < 0.5) {
    r = 0;
    g = 120 + Math.round(135 * ((v - 0.25) / 0.25));
    b = 120 - Math.round(120 * ((v - 0.25) / 0.25));
  } else if (v < 0.75) {
    r = Math.round(255 * ((v - 0.5) / 0.25));
    g = 255;
    b = 0;
  } else {
    r = 255;
    g = 255 - Math.round(180 * ((v - 0.75) / 0.25));
    b = Math.round(180 * ((v - 0.75) / 0.25));
  }

  return `rgb(${r}, ${g}, ${b})`;
}

function clearSpectrogram() {
  if (!spectrogramCtx) {
    return;
  }

  spectrogramCtx.fillStyle = "#020617";
  spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
}

function resetStatistics() {
  smoothedDb = 0;
  smoothedDba = 0;

  maxDb = -Infinity;
  minDb = Infinity;
  totalDb = 0;
  sampleCount = 0;

  dbValue.textContent = "-- dB";
  dbaValue.textContent = "-- dB(A)";
  avgDbText.textContent = "--";
  maxDbText.textContent = "--";
  minDbText.textContent = "--";
}

function resetOctaveBars() {
  for (const centerFreq of OCTAVE_BANDS) {
    const bar = document.querySelector(`.bar[data-band="${centerFreq}"]`);
    const text = document.getElementById(`band-${centerFreq}`);

    if (bar) {
      bar.style.width = "0%";
    }

    if (text) {
      text.textContent = "--";
    }
  }
}

function stopMeasurement() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  microphone = null;
  timeDataArray = null;
  frequencyDataArray = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  statusText.textContent = "已停止量測";
  dbValue.textContent = "-- dB";
  dbaValue.textContent = "-- dB(A)";

  resetOctaveBars();
  clearDbTrend();
  clearSpectrogram();
}