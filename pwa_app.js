/**
 * Smart Attendance PWA - Client Logic
 * Versi stabil dengan perbaikan restart QR scanner
 * 
 * GANTI GAS_URL dengan URL deployment Google Apps Script Anda
 */

const GAS_URL = "https://script.google.com/macros/s/AKfycbzlHwt3UmiOK8DAXoPdF8RGMYuEUFOrD4bGcBfUQlOzlx7gQUfTucZfkHQE-vZvOiWFVg/exec";

// ----- Global Variables -----
let currentView = 'scan';
let isModelsLoaded = false;
let html5QrcodeScanner = null;
let scanStream = null;
let regStream = null;
let latestLiveDescriptor = null;
let scannedQRData = null;
let isProcessingQRScan = false;
let isRestartingScanner = false;
let livenessPassed = false;
let faceVerified = false;
let baselineSmileRatio = null;

// ----- Utility -----
function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem('attendance_device_id');
  if (!deviceId) {
    deviceId = 'DEV-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substring(2)));
    localStorage.setItem('attendance_device_id', deviceId);
  }
  return deviceId;
}

// ----- Initialization -----
window.addEventListener('DOMContentLoaded', async () => {
  setupNetworkMonitoring();
  loadLocalRegistration();
  updateOfflineBadge();
  await loadFaceApiModels();

  const hasURLParams = checkURLParameters();
  if (!hasURLParams && currentView === 'scan') {
    setTimeout(() => startQRScanner(), 600);
  }
});

// ----- Network & Service Worker -----
function setupNetworkMonitoring() {
  const statusBanner = document.getElementById('statusBanner');
  const statusText = document.getElementById('statusText');

  function updateStatus() {
    if (navigator.onLine) {
      statusBanner.className = "status-banner online";
      statusText.innerText = "Mode Online";
      syncOfflineQueue();
    } else {
      statusBanner.className = "status-banner offline";
      statusText.innerText = "Mode Offline - Absen Tersimpan Lokal";
    }
  }
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker terdaftar:', reg.scope))
      .catch(err => console.warn('SW gagal:', err));
  });
}

// ----- FaceAPI Models -----
async function loadFaceApiModels() {
  const LOCAL_MODEL_URL = './models';
  const CDN_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(LOCAL_MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(LOCAL_MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(LOCAL_MODEL_URL);
    isModelsLoaded = true;
    document.getElementById('loadingOverlay').style.display = 'none';
    console.log("Model wajah dimuat dari lokal.");
    return;
  } catch (e) {
    console.warn("Gagal muat lokal, coba CDN...", e);
  }
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(CDN_MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(CDN_MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(CDN_MODEL_URL);
    isModelsLoaded = true;
    document.getElementById('loadingOverlay').style.display = 'none';
    console.log("Model wajah dimuat dari CDN.");
  } catch (err) {
    console.error("Gagal muat model:", err);
    alert("Gagal memuat model AI. Periksa koneksi internet.");
  }
}

function loadLocalRegistration() {
  const localNRP = localStorage.getItem('attendance_registered_nrp');
  localStorage.removeItem('attendance_registered_embeddings');
  return !!localNRP;
}

// ----- View Switching -----
async function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.view-screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const idx = viewName === 'scan' ? 0 : 1;
  document.querySelectorAll('.tab-btn')[idx].classList.add('active');

  await stopAllCameras();

  if (viewName === 'scan') {
    scannedQRData = null;
    isProcessingQRScan = false;
    livenessPassed = false;
    faceVerified = false;
    baselineSmileRatio = null;
    latestLiveDescriptor = null;
    resetToScanStep1UI();
    document.getElementById('viewScan').classList.add('view-screen active');
    setTimeout(() => startQRScanner(), 600);
  } else {
    document.getElementById('viewRegister').classList.add('view-screen active');
  }
}

// ----- Camera Helpers -----
async function openCameraStream(facingMode = "user") {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
  } catch (e) {
    console.warn("FacingMode " + facingMode + " gagal, fallback video:true");
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  }
  return stream;
}

async function stopAllCameras() {
  // Stop streams
  [scanStream, regStream].forEach(stream => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
  });
  scanStream = null;
  regStream = null;

  // Hentikan scanner
  if (html5QrcodeScanner) {
    try {
      if (html5QrcodeScanner.isScanning) await html5QrcodeScanner.stop();
      await html5QrcodeScanner.clear();
    } catch (e) { /* ignore */ }
    html5QrcodeScanner = null;
  }

  // Hapus semua video dari DOM
  document.querySelectorAll('video').forEach(v => {
    if (v.srcObject) {
      v.srcObject.getTracks().forEach(t => t.stop());
      v.srcObject = null;
    }
  });

  // Bersihkan elemen #reader secara total (buat ulang)
  const readerContainer = document.getElementById('reader');
  if (readerContainer) {
    const parent = readerContainer.parentNode;
    const newReader = document.createElement('div');
    newReader.id = 'reader';
    parent.replaceChild(newReader, readerContainer);
  }

  await new Promise(r => setTimeout(r, 400));
}

// ----- UI Reset -----
function resetToScanStep1UI() {
  document.getElementById('scanStep1').style.display = 'block';
  document.getElementById('scanStep2').style.display = 'none';
  const result = document.getElementById('scanResult');
  result.style.display = 'none';
  result.className = 'feedback-message';
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
  document.getElementById('challengeText').style.display = 'none';
  document.getElementById('faceGuide').className = 'face-guide-oval';
}

function resetToScanStep1() {
  scannedQRData = null;
  isProcessingQRScan = false;
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
  latestLiveDescriptor = null;
  resetToScanStep1UI();
}

// ----- QR Scanner Core -----
async function startQRScanner() {
  console.log("startQRScanner() dipanggil");
  isProcessingQRScan = false;

  await stopAllCameras();
  resetToScanStep1UI();

  // Pastikan elemen #reader ada dan kosong
  let readerEl = document.getElementById('reader');
  if (!readerEl) {
    const container = document.querySelector('.scanner-viewport');
    if (container) {
      const newDiv = document.createElement('div');
      newDiv.id = 'reader';
      container.prepend(newDiv);
      readerEl = newDiv;
    } else {
      console.error("Elemen .scanner-viewport tidak ditemukan!");
      return;
    }
  }
  readerEl.innerHTML = '';

  const config = {
    fps: 15,
    qrbox: (vw, vh) => {
      const min = Math.min(vw, vh);
      return { width: Math.floor(min * 0.8), height: Math.floor(min * 0.8) };
    }
  };

  try {
    let cameraId = null;
    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length > 0) {
        const back = devices.find(d =>
          d.label.toLowerCase().includes('back') ||
          d.label.toLowerCase().includes('rear') ||
          d.label.toLowerCase().includes('environment')
        );
        cameraId = back ? back.id : devices[devices.length - 1].id;
        console.log("Kamera terpilih:", cameraId);
      }
    } catch (e) {
      console.warn("Gagal dapat daftar kamera:", e);
    }

    html5QrcodeScanner = new Html5Qrcode("reader");
    if (cameraId) {
      await html5QrcodeScanner.start(cameraId, config, onQRScanSuccess, onQRScanFailure);
    } else {
      await html5QrcodeScanner.start({ facingMode: "environment" }, config, onQRScanSuccess, onQRScanFailure);
    }
    console.log("QR Scanner berhasil dimulai.");
  } catch (err) {
    console.error("Gagal memulai QR scanner:", err);
    // Fallback dengan kamera depan
    try {
      await stopAllCameras();
      await new Promise(r => setTimeout(r, 300));
      readerEl = document.getElementById('reader');
      if (readerEl) readerEl.innerHTML = '';
      html5QrcodeScanner = new Html5Qrcode("reader");
      await html5QrcodeScanner.start({ facingMode: "user" }, config, onQRScanSuccess, onQRScanFailure);
      console.log("QR Scanner berjalan dengan kamera depan (fallback).");
    } catch (fallbackErr) {
      console.error("Fallback gagal:", fallbackErr);
      showScanResult("Tidak dapat mengakses kamera. Pastikan izin kamera diberikan.", "error");
    }
  }
}

// ----- QR Callbacks -----
async function onQRScanSuccess(decodedText, decodedResult) {
  if (isProcessingQRScan) return;
  console.log("QR terdeteksi:", decodedText);

  try {
    let outlet = null, timestamp = null, totpToken = null;
    if (decodedText.includes('outlet=') && decodedText.includes('totp_token=')) {
      const url = decodedText.startsWith('http') ? new URL(decodedText) : new URL('http://fake.com/?' + decodedText.split('?')[1]);
      outlet = url.searchParams.get('outlet') || url.searchParams.get('outlet_id');
      timestamp = url.searchParams.get('timestamp');
      totpToken = url.searchParams.get('totp_token');
    } else {
      try {
        const json = JSON.parse(decodedText);
        outlet = json.outlet || json.outlet_id;
        timestamp = json.timestamp;
        totpToken = json.totp_token;
      } catch (e) { /* not JSON */ }
    }

    if (!outlet || !totpToken || !timestamp) {
      throw new Error("Data QR tidak lengkap");
    }

    isProcessingQRScan = true;
    scannedQRData = { outlet, timestamp: Number(timestamp), totp_token: totpToken };
    console.log("Data QR valid:", scannedQRData);

    if (html5QrcodeScanner) {
      try { await html5QrcodeScanner.stop(); } catch (e) {}
    }

    const localNRP = localStorage.getItem('attendance_registered_nrp');
    setTimeout(async () => {
      await stopAllCameras();
      if (!localNRP) openSyncOverlay();
      else await startLivenessCamera();
    }, 300);

  } catch (error) {
    isProcessingQRScan = false;
    console.error("QR error:", error);
    showScanResult("QR tidak valid. Scan ulang.", "error");
    if (html5QrcodeScanner) {
      try { await html5QrcodeScanner.resume(); } catch (e) {}
    }
  }
}

function onQRScanFailure(err) { /* silent */ }

// ----- Restart & Cancel -----
async function restartQRScanner() {
  if (isRestartingScanner) return;
  isRestartingScanner = true;
  const btn = document.getElementById('btnRescanQR');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Memulai ulang...';
  }

  try {
    scannedQRData = null;
    isProcessingQRScan = false;
    livenessPassed = false;
    faceVerified = false;
    baselineSmileRatio = null;
    latestLiveDescriptor = null;
    resetToScanStep1UI();
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname);
    document.getElementById('scanResult').style.display = 'none';
    await stopAllCameras();
    await new Promise(r => setTimeout(r, 500));
    await startQRScanner();
    console.log("Restart scanner berhasil.");
  } catch (e) {
    console.error("Restart gagal:", e);
    showScanResult("Gagal restart scanner: " + e.message, "error");
  } finally {
    isRestartingScanner = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> Scan Ulang QR Code`;
    }
  }
}

async function cancelScan() {
  scannedQRData = null;
  isProcessingQRScan = false;
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
  latestLiveDescriptor = null;
  if (window.location.search) window.history.replaceState({}, '', window.location.pathname);
  document.getElementById('scanResult').style.display = 'none';
  await stopAllCameras();
  resetToScanStep1UI();
  setTimeout(() => startQRScanner(), 400);
}

// ----- Liveness Camera -----
async function startLivenessCamera() {
  baselineSmileRatio = null;
  await stopAllCameras();

  document.getElementById('scanStep1').style.display = 'none';
  document.getElementById('scanStep2').style.display = 'block';
  document.getElementById('challengeText').style.display = 'block';
  document.getElementById('challengeText').innerText = "Mendeteksi wajah...";

  const video = document.getElementById('scanFaceVideo');
  try {
    scanStream = await openCameraStream("user");
    video.srcObject = scanStream;
    await video.play();
    video.onloadedmetadata = () => runLivenessLoop(video);
    if (video.readyState >= 2) runLivenessLoop(video);
  } catch (err) {
    console.error("Gagal buka kamera depan:", err);
    showScanResult("Gagal akses kamera depan: " + err.message, "error");
    resetToScanStep1();
    setTimeout(() => startQRScanner(), 1000);
  }
}

async function runLivenessLoop(video) {
  if (!scanStream) return;
  const faceGuide = document.getElementById('faceGuide');
  const challengeText = document.getElementById('challengeText');

  try {
    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (detection) {
      faceVerified = true;
      latestLiveDescriptor = Array.from(detection.descriptor);
      faceGuide.className = 'face-guide-oval verified';

      if (!livenessPassed) {
        challengeText.innerText = "Tantangan: SILAKAN TERSENYUM! 😊";
        const isSmile = checkSmileLiveness(detection.landmarks);
        if (isSmile) {
          livenessPassed = true;
          challengeText.innerText = "Senyuman terdeteksi! Mengirim...";
          stopScanCamera();
          submitAttendance(latestLiveDescriptor);
          return;
        }
      }
    } else {
      faceVerified = false;
      latestLiveDescriptor = null;
      baselineSmileRatio = null;
      faceGuide.className = 'face-guide-oval';
      challengeText.innerText = "Dekatkan wajah ke kamera";
    }
  } catch (e) {
    console.warn("Loop error:", e);
  }

  setTimeout(() => runLivenessLoop(video), 60);
}

function stopScanCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
}

function checkSmileLiveness(landmarks) {
  const mouth = landmarks.getMouth();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  if (!mouth || mouth.length < 10 || !leftEye || !rightEye) return false;

  const mouthWidth = Math.hypot(mouth[6].x - mouth[0].x, mouth[6].y - mouth[0].y);
  const eyeWidth = Math.hypot(rightEye[3].x - leftEye[0].x, rightEye[3].y - leftEye[0].y);
  if (eyeWidth === 0) return false;

  const currentRatio = mouthWidth / eyeWidth;
  if (baselineSmileRatio === null) {
    baselineSmileRatio = currentRatio;
    return false;
  }

  const isWidthStretched = (currentRatio >= baselineSmileRatio * 1.14) && (currentRatio > 0.54);
  const mouthCenterY = (mouth[0].y + mouth[6].y) / 2;
  const mouthBottomY = mouth[9].y;
  const cornerLift = (mouthBottomY - mouthCenterY) / eyeWidth;

  console.log(`Ratio: ${currentRatio.toFixed(3)}, Baseline: ${baselineSmileRatio.toFixed(3)}, Lift: ${cornerLift.toFixed(3)}`);
  return isWidthStretched || (cornerLift > 0.20 && currentRatio >= baselineSmileRatio * 1.08);
}

// ----- Submit Attendance -----
function submitAttendance(liveFaceDescriptor) {
  const localNRP = localStorage.getItem('attendance_registered_nrp') || 'Karyawan';
  if (!scannedQRData || !scannedQRData.outlet) {
    showScanResult("Data QR hilang, scan ulang.", "error");
    setTimeout(() => { resetToScanStep1(); startQRScanner(); }, 3000);
    return;
  }

  document.getElementById('challengeText').innerText = "⏳ Mendapatkan lokasi GPS...";

  function proceed(lat, lng, accuracy) {
    if (lat === 0 && lng === 0) {
      showScanResult("❌ GPS tidak aktif. Aktifkan lokasi presisi.", "error");
      setTimeout(() => { resetToScanStep1(); startQRScanner(); }, 4000);
      return;
    }
    if (accuracy > 150) {
      showScanResult(`❌ Akurasi GPS rendah (${Math.round(accuracy)}m). Matikan Fake GPS.`, "error");
      setTimeout(() => { resetToScanStep1(); startQRScanner(); }, 4000);
      return;
    }

    const payload = {
      nrp: localNRP,
      outlet: scannedQRData.outlet,
      totp_token: scannedQRData.totp_token,
      timestamp: scannedQRData.timestamp,
      latitude: lat,
      longitude: lng,
      accuracy: Math.round(accuracy || 0),
      face_embedding: liveFaceDescriptor || latestLiveDescriptor,
      face_verified: faceVerified,
      liveness_passed: livenessPassed,
      attendance_type: "CLOCK_IN",
      device_id: getOrCreateDeviceId(),
      notes: `Absen QR PWA (GPS ${Math.round(accuracy||0)}m)`
    };

    if (navigator.onLine) sendToGAS(payload);
    else enqueueOfflineRecord(payload);
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => proceed(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      err => {
        console.warn("GPS error:", err);
        showScanResult("❌ Gagal dapat lokasi. Pastikan izin lokasi aktif.", "error");
        setTimeout(() => { resetToScanStep1(); startQRScanner(); }, 4000);
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
  } else {
    showScanResult("❌ GPS tidak didukung browser ini.", "error");
  }
}

async function sendToGAS(payload) {
  const challengeText = document.getElementById('challengeText');
  try {
    challengeText.innerText = "📤 Mengirim ke server...";
    showScanResult("Mengirim data...", "success");

    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    let resData = null;
    try { resData = await response.json(); } catch (e) {}

    if (resData && resData.status === "error") {
      showScanResult("❌ Ditolak: " + resData.message, "error");
      challengeText.innerText = "❌ Gagal: " + resData.message;
      setTimeout(() => { resetToScanStep1(); startQRScanner(); }, 5000);
      return;
    }

    const msg = resData?.message || `Absensi sukses, ${payload.nrp}`;
    showScanResult("✅ " + msg, "success");
    challengeText.innerText = "✅ Berhasil! Menutup...";
    setTimeout(() => closeBrowserTab(), 3000);
  } catch (err) {
    console.error("Gagal kirim:", err);
    enqueueOfflineRecord(payload);
  }
}

function closeBrowserTab() {
  try { window.close(); } catch (e) {}
  // Fallback UI
  setTimeout(() => {
    document.body.innerHTML = `
      <div style="min-height:100vh;background:#0b0f19;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;text-align:center;padding:24px;">
        <div style="width:80px;height:80px;background:rgba(16,185,129,0.15);border:2px solid #10b981;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2.5rem;margin-bottom:24px;">✓</div>
        <h1 style="font-size:1.8rem;font-weight:700;">Absensi Selesai!</h1>
        <p style="color:#9ca3af;margin-bottom:32px;">Data telah tersimpan.</p>
        <button onclick="window.close()" style="background:#6366f1;color:white;border:none;padding:14px 32px;border-radius:12px;font-weight:600;cursor:pointer;">Tutup</button>
      </div>`;
  }, 300);
}

// ----- Offline Queue -----
function enqueueOfflineRecord(payload) {
  let queue = JSON.parse(localStorage.getItem('offline_attendance_queue') || '[]');
  if (!queue.some(item => item.nrp === payload.nrp && item.timestamp === payload.timestamp)) {
    queue.push(payload);
    localStorage.setItem('offline_attendance_queue', JSON.stringify(queue));
  }
  updateOfflineBadge();
  showScanResult("Koneksi lambat. Absen disimpan lokal.", "warning");
  setTimeout(() => closeBrowserTab(), 3500);
}

async function syncOfflineQueue() {
  const queue = JSON.parse(localStorage.getItem('offline_attendance_queue') || '[]');
  if (queue.length === 0) return;
  let success = 0;
  for (let i = 0; i < queue.length; i++) {
    try {
      await fetch(GAS_URL, { method: "POST", mode: "no-cors", body: JSON.stringify(queue[i]) });
      success++;
    } catch (e) { break; }
  }
  if (success > 0) {
    const remaining = queue.slice(success);
    localStorage.setItem('offline_attendance_queue', JSON.stringify(remaining));
    updateOfflineBadge();
  }
}

function updateOfflineBadge() {
  const queue = JSON.parse(localStorage.getItem('offline_attendance_queue') || '[]');
  const badge = document.getElementById('offlineBadge');
  if (queue.length > 0) {
    badge.innerText = queue.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function showScanResult(message, type) {
  const div = document.getElementById('scanResult');
  div.innerText = message;
  div.className = 'feedback-message ' + (type === 'success' ? 'feedback-success' : type === 'warning' ? 'feedback-success' : 'feedback-error');
  div.style.display = 'block';
  if (type === 'warning') {
    div.style.borderColor = 'var(--warning)';
    div.style.color = 'var(--warning)';
  }
}

// ----- Registration Flow -----
async function startRegistrationFlow() {
  const nrp = document.getElementById('regNRP').value.trim();
  if (!nrp) { showRegResult("Isi NRP.", "error"); return; }
  showRegResult("Membuka kamera...", "success");
  await stopAllCameras();
  document.getElementById('btnStartReg').style.display = 'none';
  document.getElementById('registerCameraArea').style.display = 'block';
  const video = document.getElementById('regFaceVideo');
  try {
    regStream = await openCameraStream("user");
    video.srcObject = regStream;
    await video.play();
  } catch (err) {
    showRegResult("Gagal akses kamera: " + err.message, "error");
    stopRegistrationCamera();
  }
}

function stopRegistrationCamera() {
  if (regStream) {
    regStream.getTracks().forEach(t => t.stop());
    regStream = null;
  }
  document.getElementById('registerCameraArea').style.display = 'none';
  document.getElementById('btnStartReg').style.display = 'block';
  const btn = document.getElementById('btnCapturePhoto');
  btn.disabled = false;
  btn.style.display = 'block';
  btn.innerHTML = 'Ambil Foto';
}

async function captureFaceEmbeddings(btnElement) {
  const btn = btnElement || document.getElementById('btnCapturePhoto');
  btn.disabled = true;
  btn.style.display = 'none';

  const nrp = document.getElementById('regNRP').value.trim();
  if (!nrp) {
    showRegResult("Masukkan NRP.", "error");
    btn.disabled = false;
    btn.style.display = 'block';
    return;
  }
  if (!isModelsLoaded) {
    showRegResult("Model AI belum siap.", "error");
    btn.disabled = false;
    btn.style.display = 'block';
    return;
  }

  const video = document.getElementById('regFaceVideo');
  if (!regStream || video.readyState < 2) {
    await new Promise(r => setTimeout(r, 600));
  }

  showRegResult("⏳ Memproses...", "success");
  try {
    let detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!detection) {
      detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    }
    if (detection) {
      const embedding = Array.from(detection.descriptor);
      const deviceId = getOrCreateDeviceId();
      const res = await uploadFaceEmbeddingToCloud(nrp, embedding, deviceId);
      if (res && res.status === "error") {
        showRegResult("❌ " + res.message, "error");
        btn.disabled = false;
        btn.style.display = 'block';
        return;
      }
      localStorage.setItem('attendance_registered_nrp', nrp);
      localStorage.removeItem('attendance_registered_embeddings');
      localStorage.setItem('attendance_registered_device_id', deviceId);
      showRegResult("✅ Registrasi berhasil!", "success");
      setTimeout(() => {
        stopRegistrationCamera();
        switchView('scan');
      }, 3000);
    } else {
      showRegResult("Wajah tidak terdeteksi. Coba lagi.", "error");
      btn.disabled = false;
      btn.style.display = 'block';
    }
  } catch (err) {
    showRegResult("Error: " + err.message, "error");
    btn.disabled = false;
    btn.style.display = 'block';
  }
}

function showRegResult(msg, type) {
  const div = document.getElementById('regResult');
  div.innerText = msg;
  div.className = 'feedback-message ' + (type === 'success' ? 'feedback-success' : 'feedback-error');
  div.style.display = 'block';
}

async function uploadFaceEmbeddingToCloud(nrp, embedding, deviceId) {
  if (!navigator.onLine) {
    return { status: "error", message: "Tidak ada koneksi internet." };
  }
  try {
    const payload = { action: "register_face", nrp, face_embedding: embedding, device_id: deviceId };
    const resp = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    return await resp.json();
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

// ----- Sync Overlay -----
async function syncFaceProfile() {
  const nrp = document.getElementById('syncNRP').value.trim();
  if (!nrp) { showSyncResult("Masukkan NRP.", "error"); return; }
  if (!navigator.onLine) { showSyncResult("Offline, tidak bisa sync.", "error"); return; }
  showSyncResult("Mengunduh profil...", "success");
  try {
    const deviceId = getOrCreateDeviceId();
    const url = `${GAS_URL}?action=get_face_embedding&nrp=${nrp}&device_id=${deviceId}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === "success") {
      localStorage.setItem('attendance_registered_nrp', nrp);
      localStorage.setItem('attendance_registered_embeddings', JSON.stringify(data.message));
      showSyncResult("Sinkronisasi berhasil!", "success");
      setTimeout(() => {
        closeSyncOverlay();
        if (scannedQRData) startLivenessCamera();
        else startQRScanner();
      }, 2000);
    } else {
      showSyncResult("Gagal: " + data.message, "error");
    }
  } catch (e) {
    showSyncResult("Error: " + e.message, "error");
  }
}

function closeSyncOverlay() {
  document.getElementById('syncNrpOverlay').style.display = 'none';
  document.getElementById('syncResult').style.display = 'none';
}

function openSyncOverlay() {
  document.getElementById('syncNrpOverlay').style.display = 'flex';
}

function showSyncResult(msg, type) {
  const div = document.getElementById('syncResult');
  div.innerText = msg;
  div.className = 'feedback-message ' + (type === 'success' ? 'feedback-success' : 'feedback-error');
  div.style.display = 'block';
}

// ----- URL Parameter Check -----
function checkURLParameters() {
  const params = new URLSearchParams(window.location.search);
  const outlet = params.get('outlet') || params.get('outlet_id');
  const timestamp = params.get('timestamp');
  const totp = params.get('totp_token');
  if (outlet && timestamp && totp) {
    scannedQRData = { outlet, timestamp: Number(timestamp), totp_token: totp };
    window.history.replaceState({}, '', window.location.pathname);
    const localNRP = localStorage.getItem('attendance_registered_nrp');
    if (!localNRP) openSyncOverlay();
    else setTimeout(() => startLivenessCamera(), 500);
    return true;
  }
  return false;
}
