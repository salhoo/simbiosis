const PH_MIN = 0;
const PH_MAX = 14;
const NEUTRAL_PH = 7;
const SERIAL_BAUD = 9600;
const VIDEO_W = 640;
const VIDEO_H = 480;
const CAMERA_STORAGE_KEY = "arduino-ph-camera-id";
const PROCESS_SCALE = 0.56;
const PROCESS_W = Math.floor(VIDEO_W * PROCESS_SCALE);
const PROCESS_H = Math.floor(VIDEO_H * PROCESS_SCALE);
const GRID_STEP = 1;
const NOISE_SCALE = 0.014;
const CHAOS_MAX = 4;
const PH_SMOOTHING = 0.08;
const PIXEL_SAMPLE_EVERY = 2;
const FOREGROUND_THRESHOLD = 0.19;
const FOREGROUND_STRONG_THRESHOLD = 0.5;
const DEPTH_STRENGTH = 72;
const BODY_FILL_STRENGTH = 2.0;
const BODY_NEIGHBOR_BLEND = 0.55;
const BODY_COHERENCE_BOOST = 0.32;
const BODY_DIAGONAL_BLEND = 0.7;
const BODY_MIN_COHERENCE = 0.24;
const BODY_ISOLATION_REJECTION = 0.28;
const EDGE_STRENGTH = 0.18;
const MOTION_STRENGTH = 0.12;
const BACKGROUND_WARMUP_FRAMES = 45;
const BACKGROUND_LEARN_RATE = 0.08;
const BACKGROUND_HOLD_THRESHOLD = 0.035;

let capture;
let captureReady = false;
let bootMessageEl;
let bootStatusEl;
let cameraSelectEl;
let startButtonEl;
let refreshButtonEl;
let processBuffer;
let processPixels = null;
let pointGrid = [];
let brightnessCache = null;
let drawW = 0;
let drawH = 0;
let backgroundBrightness = null;
let backgroundWarmupFrame = 0;
let backgroundReady = false;
let bgLayer;
let activeCameraLabel = "";
let availableCameras = [];

const PH_COLORS = [
  [175, 1, 2],
  [224, 0, 0],
  [253, 1, 0],
  [255, 125, 5],
  [251, 174, 58],
  [255, 219, 1],
  [202, 222, 101],
  [169, 202, 1],
  [1, 171, 0],
  [63, 130, 93],
  [157, 227, 237],
  [11, 175, 210],
  [74, 114, 186],
  [97, 63, 150]
];

let currentPh = NEUTRAL_PH;
let targetPh = NEUTRAL_PH;
let lastPhUpdateMs = 0;

let serialPort = null;
let serialReader = null;
let serialBuffer = "";
let serialReconnectTimer = null;
let serialOpening = false;
let serialClosing = false;
let authorizedPorts = [];

let startInProgress = false;
let startupComplete = false;

const textDecoder = new TextDecoder();

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  frameRate(30);
  noFill();
  strokeCap(ROUND);
  processBuffer = createGraphics(PROCESS_W, PROCESS_H);
  processBuffer.pixelDensity(1);
  backgroundBrightness = new Float32Array(PROCESS_W * PROCESS_H);
  brightnessCache = new Float32Array(PROCESS_W * PROCESS_H);
  updateDrawMetrics();
  bgLayer = createGraphics(width, height);
  rebuildPointGrid();

  bootMessageEl = document.getElementById("boot-message");
  bootStatusEl = document.getElementById("boot-status");
  cameraSelectEl = document.getElementById("camera-select");
  startButtonEl = document.getElementById("start-system");
  refreshButtonEl = document.getElementById("refresh-cameras");

  initializeBootUi();
  registerSerialListeners();
  void prepareAuthorizedPorts();
}

function draw() {
  currentPh = lerp(currentPh, targetPh, PH_SMOOTHING);

  if (!captureReady) {
    return;
  }

  const chaosNorm = pow(constrain(map(currentPh, PH_MIN, PH_MAX, 1, 0), 0, 1), 2.0);

  const bgBlur = map(chaosNorm, 0, 1, 2, 20);
  const bgAlpha = map(chaosNorm, 0, 1, 220, 0);

  bgLayer.push();
  bgLayer.translate(width, 0);
  bgLayer.scale(-1, 1);
  bgLayer.image(capture, 0, 0, width, height);
  bgLayer.pop();
  bgLayer.filter(BLUR, bgBlur);
  push();
  translate(-width / 2, -height / 2);
  tint(255, bgAlpha);
  image(bgLayer, 0, 0, width, height);
  noTint();
  pop();

  refreshProcessFrame();
  if (!processPixels) {
    return;
  }

  updateBackgroundModel();
  if (!backgroundReady) {
    return;
  }

  const chaosAmplitude = lerp(0, CHAOS_MAX, chaosNorm);
  const noiseDrift = lerp(0.12, 0.65, chaosNorm);

  const now = millis() * 0.001;
  const timeA = now * noiseDrift;
  const timeB = now * (noiseDrift * 0.82 + 0.05) + 12.0;
  const timeC = now * 1.2;

  const pulseFrequency = lerp(1.0, 12.0, chaosNorm);
  const pulseSignal = (sin(now * pulseFrequency) + 1) / 2;
  const pulseWeight = lerp(0, 2.5, chaosNorm) * pulseSignal;
  const pointWeight = lerp(3.1, 4.8, chaosNorm) + pulseWeight;

  strokeWeight(pointWeight);
  beginShape(POINTS);

  for (const pointData of pointGrid) {
    let pointState;
    if (frameCount % PIXEL_SAMPLE_EVERY === 0) {
      pointState = getPointState(pointData);
      pointData.lastState = pointState; // Guardar el estado para el siguiente frame.
    } else {
      pointState = pointData.lastState; // Reutilizar el estado del frame anterior.
    }
    if (pointState.fillBody <= 0.01) {
      continue;
    }

    const { fillBody, alpha, depth } = pointState;

    const noiseA = noise(pointData.noiseX, pointData.noiseY, timeA) - 0.5;
    const noiseB = noise(pointData.noiseX + 19.4, pointData.noiseY + 11.2, timeB) - 0.5;
    const noiseC = noise(pointData.noiseX - 25.1, pointData.noiseY + 33.7, timeC) - 0.5;

    const chaosFactor = lerp(0.1, 1.0, fillBody);
    const offsetX = (noiseA * 1.15 + noiseB * 0.45 + noiseC * 0.35) * chaosAmplitude * chaosFactor * 0.8;
    const offsetY = (noiseB * 1.05 - noiseA * 0.35 + noiseC * 0.45) * chaosAmplitude * chaosFactor * 0.8;
    const offsetZ = (noiseA + noiseB) * chaosAmplitude * 0.32 * chaosFactor;

    const phClamped = constrain(currentPh, 1, PH_COLORS.length);
    const index1 = constrain(floor(phClamped) - 1, 0, PH_COLORS.length - 1);
    const index2 = constrain(ceil(phClamped) - 1, 0, PH_COLORS.length - 1);
    const lerpAmt = phClamped - floor(phClamped);
    const r = lerp(PH_COLORS[index1][0], PH_COLORS[index2][0], lerpAmt);
    const g = lerp(PH_COLORS[index1][1], PH_COLORS[index2][1], lerpAmt);
    const b = lerp(PH_COLORS[index1][2], PH_COLORS[index2][2], lerpAmt);

    const pulseBrightness = lerp(0, 80, chaosNorm) * pulseSignal;

    stroke(
      constrain(r + pulseBrightness, 0, 255),
      constrain(g + pulseBrightness, 0, 255),
      constrain(b + pulseBrightness, 0, 255),
      alpha
    );
    vertex(pointData.baseX + offsetX, pointData.baseY + offsetY, depth + offsetZ);
  }
  endShape();

  if (serialPort && millis() - lastPhUpdateMs > 5000) {
    targetPh = lerp(targetPh, NEUTRAL_PH, 0.01);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  updateDrawMetrics();
  bgLayer.resize(width, height);
  rebuildPointGrid();
}

function initializeBootUi() {
  refreshButtonEl?.addEventListener("click", () => {
    void loadCameraOptions({ requestPermission: true });
  });

  startButtonEl?.addEventListener("click", () => {
    void beginExperience();
  });

  cameraSelectEl?.addEventListener("change", () => {
    const selectedCameraId = cameraSelectEl.value;
    if (selectedCameraId) {
      localStorage.setItem(CAMERA_STORAGE_KEY, selectedCameraId);
      const selectedCamera = availableCameras.find((camera) => camera.deviceId === selectedCameraId);
      if (selectedCamera?.label) {
        setBootMessage(`Camara seleccionada: ${selectedCamera.label}`);
      }
    }
  });

  if (startButtonEl) {
    startButtonEl.disabled = true;
  }
}

function registerSerialListeners() {
  if (!("serial" in navigator)) {
    console.info("Web Serial no esta disponible. La visual iniciara sin pH en vivo.");
    return;
  }

  navigator.serial.addEventListener("disconnect", () => {
    void handleSerialDisconnect();
  });
}

async function prepareAuthorizedPorts() {
  if (!("serial" in navigator)) {
    return;
  }

  try {
    authorizedPorts = await navigator.serial.getPorts();
    if (authorizedPorts.length > 0) {
      await openSerialPort(authorizedPorts[0]);
      if (!captureReady) {
        setBootMessage("Camara lista. Se encontro un serial autorizado y se conectara solo al iniciar.");
      }
    }
  } catch (error) {
    console.warn("No se pudieron leer los puertos autorizados.", error);
  }
}

async function beginExperience() {
  if (startInProgress) {
    return;
  }

  if (startupComplete && captureReady && serialPort) {
    return;
  }

  startInProgress = true;

  try {
    if (!captureReady) {
      await setupCamera();
    }

    await tryAutoConnectSerial();

    startupComplete = true;
    hideBootMessage();
  } catch (error) {
    const message = formatStartError(error);
    setBootMessage(message);
    console.error(error);
  } finally {
    startInProgress = false;
  }
}

function formatStartError(error) {
  if (!error) {
    return "No se pudo iniciar. Haz clic para reintentar.";
  }

  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Permiso denegado. Da acceso a la camara y vuelve a intentar.";
  }

  return error.message || "No se pudo iniciar. Haz clic para reintentar.";
}

async function setupCamera() {
  if (captureReady) {
    return;
  }

  const videoConstraints = await getSelectedVideoConstraints();

  capture = await new Promise((resolve, reject) => {
    const video = createCapture(
      {
        audio: false,
        video: videoConstraints
      },
      () => resolve(video)
    );

    video.elt.addEventListener(
      "error",
      () => reject(new Error("No se pudo acceder a la camara.")),
      { once: true }
    );
  });

  capture.size(VIDEO_W, VIDEO_H);
  capture.hide();
  resetBackgroundModel();
  captureReady = true;
}

async function getSelectedVideoConstraints() {
  const fallbackConstraints = {
    width: { ideal: VIDEO_W },
    height: { ideal: VIDEO_H },
    frameRate: { ideal: 30, max: 30 }
  };

  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    activeCameraLabel = "default";
    return fallbackConstraints;
  }

  if (!availableCameras.length) {
    await loadCameraOptions({ requestPermission: true });
  }

  const savedCameraId = cameraSelectEl?.value || localStorage.getItem(CAMERA_STORAGE_KEY) || "";
  const selectedCamera = availableCameras.find((device) => device.deviceId === savedCameraId) || availableCameras[0];

  if (selectedCamera) {
    activeCameraLabel = selectedCamera.label || "Camara seleccionada";
    localStorage.setItem(CAMERA_STORAGE_KEY, selectedCamera.deviceId);
    return {
      ...fallbackConstraints,
      deviceId: { exact: selectedCamera.deviceId }
    };
  }

  activeCameraLabel = "default";
  return fallbackConstraints;
}

async function loadCameraOptions({ requestPermission } = { requestPermission: true }) {
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    setBootMessage("Este navegador no permite elegir camaras.");
    return;
  }

  let tempStream = null;

  try {
    if (requestPermission) {
      tempStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    availableCameras = devices.filter((device) => device.kind === "videoinput");
    populateCameraSelect();

    if (!availableCameras.length) {
      setBootMessage("No se encontraron camaras disponibles.");
      return;
    }

    setBootMessage("Camara lista. Elige una opcion y pulsa Iniciar visual.");
  } catch (error) {
    console.error(error);
    setBootMessage("No se pudieron cargar las camaras. Revisa permisos y vuelve a intentar.");
  } finally {
    if (tempStream) {
      for (const track of tempStream.getTracks()) {
        track.stop();
      }
    }
  }
}

function populateCameraSelect() {
  if (!cameraSelectEl) {
    return;
  }

  const savedCameraId = localStorage.getItem(CAMERA_STORAGE_KEY) || "";
  cameraSelectEl.innerHTML = "";

  for (let index = 0; index < availableCameras.length; index += 1) {
    const camera = availableCameras[index];
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camara ${index + 1}`;
    cameraSelectEl.appendChild(option);
  }

  if (!availableCameras.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No se encontraron camaras";
    cameraSelectEl.appendChild(option);
    cameraSelectEl.disabled = true;
    if (startButtonEl) {
      startButtonEl.disabled = true;
    }
    return;
  }

  const savedCameraExists = availableCameras.some((camera) => camera.deviceId === savedCameraId);
  cameraSelectEl.value = savedCameraExists ? savedCameraId : availableCameras[0].deviceId;
  cameraSelectEl.disabled = false;
  if (startButtonEl) {
    startButtonEl.disabled = false;
  }
}

function refreshProcessFrame() {
  if (frameCount % PIXEL_SAMPLE_EVERY !== 0 && processPixels) {
    return;
  }

  processBuffer.push();
  processBuffer.translate(PROCESS_W, 0);
  processBuffer.scale(-1, 1);
  processBuffer.image(capture, 0, 0, PROCESS_W, PROCESS_H);
  processBuffer.pop();
  processBuffer.loadPixels();

  if (processBuffer.pixels.length) {
    processPixels = processBuffer.pixels;
  }
}

function updateDrawMetrics() {
  const drawScale = max(width / PROCESS_W, height / PROCESS_H); // Usar 'max' para cubrir toda la pantalla
  drawW = PROCESS_W * drawScale;
  drawH = PROCESS_H * drawScale;
}

function rebuildPointGrid() {
  pointGrid = [];

  for (let y = 0; y < PROCESS_H; y += GRID_STEP) {
    const py = (y / (PROCESS_H - 1) - 0.5) * drawH;

    for (let x = 0; x < PROCESS_W; x += GRID_STEP) {
      const px = (x / (PROCESS_W - 1) - 0.5) * drawW;
      const pixelNumber = x + y * PROCESS_W;
      pointGrid.push({
        pixelNumber,
        pixelIndex: pixelNumber * 4,
        leftPixelNumber: max(x - GRID_STEP, 0) + y * PROCESS_W,
        upPixelNumber: x + max(y - GRID_STEP, 0) * PROCESS_W,
        upLeftPixelNumber: max(x - GRID_STEP, 0) + max(y - GRID_STEP, 0) * PROCESS_W,
        upRightPixelNumber: min(x + GRID_STEP, PROCESS_W - 1) + max(y - GRID_STEP, 0) * PROCESS_W,
        rightPixelNumber: min(x + GRID_STEP, PROCESS_W - 1) + y * PROCESS_W,
        downPixelNumber: x + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W,
        downLeftPixelNumber: max(x - GRID_STEP, 0) + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W,
        downRightPixelNumber: min(x + GRID_STEP, PROCESS_W - 1) + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W,
        leftIndex: (max(x - GRID_STEP, 0) + y * PROCESS_W) * 4,
        upIndex: (x + max(y - GRID_STEP, 0) * PROCESS_W) * 4,
        upLeftIndex: (max(x - GRID_STEP, 0) + max(y - GRID_STEP, 0) * PROCESS_W) * 4,
        upRightIndex: (min(x + GRID_STEP, PROCESS_W - 1) + max(y - GRID_STEP, 0) * PROCESS_W) * 4,
        rightIndex: ((min(x + GRID_STEP, PROCESS_W - 1)) + y * PROCESS_W) * 4,
        downIndex: (x + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W) * 4,
        downLeftIndex: (max(x - GRID_STEP, 0) + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W) * 4,
        downRightIndex: (min(x + GRID_STEP, PROCESS_W - 1) + min(y + GRID_STEP, PROCESS_H - 1) * PROCESS_W) * 4,
        baseX: px,
        baseY: py,
        noiseX: x * NOISE_SCALE,
        noiseY: y * NOISE_SCALE,
        lastState: { fillBody: 0, alpha: 0, depth: 0 },
        lastBrightness: 0,
        skipOdd: ((x / GRID_STEP + y / GRID_STEP) & 1) === 1
      });
    }
  }
}

function updateBackgroundModel() {
  if (frameCount % PIXEL_SAMPLE_EVERY === 0) {
    for (let i = 0; i < processPixels.length / 4; i++) {
      const pixelIndex = i * 4;
      brightnessCache[i] =
        processPixels[pixelIndex] * 0.299 +
        processPixels[pixelIndex + 1] * 0.587 +
        processPixels[pixelIndex + 2] * 0.114;
    }
  }

  for (let i = 0; i < backgroundBrightness.length; i++) {
    const brightness = brightnessCache[i];
    if (isNaN(brightness)) continue;

    if (!backgroundReady) {
      const current = backgroundBrightness[i];
      backgroundBrightness[i] = current === 0
        ? brightness
        : lerp(current, brightness, 0.25);
      continue;
    }

    let learnRate = BACKGROUND_LEARN_RATE * 0.1;

    const foregroundSignal = abs(brightness - backgroundBrightness[i]) / 255;
    if (foregroundSignal < BACKGROUND_HOLD_THRESHOLD) {
      learnRate = BACKGROUND_LEARN_RATE;
    }
    backgroundBrightness[i] = lerp(backgroundBrightness[i], brightness, learnRate);
  }

  if (!backgroundReady) {
    backgroundWarmupFrame += 1;
    if (backgroundWarmupFrame >= BACKGROUND_WARMUP_FRAMES) {
      backgroundReady = true;
    }
  }
}

function resetBackgroundModel() {
  backgroundBrightness = new Float32Array(PROCESS_W * PROCESS_H);
  backgroundWarmupFrame = 0;
  backgroundReady = false;
}

async function openSerialPort(port) {
  if (serialPort || serialOpening) {
    return;
  }

  serialOpening = true;

  try {
    await port.open({ baudRate: SERIAL_BAUD });
    serialPort = port;
    serialBuffer = "";
    hideBootMessage();
    clearReconnectTimer();
    void readSerialLoop(port);
  } finally {
    serialOpening = false;
  }
}

async function readSerialLoop(port) {
  try {
    serialReader = port.readable.getReader();

    while (true) {
      const { value, done } = await serialReader.read();
      if (done) {
        break;
      }

      if (value) {
        handleSerialChunk(textDecoder.decode(value, { stream: true }));
      }
    }
  } catch (error) {
    if (!serialClosing) {
      console.warn("La lectura serial termino de forma inesperada.", error);
    }
  } finally {
    if (serialReader) {
      try {
        serialReader.releaseLock();
      } catch (error) {
        console.warn("No se pudo liberar el reader serial.", error);
      }
      serialReader = null;
    }

    if (serialPort === port) {
      serialPort = null;
    }

    try {
      await port.close();
    } catch (error) {
      if (!serialClosing) {
        console.warn("No se pudo cerrar el puerto serial.", error);
      }
    }

    if (!serialClosing) {
      await handleSerialDisconnect();
    }

    serialClosing = false;
  }
}

function handleSerialChunk(chunk) {
  serialBuffer += chunk;
  const lines = serialBuffer.split(/\r?\n/);
  serialBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      continue;
    }

    if (parsed < PH_MIN || parsed > PH_MAX) {
      continue;
    }

    targetPh = parsed;
    lastPhUpdateMs = millis();
  }
}

async function handleSerialDisconnect() {
  if (serialOpening) {
    return;
  }

  await prepareAuthorizedPorts();

  if (!serialPort) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (serialReconnectTimer !== null) {
    return;
  }

  serialReconnectTimer = window.setInterval(async () => {
    if (serialPort || serialOpening) {
      clearReconnectTimer();
      return;
    }

    try {
      authorizedPorts = await navigator.serial.getPorts();
      if (authorizedPorts.length > 0) {
        await openSerialPort(authorizedPorts[0]);
      }
    } catch (error) {
      console.warn("No se pudo reintentar la conexion serial.", error);
    }
  }, 2500);
}

async function tryAutoConnectSerial() {
  if (serialPort || serialOpening || !("serial" in navigator)) {
    return;
  }

  try {
    authorizedPorts = await navigator.serial.getPorts();
    if (authorizedPorts.length > 0) {
      await openSerialPort(authorizedPorts[0]);
    } else {
      console.info("No hay puertos seriales autorizados. La visual usara pH neutro hasta que exista uno.");
    }
  } catch (error) {
    console.warn("No se pudo intentar la conexion serial automatica.", error);
  }
}

function clearReconnectTimer() {
  if (serialReconnectTimer !== null) {
    window.clearInterval(serialReconnectTimer);
    serialReconnectTimer = null;
  }
}

function hideBootMessage() {
  document.body.classList.add("running");
}

function setBootMessage(message) {
  if (bootStatusEl) {
    bootStatusEl.textContent = message;
  }
  document.body.classList.remove("running");
}

function getPointState(pointData) {
  const brightness = brightnessCache[pointData.pixelNumber];
  const bgBrightness = backgroundBrightness[pointData.pixelNumber];

  const leftBrightness = brightnessCache[pointData.leftPixelNumber];
  const rightBrightness = brightnessCache[pointData.rightPixelNumber];
  const upBrightness = brightnessCache[pointData.upPixelNumber];
  const downBrightness = brightnessCache[pointData.downPixelNumber];
  const upLeftBrightness = brightnessCache[pointData.upLeftPixelNumber];
  const upRightBrightness = brightnessCache[pointData.upRightPixelNumber];
  const downLeftBrightness = brightnessCache[pointData.downLeftPixelNumber];
  const downRightBrightness = brightnessCache[pointData.downRightPixelNumber];

  const foreground = abs(brightness - bgBrightness) / 255;
  const leftForeground = abs(leftBrightness - backgroundBrightness[pointData.leftPixelNumber]) / 255;
  const rightForeground = abs(rightBrightness - backgroundBrightness[pointData.rightPixelNumber]) / 255;
  const upForeground = abs(upBrightness - backgroundBrightness[pointData.upPixelNumber]) / 255;
  const downForeground = abs(downBrightness - backgroundBrightness[pointData.downPixelNumber]) / 255;
  const upLeftForeground = abs(upLeftBrightness - backgroundBrightness[pointData.upLeftPixelNumber]) / 255;
  const upRightForeground = abs(upRightBrightness - backgroundBrightness[pointData.upRightPixelNumber]) / 255;
  const downLeftForeground = abs(downLeftBrightness - backgroundBrightness[pointData.downLeftPixelNumber]) / 255;
  const downRightForeground = abs(downRightBrightness - backgroundBrightness[pointData.downRightPixelNumber]) / 255;

  const samples = [
    foreground,
    leftForeground,
    rightForeground,
    upForeground,
    downForeground,
    upLeftForeground,
    upRightForeground,
    downLeftForeground,
    downRightForeground
  ];

  const localForeground = max(...samples);
  const averageForeground = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const cardinalForeground =
    (foreground + leftForeground + rightForeground + upForeground + downForeground) / 5;
  const diagonalForeground =
    (upLeftForeground + upRightForeground + downLeftForeground + downRightForeground) / 4;
  const neighborForeground = lerp(cardinalForeground, diagonalForeground, BODY_DIAGONAL_BLEND * 0.5);
  const coherence = samples.filter((value) => value > FOREGROUND_THRESHOLD * 0.82).length / samples.length;
  const strongCore = samples.filter((value) => value > FOREGROUND_THRESHOLD * 1.08).length / samples.length;

  if (localForeground < FOREGROUND_THRESHOLD * 0.92) {
    pointData.lastBrightness = brightness;
    return { fillBody: 0, alpha: 0, depth: 0 };
  }

  if (coherence < BODY_MIN_COHERENCE && averageForeground < FOREGROUND_THRESHOLD * 0.95) {
    pointData.lastBrightness = brightness;
    return { fillBody: 0, alpha: 0, depth: 0 };
  }

  if (neighborForeground < FOREGROUND_THRESHOLD * BODY_ISOLATION_REJECTION && strongCore < 0.22) {
    pointData.lastBrightness = brightness;
    return { fillBody: 0, alpha: 0, depth: 0 };
  }

  const bodyMass = constrain(
    map(averageForeground, FOREGROUND_THRESHOLD * 0.5, FOREGROUND_STRONG_THRESHOLD * 0.92, 0, 1),
    0,
    1
  );
  const bodyPeak = constrain(
    map(localForeground, FOREGROUND_THRESHOLD * 0.9, FOREGROUND_STRONG_THRESHOLD, 0, 1),
    0,
    1
  );
  const fillBody = constrain(
    bodyMass * BODY_FILL_STRENGTH +
    bodyPeak * 0.45 +
    coherence * (BODY_COHERENCE_BOOST + 0.12) +
    strongCore * 0.18,
    0,
    1
  );
  pointData.lastBrightness = brightness;

  const alpha = constrain(50 + fillBody * 205, 0, 255);
  const depth = map(fillBody, 0, 1, -12, DEPTH_STRENGTH);

  return { fillBody, alpha, depth };
}
