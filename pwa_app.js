/**
 * Smart Attendance PWA - Client Logic
 * Menangani Scanner QR, Deteksi Wajah, Liveness Challenge (Senyuman), dan Antrean Offline
 */

// Konfigurasi Endpoint Google Apps Script Web App Anda
// GANTI URL INI DENGAN URL DEPLOYMENT GAS ANDA
const GAS_URL = "https://script.google.com/macros/s/AKfycbzlHwt3UmiOK8DAXoPdF8RGMYuEUFOrD4bGcBfUQlOzlx7gQUfTucZfkHQE-vZvOiWFVg/exec";

// Global Variables
let currentView = 'scan';
let isModelsLoaded = false;
let faceMatcher = null;
let html5QrcodeScanner = null;
let scanStream = null;
let regStream = null;
let latestLiveDescriptor = null; // Deskriptor wajah live dari kamera (dikirim langsung ke server)
let cachedOutletShifts = []; // Opsi shift jam kerja per outlet dari tab 'Outlet Schedule'

// Variabel Data dari Hasil Scan QR Code PC
let scannedQRData = null;
let isProcessingQRScan = false;
let isRestartingScanner = false; // Guard agar tidak ada double-click race condition

// Keadaan Liveness Check
let blinkCount = 0;
let isBlinked = false;
let livenessPassed = false;
let faceVerified = false;
let baselineSmileRatio = null;

// =========================================================================
// DEBUG HELPERS
// =========================================================================

/**
 * Tampilkan panel debug di UI dengan snapshot semua state saat ini.
 */
function showDebugPanel() {
  const panel = document.getElementById('debugPanel');
  if (!panel) return;
  panel.style.display = 'block';

  const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };

  set('dbgTimestamp', `⏱ Waktu klik: ${now}`);

  // scannedQRData
  if (scannedQRData) {
    set('dbgScannedQR',
      `📦 scannedQRData:\n  outlet    = ${scannedQRData.outlet}\n  timestamp = ${scannedQRData.timestamp}\n  totp_token= ${scannedQRData.totp_token}`);
  } else {
    set('dbgScannedQR', '📦 scannedQRData: null');
  }

  // NRP tersimpan
  const nrp = localStorage.getItem('attendance_registered_nrp');
  set('dbgNRP', `👤 NRP tersimpan: ${nrp || '(tidak ada)'}`);

  // Flag state
  set('dbgIsProcessing', `🔒 isProcessingQRScan: ${isProcessingQRScan}`);
  set('dbgIsRestarting', `🔄 isRestartingScanner: ${isRestartingScanner}`);

  // State scanner html5QrcodeScanner
  let scannerState = 'null (tidak ada instance)';
  if (html5QrcodeScanner) {
    try {
      const s = html5QrcodeScanner.getState ? html5QrcodeScanner.getState() : '?';
      const stateMap = { 1: 'NOT_STARTED', 2: 'SCANNING', 3: 'PAUSED' };
      scannerState = `ada → state=${s} (${stateMap[s] || 'unknown'})`;
    } catch (e) { scannerState = `ada → getState() error: ${e.message}`; }
  }
  set('dbgScannerState', `📷 html5QrcodeScanner: ${scannerState}`);

  // Stream kamera
  set('dbgCameraState',
    `🎥 scanStream: ${scanStream ? `aktif (${scanStream.getTracks().length} track)` : 'null'}`);

  // Elemen #reader
  const readerEl = document.getElementById('reader');
  set('dbgReaderEl',
    `🗂 #reader children: ${readerEl ? readerEl.children.length : 'element not found'}`);

  // Reset log area
  const logEl = document.getElementById('dbgLog');
  if (logEl) logEl.innerText = '';

  console.log('=== [DEBUG] restartQRScanner() dipanggil ===');
  console.log('scannedQRData:', scannedQRData);
  console.log('NRP tersimpan:', nrp);
  console.log('isProcessingQRScan:', isProcessingQRScan);
  console.log('isRestartingScanner:', isRestartingScanner);
  console.log('html5QrcodeScanner:', html5QrcodeScanner);
  console.log('scanStream:', scanStream);
  console.log('#reader children:', readerEl ? readerEl.children.length : 'not found');
}

/**
 * Tambah baris log ke debug panel UI sekaligus ke console.
 */
function dbgLog(msg) {
  const logEl = document.getElementById('dbgLog');
  if (logEl) {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false, second: '2-digit' });
    logEl.innerText += `[${time}] ${msg}\n`;
  }
  console.log(`[DBG] ${msg}`);
}

/**
 * Mendapatkan atau Membuat Device ID yang KONSTAN berbasis Hardware Fingerprint HP.
 * ID ini TIDAK BERUBAH meskipun cache/site data browser dihapus.
 */
function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem('attendance_device_id');
  if (deviceId && deviceId.startsWith('DEV-FP-')) {
    return deviceId;
  }

  // Buat Hardware Fingerprint konstan berdasarkan spesifikasi fisik HP
  try {
    const fpData = [
      navigator.userAgent || '',
      navigator.language || '',
      screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 24),
      navigator.hardwareConcurrency || 'cpu-x',
      navigator.deviceMemory || 'mem-x',
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'tz-x',
      getCanvasFingerprint()
    ].join('||');

    const hash = fnv1aHash(fpData);
    deviceId = 'DEV-FP-' + hash;
  } catch (e) {
    // Fallback jika terjadi kesalahan saat fingerprinting
    deviceId = 'DEV-FP-' + Math.abs(fnv1aHash(navigator.userAgent || 'fallback')).toString(16).toUpperCase().padStart(8, '0');
  }

  try {
    localStorage.setItem('attendance_device_id', deviceId);
  } catch (e) { }

  return deviceId;
}

/**
 * Hash Canvas sederhana untuk fingerprinting GPU/Render Engine HP
 */
function getCanvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-ctx';
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('AttendancePWA,1.0', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('AttendancePWA,1.0', 4, 17);
    return canvas.toDataURL();
  } catch (e) {
    return 'canvas-err';
  }
}

/**
 * FNV-1a Hash 32-bit (Konversi string fingerprint ke ID hex 8 karakter yang unik & stabil)
 */
function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Muat Model face-api.js saat halaman dibuka
window.addEventListener('DOMContentLoaded', async () => {
  setupNetworkMonitoring();
  loadLocalRegistration();
  updateOfflineBadge();
  await loadFaceApiModels();

  // Cek jika halaman dibuka dari scan kamera bawaan HP (parameter URL)
  const hasURLParams = checkURLParameters();
  if (!hasURLParams && currentView === 'scan') {
    // Hanya buka kamera scanner QR belakang jika BUKAN dari URL parameter
    startQRScanner();
  }
});

/**
 * Memeriksa jika ada parameter URL yang dikirim (misal jika di-scan lewat kamera bawaan HP)
 */
function checkURLParameters() {
  const urlParams = new URLSearchParams(window.location.search);
  const outlet = urlParams.get('outlet') || urlParams.get('outlet_id');
  const timestamp = urlParams.get('timestamp');
  const totpToken = urlParams.get('totp_token');

  if (outlet && timestamp && totpToken) {
    scannedQRData = {
      outlet: outlet,
      timestamp: Number(timestamp),
      totp_token: totpToken
    };
    console.log("Parameter URL terdeteksi dari kamera bawaan HP:", scannedQRData);
    fetchOutletShifts(outlet);

    // Bersihkan parameter query URL dari address bar agar tidak membingungkan saat navigasi/tab switch
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e) { }

    // Pastikan user terdaftar di ponsel ini
    const localNRP = localStorage.getItem('attendance_registered_nrp');
    if (!localNRP) {
      openSyncOverlay(); // Tampilkan overlay sinkronisasi profil wajah
      return true;
    }

    // Pindah langsung ke Langkah 2: Verifikasi Wajah (Kamera Depan)
    startLivenessCamera();
    return true;
  }
  return false;
}

/**
 * Memantau Koneksi Jaringan
 */
function setupNetworkMonitoring() {
  const statusBanner = document.getElementById('statusBanner');
  const statusText = document.getElementById('statusText');

  function updateStatus() {
    if (navigator.onLine) {
      statusBanner.className = "status-banner online";
      statusText.innerText = "Mode Online";
      // Coba sinkronisasi jika ada antrean offline
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

// Registrasi Service Worker untuk Caching Model AI & App Shell di HP
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('Service Worker terdaftar di HP:', reg.scope);
    }).catch(err => {
      console.warn('Registrasi Service Worker gagal:', err);
    });
  });
}

/**
 * Muat Model AI Wajah (face-api.js) dari folder ./models/ lokal HP atau dari CacheStorage
 */
async function loadFaceApiModels() {
  const LOCAL_MODEL_URL = './models';
  const CDN_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

  console.log("Memuat model AI face-api...");

  // 1. Coba muat dari folder ./models/ lokal proyek
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(LOCAL_MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(LOCAL_MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(LOCAL_MODEL_URL);

    isModelsLoaded = true;
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    console.log("Model AI wajah berhasil dimuat dari folder ./models/ lokal!");
    return;
  } catch (localErr) {
    console.warn("Folder model ./models/ lokal tidak terdeteksi, mencoba CDN/CacheStorage HP...", localErr);
  }

  // 2. Fallback: Muat dari CDN (otomatis tersimpan di CacheStorage HP lewat Service Worker)
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(CDN_MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(CDN_MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(CDN_MODEL_URL);

    isModelsLoaded = true;
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    console.log("Model AI wajah berhasil dimuat dan tersimpan di cache HP!");
  } catch (error) {
    console.error("Gagal memuat model face-api.js:", error);
    alert("Gagal memuat model AI. Pastikan perangkat Anda terhubung ke internet setidaknya satu kali untuk menyimpan model di HP.");
  }
}

/**
 * Memuat data pendaftaran NRP yang tersimpan di LocalStorage (Tanpa menyimpan data wajah di HP)
 */
function loadLocalRegistration() {
  const localNRP = localStorage.getItem('attendance_registered_nrp');
  localStorage.removeItem('attendance_registered_embeddings'); // Hapus data lama jika ada

  if (localNRP) {
    console.log("Data profil lokal ditemukan untuk NRP: " + localNRP);
    return true;
  }
  return false;
}

/**
 * Berpindah Antar View Screen (Scan vs Registrasi)
 */
async function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.view-screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  const activeBtnIndex = viewName === 'scan' ? 0 : 1;
  document.querySelectorAll('.tab-btn')[activeBtnIndex].classList.add('active');

  await stopAllCameras();

  if (viewName === 'scan') {
    // Reset seluruh state scan saat kembali ke tab scan
    scannedQRData = null;
    isProcessingQRScan = false;
    livenessPassed = false;
    faceVerified = false;
    baselineSmileRatio = null;
    latestLiveDescriptor = null;

    // Reset UI ke Langkah 1
    resetToScanStep1UI();

    // Tampilkan view scan — cukup tambahkan 'active' saja karena 'view-screen' sudah ada di HTML
    // JANGAN classList.add('view-screen active') karena spasi di dalam string menyebabkan DOMException!
    document.getElementById('viewScan').classList.add('active');
    console.log('[DBG] switchView: viewScan.classList =', document.getElementById('viewScan').className);

    // Start ulang QR scanner dengan delay agar kamera benar-benar release
    setTimeout(() => {
      console.log('[DBG] switchView: memanggil startQRScanner() setelah 500ms');
      startQRScanner();
    }, 500);
  } else {
    // JANGAN classList.add('view-screen active') — hanya tambahkan 'active'
    document.getElementById('viewRegister').classList.add('active');
    console.log('[DBG] switchView: viewRegister.classList =', document.getElementById('viewRegister').className);
  }
}

// =========================================================================
// SCAN ABSENSI & LIVENESS DETECTION FLOW
// =========================================================================

/**
 * Membuka Stream Kamera secara Andal dengan Fallback Otomatis
 */
async function openCameraStream(facingMode = "user") {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facingMode }
    });
  } catch (err1) {
    console.warn("Mencoba getUserMedia dengan facingMode " + facingMode + " gagal, mencoba video: true fallback...", err1);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (err2) {
      console.error("Gagal membuka kamera:", err2);
      throw err2;
    }
  }
  return stream;
}

/**
 * Menghentikan seluruh stream kamera (QR Scanner, Kamera Liveness, Kamera Registrasi)
 * dan membebaskan hardware kamera secara bersih dari OS driver.
 */
async function stopAllCameras() {
  // Hentikan native BarcodeDetector scanner jika aktif
  if (_nativeScannerInterval) {
    clearInterval(_nativeScannerInterval);
    _nativeScannerInterval = null;
  }
  if (_nativeScannerStream) {
    try {
      _nativeScannerStream.getTracks().forEach(t => { try { t.stop(); } catch (e) { } });
    } catch (e) { }
    _nativeScannerStream = null;
  }
  if (_nativeScannerVideo) {
    try { _nativeScannerVideo.srcObject = null; } catch (e) { }
    _nativeScannerVideo = null;
  }

  if (scanStream) {
    try {
      scanStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) { }
      });
    } catch (e) { }
    scanStream = null;
  }

  if (regStream) {
    try {
      regStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) { }
      });
    } catch (e) { }
    regStream = null;
  }

  if (html5QrcodeScanner) {
    try {
      // Coba deteksi state scanning dengan beberapa cara
      let isScanning = false;
      try {
        if (html5QrcodeScanner.getState) {
          isScanning = html5QrcodeScanner.getState() === 2; // Html5QrcodeScannerState.SCANNING = 2
        } else if (typeof html5QrcodeScanner.isScanning === 'boolean') {
          isScanning = html5QrcodeScanner.isScanning;
        } else {
          isScanning = true; // Asumsikan sedang scanning jika tidak bisa deteksi
        }
      } catch (stateErr) {
        isScanning = true;
      }

      if (isScanning) {
        await html5QrcodeScanner.stop().catch(err => console.warn("Scanner stop warning:", err));
      }
      try { await html5QrcodeScanner.clear(); } catch (err) { console.warn("Scanner clear warning:", err); }
    } catch (e) {
      console.warn("Cleanup scanner instance warning:", e);
    }
    html5QrcodeScanner = null;
  }

  // PAKSA bersihkan elemen #reader dari sisa DOM Html5Qrcode agar re-init selalu berhasil
  try {
    const readerEl = document.getElementById('reader');
    if (readerEl) {
      console.log('[DBG] stopAllCameras: membersihkan #reader, children sebelum clear:', readerEl.children.length);
      readerEl.innerHTML = '';
      // Clone dan replace untuk menghapus semua event listener
      const newReader = readerEl.cloneNode(false);
      readerEl.parentNode.replaceChild(newReader, readerEl);
      newReader.id = 'reader';
      console.log('[DBG] stopAllCameras: #reader berhasil dikosongkan');
    }
  } catch (e) { console.warn('[DBG] stopAllCameras: gagal bersihkan #reader', e); }

  // Hentikan seluruh stream yang masih menempel pada elemen video di DOM
  try {
    const videoElements = document.querySelectorAll('video');
    videoElements.forEach(v => {
      if (v.srcObject && v.srcObject.getTracks) {
        v.srcObject.getTracks().forEach(track => {
          try { track.stop(); } catch (e) { }
        });
        v.srcObject = null;
      }
    });
  } catch (e) { }

  // Beri jeda 300ms agar driver hardware kamera OS rilis penuh
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Reset tampilan UI saja ke Langkah 1, tanpa menghapus scannedQRData.
 * Digunakan oleh startQRScanner() agar data QR yang sudah di-scan tidak hilang
 * jika kamera restart karena alasan lain.
 */
function resetToScanStep1UI() {
  const step1 = document.getElementById('scanStep1');
  const step2 = document.getElementById('scanStep2');
  const step3 = document.getElementById('scanStep3');
  const result = document.getElementById('scanResult');

  if (step1) step1.style.display = 'block';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'none';
  if (result) {
    result.style.display = 'none';
    result.className = 'feedback-message';
  }

  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;

  // Reset challenge text
  const challengeText = document.getElementById('challengeText');
  if (challengeText) {
    challengeText.style.display = 'none';
    challengeText.innerText = 'Memuat pendeteksi...';
  }

  // Reset face guide
  const faceGuide = document.getElementById('faceGuide');
  if (faceGuide) {
    faceGuide.className = 'face-guide-oval';
  }
}

/**
 * Reset tampilan UI ke Langkah 1 BESERTA data QR (full reset).
 * Digunakan saat user membatalkan scan atau terjadi error yang memerlukan scan ulang dari awal.
 */
function resetToScanStep1() {
  scannedQRData = null;
  isProcessingQRScan = false;
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
  latestLiveDescriptor = null;
  const step1 = document.getElementById('scanStep1');
  const step2 = document.getElementById('scanStep2');
  const step3 = document.getElementById('scanStep3');
  const result = document.getElementById('scanResult');

  if (step1) step1.style.display = 'block';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'none';
  if (result) result.style.display = 'none';
}

/**
 * Pindah ke Langkah 3: Pilih Menu Absensi (2x2 Grid)
 * Dipanggil setelah Verifikasi Wajah & Liveness Check berhasil pada Langkah 2
 */
function showScanStep3() {
  const step1 = document.getElementById('scanStep1');
  const step2 = document.getElementById('scanStep2');
  const step3 = document.getElementById('scanStep3');

  if (step1) step1.style.display = 'none';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'block';

  // Ambil daftar shift outlet dari server secara otomatis
  if (scannedQRData && (scannedQRData.outlet || scannedQRData.outlet_id)) {
    fetchOutletShifts(scannedQRData.outlet || scannedQRData.outlet_id);
  }

  // Re-enable tombol-tombol menu
  const menuButtons = document.querySelectorAll('#scanStep3 .menu-card');
  menuButtons.forEach(btn => {
    btn.removeAttribute('disabled');
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  });
}

/**
 * Mengunduh Opsi Shift Kerja untuk Outlet dari Tab 'Outlet Schedule'
 */
async function fetchOutletShifts(outletName) {
  cachedOutletShifts = [];
  if (!outletName || !GAS_URL) return;

  const cleanOutlet = String(outletName).trim();
  const cacheKey = 'outlet_shifts_' + cleanOutlet.toLowerCase();
  
  try {
    const stored = localStorage.getItem(cacheKey);
    if (stored) {
      cachedOutletShifts = JSON.parse(stored);
    }
  } catch (e) { }

  if (navigator.onLine) {
    try {
      const url = `${GAS_URL}?action=get_outlet_shifts&outlet=${encodeURIComponent(cleanOutlet)}`;
      const response = await fetch(url);
      const data = await response.json();
      if (data && data.status === "success" && Array.isArray(data.message)) {
        cachedOutletShifts = data.message;
        localStorage.setItem(cacheKey, JSON.stringify(cachedOutletShifts));
      }
    } catch (err) {
      console.warn("Gagal fetch shift outlet dari GAS:", err);
    }
  }
}

/**
 * Menangani Klik Tombol Masuk Kerja (Clock In)
 * Jika terdapat pilihan shift per outlet, tampilkan dialog pemilihan shift.
 */
async function handleClockInClick() {
  const localNRP = localStorage.getItem('attendance_registered_nrp') || 'Karyawan';
  const todayDateStr = new Date().toISOString().split('T')[0];
  const localStatusKey = 'attendance_status_' + localNRP + '_' + todayDateStr;
  let localStatus = {};
  try {
    localStatus = JSON.parse(localStorage.getItem(localStatusKey) || '{}');
  } catch (e) { }

  if (localStatus.hasClockIn) {
    showScanResult("❌ Absensi Ditolak: Anda sudah melakukan Clock In hari ini (tidak dapat melakukan Clock In berulang kali).", "error");
    return;
  }

  const outletName = (scannedQRData && (scannedQRData.outlet || scannedQRData.outlet_id)) || '';

  // Jika shift belum sempat di-fetch/di-load, pastikan di-fetch terlebih dahulu
  if ((!cachedOutletShifts || cachedOutletShifts.length === 0) && outletName) {
    showScanResult("⏳ Memuat opsi shift jam kerja...", "info");
    await fetchOutletShifts(outletName);
  }

  if (cachedOutletShifts && cachedOutletShifts.length > 0) {
    openShiftOverlay();
  } else {
    submitAttendance('CLOCK_IN', '');
  }
}

/**
 * Membuka Modal Pemilihan Shift Kerja (Jadwal Outlet)
 */
function openShiftOverlay() {
  const overlay = document.getElementById('shiftSelectOverlay');
  const outletText = document.getElementById('shiftOutletName');
  const container = document.getElementById('shiftOptionsContainer');

  if (!overlay || !container) {
    submitAttendance('CLOCK_IN', '');
    return;
  }

  const outletName = (scannedQRData && (scannedQRData.outlet || scannedQRData.outlet_id)) || '';
  if (outletText) {
    outletText.innerText = "Outlet: " + outletName + " — Silakan pilih jam kerja Anda:";
  }

  container.innerHTML = '';
  cachedOutletShifts.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.style.cssText = 'background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.4); justify-content: space-between; padding: 14px 18px; color: var(--text-main); font-weight: 600; text-align: left; margin-bottom: 8px; width: 100%; border-radius: 12px; cursor: pointer;';

    const shiftText = item.shift || 'Shift';
    const hourText = item.working_hour || '';
    const hourVal = hourText || shiftText;

    btn.innerHTML = `<span style="font-weight: 600; font-size: 0.95rem;">${shiftText}</span><span style="font-size:0.85rem; color:var(--text-muted);">${hourText}</span>`;
    btn.onclick = () => {
      closeShiftOverlay();
      submitAttendance('CLOCK_IN', hourVal);
    };
    container.appendChild(btn);
  });

  overlay.style.display = 'flex';
}

function closeShiftOverlay() {
  const overlay = document.getElementById('shiftSelectOverlay');
  if (overlay) overlay.style.display = 'none';
}

/**
 * State untuk custom native scanner (BarcodeDetector)
 */
let _nativeScannerStream = null;
let _nativeScannerInterval = null;
let _nativeScannerVideo = null;

/**
 * Menyalakan Kamera QR Code Reader di HP
 * Menggunakan BarcodeDetector native API (lebih handal untuk QR dari layar PC)
 * dengan fallback ke Html5Qrcode jika tidak tersedia
 */
async function startQRScanner() {
  console.log('[DBG] startQRScanner() dipanggil');
  isProcessingQRScan = false;

  try {
    await stopAllCameras();
    console.log('[DBG] startQRScanner: stopAllCameras selesai');
  } catch (e) {
    console.warn("Stop kamera error:", e);
  }

  resetToScanStep1UI();

  // Bersihkan #reader
  const readerEl = document.getElementById('reader');
  if (readerEl) {
    readerEl.innerHTML = '';
    console.log('[DBG] startQRScanner: #reader di-clear');
  } else {
    console.error('[DBG] startQRScanner: #reader TIDAK DITEMUKAN!');
    return;
  }

  // Beri waktu browser render
  await new Promise(r => setTimeout(r, 100));

  // Cek engine scanner yang tersedia: BarcodeDetector -> jsQR -> Html5Qrcode (ZXing)
  const hasBarcodeDetector = ('BarcodeDetector' in window);
  const hasJsQR = (typeof jsQR !== 'undefined');

  dbgLog(`🔬 Engine: BarcodeDetector=${hasBarcodeDetector ? '✅' : '❌'}, jsQR=${hasJsQR ? '✅' : '❌'}`);
  console.log('[DBG] Engines:', { BarcodeDetector: hasBarcodeDetector, jsQR: hasJsQR });

  if (hasBarcodeDetector) {
    await _startNativeBarcodeScanner(readerEl);
  } else if (hasJsQR) {
    await _startJsQRScanner(readerEl);
  } else {
    await _startHtml5QrcodeScanner(readerEl);
  }
}

/**
 * Scanner menggunakan library jsQR (Direct Canvas Capture + Ultra-fast Decode)
 * Sangat presisi untuk membaca QR code dari layar monitor PC
 */
async function _startJsQRScanner(containerEl) {
  dbgLog('⚡ Memulai jsQR Scanner (High-Precision Canvas Mode)...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    _nativeScannerStream = stream;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:14px;';
    video.srcObject = stream;
    containerEl.appendChild(video);
    _nativeScannerVideo = video;

    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
      setTimeout(resolve, 2000);
    });
    await video.play().catch(e => console.warn('video.play() warning:', e));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    dbgLog('✅ Kamera jsQR aktif! Mulai scan QR layar PC...');
    console.log('[DBG] jsQR scanner: video size', video.videoWidth, 'x', video.videoHeight);

    html5QrcodeScanner = {
      getState: () => 2,
      stop: async () => {
        if (_nativeScannerInterval) clearInterval(_nativeScannerInterval);
        _nativeScannerInterval = null;
        if (_nativeScannerStream) {
          _nativeScannerStream.getTracks().forEach(t => t.stop());
          _nativeScannerStream = null;
        }
        if (_nativeScannerVideo) {
          _nativeScannerVideo.srcObject = null;
          _nativeScannerVideo = null;
        }
        console.log('[DBG] jsQR scanner: stopped');
      },
      pause: (stopVideo) => {
        if (_nativeScannerInterval) clearInterval(_nativeScannerInterval);
        _nativeScannerInterval = null;
        if (stopVideo && _nativeScannerVideo) _nativeScannerVideo.pause();
        console.log('[DBG] jsQR scanner: paused');
      },
      clear: () => {
        if (containerEl) containerEl.innerHTML = '';
      }
    };

    let failCount = 0, failTimer = null;
    _nativeScannerInterval = setInterval(async () => {
      if (isProcessingQRScan) return;
      if (!video.videoWidth || !video.videoHeight) return;

      failCount++;
      if (!failTimer) {
        failTimer = setTimeout(() => {
          dbgLog(`🔄 jsQR scan attempts: ${failCount} / 2 detik`);
          const el = document.getElementById('dbgScannerState');
          if (el) el.innerText = `⚡ jsQR scanner aktif | attempts: ${failCount}`;
          failCount = 0; failTimer = null;
        }, 2000);
      }

      // Gunakan resolusi optimal untuk jsQR performance
      const scanWidth = Math.min(video.videoWidth, 800);
      const scanHeight = Math.floor(video.videoHeight * (scanWidth / video.videoWidth));

      canvas.width = scanWidth;
      canvas.height = scanHeight;
      ctx.drawImage(video, 0, 0, scanWidth, scanHeight);

      const imageData = ctx.getImageData(0, 0, scanWidth, scanHeight);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert"
      });

      if (code && code.data && code.data.trim() !== '') {
        console.log('[DBG] QR code detected by jsQR:', code.data);
        await onQRScanSuccess(code.data, code);
      }
    }, 100);

  } catch (err) {
    dbgLog(`❌ jsQR scanner error: ${err.message}`);
    console.error('[DBG] _startJsQRScanner error:', err);
    dbgLog('⬇️ Fallback ke Html5Qrcode (ZXing)...');
    await _startHtml5QrcodeScanner(containerEl);
  }
}

/**
 * Scanner menggunakan native BarcodeDetector API (Chrome Android 83+)
 * Jauh lebih handal untuk QR code dari layar monitor PC
 */
async function _startNativeBarcodeScanner(containerEl) {
  dbgLog('📷 Memulai Native BarcodeDetector scanner...');
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });

    // Buka kamera belakang dengan resolusi tinggi
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    _nativeScannerStream = stream;

    // Buat elemen video untuk tampilan kamera
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:14px;';
    video.srcObject = stream;
    containerEl.appendChild(video);
    _nativeScannerVideo = video;

    // Tunggu video siap
    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
      setTimeout(resolve, 2000); // timeout fallback
    });
    await video.play().catch(e => console.warn('video.play() warning:', e));

    // Buat canvas tersembunyi untuk capture frame
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    dbgLog('✅ Kamera native aktif! Mulai scan QR...');
    console.log('[DBG] Native scanner: video size', video.videoWidth, 'x', video.videoHeight);

    // Buat proxy object agar kompatibel dengan stopAllCameras()
    html5QrcodeScanner = {
      getState: () => 2, // 2 = SCANNING
      stop: async () => {
        clearInterval(_nativeScannerInterval);
        _nativeScannerInterval = null;
        if (_nativeScannerStream) {
          _nativeScannerStream.getTracks().forEach(t => t.stop());
          _nativeScannerStream = null;
        }
        if (_nativeScannerVideo) {
          _nativeScannerVideo.srcObject = null;
          _nativeScannerVideo = null;
        }
        console.log('[DBG] Native scanner: stopped');
      },
      pause: (stopVideo) => {
        clearInterval(_nativeScannerInterval);
        _nativeScannerInterval = null;
        if (stopVideo && _nativeScannerVideo) _nativeScannerVideo.pause();
        console.log('[DBG] Native scanner: paused');
      },
      clear: () => {
        if (containerEl) containerEl.innerHTML = '';
      }
    };

    // Loop scan setiap 125ms (~8fps)
    let failCount = 0, failTimer = null;
    _nativeScannerInterval = setInterval(async () => {
      if (isProcessingQRScan) return;
      if (!video.videoWidth || !video.videoHeight) return;

      // Count failures untuk debug
      failCount++;
      if (!failTimer) {
        failTimer = setTimeout(() => {
          dbgLog(`🔄 Native scan attempts: ${failCount} / 2 detik`);
          const el = document.getElementById('dbgScannerState');
          if (el) el.innerText = `📷 native scanner aktif | attempts: ${failCount}`;
          failCount = 0; failTimer = null;
        }, 2000);
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);

      try {
        const barcodes = await detector.detect(canvas);
        if (barcodes && barcodes.length > 0) {
          const rawValue = barcodes[0].rawValue;
          console.log('[DBG] QR detected by BarcodeDetector:', rawValue);
          await onQRScanSuccess(rawValue, barcodes[0]);
        }
      } catch (e) {
        // Kegagalan deteksi adalah normal saat tidak ada QR di frame
      }
    }, 125);

  } catch (err) {
    dbgLog(`❌ Native scanner error: ${err.message}`);
    console.error('[DBG] _startNativeBarcodeScanner error:', err);
    // Fallback ke Html5Qrcode
    dbgLog('⬇️ Fallback ke Html5Qrcode...');
    await _startHtml5QrcodeScanner(containerEl);
  }
}

/**
 * Scanner menggunakan Html5Qrcode (ZXing) — sebagai fallback
 */
async function _startHtml5QrcodeScanner(containerEl) {
  dbgLog('📷 Memulai Html5Qrcode (ZXing) scanner...');

  const config = {
    fps: 8,
    aspectRatio: 4 / 3,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  };

  try {
    let cameraId = null;
    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length > 0) {
        const backCamera = devices.find(d =>
          d.label.toLowerCase().includes('back') ||
          d.label.toLowerCase().includes('rear') ||
          d.label.toLowerCase().includes('environment') ||
          d.label.toLowerCase().includes('0')
        );
        cameraId = backCamera ? backCamera.id : devices[devices.length - 1].id;
      }
    } catch (e) { console.warn("getCameras error:", e); }

    html5QrcodeScanner = new Html5Qrcode("reader");

    if (cameraId) {
      await html5QrcodeScanner.start(cameraId, config, onQRScanSuccess, onQRScanFailure);
    } else {
      await html5QrcodeScanner.start({ facingMode: "environment" }, config, onQRScanSuccess, onQRScanFailure);
    }
    dbgLog('✅ Html5Qrcode (ZXing) aktif');
    console.log("Kamera QR scanner aktif (Html5Qrcode).");
  } catch (err1) {
    console.warn("Gagal Html5Qrcode primary, mencoba fallback facingMode...", err1);
    try {
      await stopAllCameras();
      await new Promise(r => setTimeout(r, 300));
      const el = document.getElementById('reader');
      if (el) el.innerHTML = '';
      html5QrcodeScanner = new Html5Qrcode("reader");
      await html5QrcodeScanner.start({ facingMode: "user" }, config, onQRScanSuccess, onQRScanFailure);
      dbgLog('✅ Html5Qrcode fallback (facingMode user) aktif');
    } catch (err2) {
      console.error("Gagal total menyalakan kamera:", err2);
      dbgLog(`❌ Gagal buka kamera: ${err2.message}`);
      showScanResult("Gagal membuka kamera: " + (err2.message || err2.toString()), "error");
    }
  }
}


/**
 * Callback ketika QR Code berhasil di-scan
 */
async function onQRScanSuccess(decodedText, decodedResult) {
  // Cegah multiple scan dalam waktu bersamaan
  if (isProcessingQRScan) {
    return; // Silent return, sudah diproses
  }

  // Tampilkan QR terdeteksi di debug panel
  dbgLog(`🔎 QR terdeteksi! (${decodedText.length} chars)`);
  console.log("QR Code terdeteksi:", decodedText);

  try {
    let outlet = null;
    let timestamp = null;
    let totpToken = null;

    // Parse QR Code
    if (decodedText.includes("outlet=") && decodedText.includes("totp_token=")) {
      let searchParams = null;
      if (decodedText.startsWith("http://") || decodedText.startsWith("https://")) {
        const url = new URL(decodedText);
        searchParams = url.searchParams;
      } else {
        const queryString = decodedText.includes("?") ? decodedText.split("?")[1] : decodedText;
        searchParams = new URLSearchParams(queryString);
      }

      outlet = searchParams.get('outlet') || searchParams.get('outlet_id');
      timestamp = searchParams.get('timestamp');
      totpToken = searchParams.get('totp_token');
    } else {
      // Fallback format JSON
      try {
        const json = JSON.parse(decodedText);
        outlet = json.outlet || json.outlet_id;
        timestamp = json.timestamp;
        totpToken = json.totp_token;
      } catch (e) {
        console.warn("Bukan format JSON:", decodedText.substring(0, 80));
      }
    }

    dbgLog(`📦 outlet=${outlet}, timestamp=${timestamp}, totp=${totpToken ? totpToken.substring(0, 8) + '...' : 'null'}`);

    if (!outlet || !totpToken || !timestamp) {
      throw new Error("Parameter QR Code tidak lengkap: outlet=" + outlet + " totp=" + totpToken + " ts=" + timestamp);
    }

    // Set flag processing
    isProcessingQRScan = true;

    scannedQRData = {
      outlet: outlet,
      timestamp: Number(timestamp),
      totp_token: totpToken
    };

    fetchOutletShifts(outlet);

    console.log("QR Code baru berhasil diproses:", scannedQRData);
    dbgLog('✅ QR valid! Menjeda scanner...');

    const localNRP = localStorage.getItem('attendance_registered_nrp');

    // PENTING: Gunakan pause() bukan stop() dari dalam callback scanner!
    // stop() di dalam callback menyebabkan DEADLOCK karena library sedang
    // mengeksekusi loop scan-nya sendiri.
    if (html5QrcodeScanner) {
      try {
        html5QrcodeScanner.pause(true); // pause = aman dipanggil dari callback
        dbgLog('⏸ Scanner dijeda (pause)');
      } catch (e) {
        console.warn("Pause scanner warning:", e);
      }
    }

    // Transisi ke Langkah 2 di event loop baru agar tidak konflik dengan callback scanner
    dbgLog('⏳ Menunggu 300ms lalu transisi ke Langkah 2...');
    setTimeout(async () => {
      try {
        await stopAllCameras(); // stop penuh dilakukan di sini, di luar callback
        dbgLog('✅ Kamera dihentikan, membuka kamera depan...');

        if (!localNRP) {
          openSyncOverlay();
        } else {
          await startLivenessCamera();
          dbgLog('✅ Kamera depan aktif — Langkah 2 dimulai!');
        }
      } catch (err) {
        console.error("Transisi ke Langkah 2 gagal:", err);
        dbgLog('❌ Transisi gagal: ' + (err.message || err.toString()));
        showScanResult("Gagal membuka kamera verifikasi: " + (err.message || err.toString()), "error");
        // Reset dan kembali ke Langkah 1
        resetToScanStep1UI();
        isProcessingQRScan = false;
        setTimeout(() => startQRScanner(), 1000);
      }
    }, 300);

  } catch (error) {
    isProcessingQRScan = false;
    console.error("Format QR Code tidak valid:", error);
    dbgLog('❌ QR gagal parse: ' + error.message);
    showScanResult("Format QR Code tidak sesuai: " + error.message, "error");

    // Resume scanner agar bisa scan lagi
    setTimeout(() => {
      if (html5QrcodeScanner) {
        try { html5QrcodeScanner.resume(); } catch (e) { }
      }
    }, 2000);
  }
}

let _scanFailCount = 0;
let _scanFailTimer = null;
function onQRScanFailure(error) {
  // Hitung scan attempt dan tampilkan di debug panel setiap 2 detik
  _scanFailCount++;
  if (!_scanFailTimer) {
    _scanFailTimer = setTimeout(() => {
      dbgLog('🔄 Scan attempts: ' + _scanFailCount + ' (dalam 2 detik terakhir)');
      const dbgScannerEl = document.getElementById('dbgScannerState');
      if (dbgScannerEl) {
        const stateText = html5QrcodeScanner ?
          (html5QrcodeScanner.getState ? 'state=' + html5QrcodeScanner.getState() : 'ada') : 'null';
        dbgScannerEl.innerText = '📷 scanner: ' + stateText + ' | scan attempts: ' + _scanFailCount;
      }
      _scanFailCount = 0;
      _scanFailTimer = null;
    }, 2000);
  }
}

async function cancelScan() {
  // Reset semua state
  scannedQRData = null;
  isProcessingQRScan = false;
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
  latestLiveDescriptor = null;

  // Hapus parameter URL
  try {
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  } catch (e) { }

  // Sembunyikan result
  const resultDiv = document.getElementById('scanResult');
  if (resultDiv) {
    resultDiv.style.display = 'none';
    resultDiv.className = 'feedback-message';
  }

  // Stop semua kamera
  await stopAllCameras();

  // Reset UI ke Langkah 1
  resetToScanStep1UI();

  // Start ulang QR scanner dengan delay
  setTimeout(() => {
    startQRScanner();
  }, 300);
}

/**
 * Memulai ulang scanner QR Code pada Langkah 1 (Atau langsung ke Langkah 2 jika data QR sudah ada)
 */
async function restartQRScanner() {
  // Tampilkan debug panel dengan snapshot state saat tombol diklik
  showDebugPanel();

  if (isRestartingScanner) {
    dbgLog('❌ BLOCKED: isRestartingScanner=true, klik diabaikan');
    return;
  }
  isRestartingScanner = true;
  dbgLog('▶ Mulai proses restart...');

  const btn = document.getElementById('btnRescanQR');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Memulai ulang...';
  }

  try {
    // RESET semua state scan
    scannedQRData = null;
    isProcessingQRScan = false;
    livenessPassed = false;
    faceVerified = false;
    baselineSmileRatio = null;
    latestLiveDescriptor = null;
    dbgLog('✅ State di-reset');

    // Reset UI ke Langkah 1
    resetToScanStep1UI();
    dbgLog('✅ UI reset ke Langkah 1');

    // Hapus parameter URL jika ada
    try {
      if (window.location.search) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (e) { }

    // Sembunyikan result
    const resultDiv = document.getElementById('scanResult');
    if (resultDiv) {
      resultDiv.style.display = 'none';
      resultDiv.className = 'feedback-message';
    }

    // Hentikan semua kamera terlebih dahulu
    dbgLog('⏳ Menghentikan semua kamera...');
    await stopAllCameras();
    dbgLog('✅ Semua kamera dihentikan');

    // Beri jeda agar kamera benar-benar release
    dbgLog('⏳ Menunggu 300ms release kamera...');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Cek elemen #reader sebelum start
    const readerCheck = document.getElementById('reader');
    dbgLog(`📋 #reader saat ini: ${readerCheck ? `ada, ${readerCheck.children.length} children` : 'TIDAK ADA'}`);

    // Mulai ulang QR scanner
    dbgLog('⏳ Memanggil startQRScanner()...');
    await startQRScanner();
    dbgLog('✅ QR Scanner berhasil direstart!');
    console.log("QR Scanner berhasil direstart");

  } catch (error) {
    const msg = error.message || error.toString();
    dbgLog(`❌ ERROR: ${msg}`);
    console.error("Error saat restart QR scanner:", error);
    showScanResult("Gagal memulai ulang scanner: " + msg, "error");
  } finally {
    isRestartingScanner = false;
    const btn2 = document.getElementById('btnRescanQR');
    if (btn2) {
      btn2.disabled = false;
      btn2.innerHTML = `<svg style="width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2;" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> Scan Ulang QR Code`;
    }
    dbgLog('🏁 Selesai. isRestartingScanner=false');
  }
}

/**
 * Membuka kamera depan untuk Verifikasi Wajah & Liveness Check
 */
async function startLivenessCamera() {
  baselineSmileRatio = null; // Reset baseline saat kamera terbuka

  try { await stopAllCameras(); } catch (e) { }

  document.getElementById('scanStep1').style.display = 'none';
  document.getElementById('scanStep2').style.display = 'block';
  document.getElementById('challengeText').style.display = 'block';
  document.getElementById('challengeText').innerText = "Mendeteksi wajah Anda...";

  const video = document.getElementById('scanFaceVideo');

  try {
    scanStream = await openCameraStream("user");
    video.srcObject = scanStream;

    await video.play().catch(e => console.warn("Video play warning:", e));

    // Tunggu video dimuat sebelum memulai loop AI
    video.onloadedmetadata = () => {
      runLivenessLoop(video);
    };
    if (video.readyState >= 2) {
      runLivenessLoop(video);
    }
  } catch (error) {
    console.error("Gagal membuka kamera depan:", error);
    showScanResult("Gagal mengakses kamera depan: " + (error.message || error.toString()) + ". Pastikan izin kamera aktif.", "error");
    resetToScanStep1();
    startQRScanner();
  }
}

function stopScanCamera() {
  if (scanStream) {
    try { scanStream.getTracks().forEach(track => track.stop()); } catch (e) { }
    scanStream = null;
  }
}

/**
 * Loop Pemrosesan Deteksi Wajah, Pencocokan Identitas, dan Deteksi Senyuman (Liveness)
 */
async function runLivenessLoop(video) {
  if (!scanStream) return; // Stop jika kamera dimatikan

  const faceGuide = document.getElementById('faceGuide');
  const challengeText = document.getElementById('challengeText');

  // Deteksi wajah, landmarks 68 titik, dan deskriptor
  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (detection) {
    // 1. Deteksi Wajah Live (Bentuk Deskriptor Live untuk dikirim ke server)
    faceVerified = true;
    latestLiveDescriptor = Array.from(detection.descriptor);
    faceGuide.className = "face-guide-oval verified";

    // 2. Deteksi Liveness: Challenge Tersenyum (Dynamic Smile Detection)
    if (!livenessPassed) {
      challengeText.innerText = "Tantangan: SILAKAN TERSENYUM! 😊";

      const isSmileDetected = checkSmileLiveness(detection.landmarks);

      if (isSmileDetected) {
        livenessPassed = true;
        challengeText.innerText = "Senyuman Terdeteksi! 😊";
        stopScanCamera();

        // Pindah ke Langkah 3: Pilih Menu Absensi (2x2 Grid)
        showScanStep3();
        return;
      }
    }
  } else {
    faceVerified = false;
    latestLiveDescriptor = null;
    baselineSmileRatio = null;
    faceGuide.className = "face-guide-oval";
    challengeText.innerText = "Dekatkan wajah Anda ke kamera";
  }

  // Ulangi deteksi dalam 60ms
  setTimeout(() => runLivenessLoop(video), 60);
}

/**
 * Menghitung dan Memverifikasi Senyuman Dinamis (Membandingkan dengan Wajah Netral)
 */
function checkSmileLiveness(landmarks) {
  const mouth = landmarks.getMouth();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();

  if (!mouth || mouth.length < 10 || !leftEye || !rightEye) return false;

  // Jarak horizontal sudut bibir
  const mouthWidth = Math.hypot(mouth[6].x - mouth[0].x, mouth[6].y - mouth[0].y);
  // Jarak kedua mata
  const eyeWidth = Math.hypot(rightEye[3].x - leftEye[0].x, rightEye[3].y - leftEye[0].y);

  if (eyeWidth === 0) return false;

  const currentSmileRatio = mouthWidth / eyeWidth;

  // Tangkap rasio wajah netral saat pertama kali terdeteksi di oval
  if (baselineSmileRatio === null) {
    baselineSmileRatio = currentSmileRatio;
    return false;
  }

  // Kriteria 1: Bibir melebar setidaknya 14% dari baseline netral pengguna
  const isWidthStretched = (currentSmileRatio >= baselineSmileRatio * 1.14) && (currentSmileRatio > 0.54);

  // Kriteria 2: Terangkatnya sudut bibir
  const mouthCenterY = (mouth[0].y + mouth[6].y) / 2;
  const mouthBottomY = mouth[9].y;
  const cornerLift = (mouthBottomY - mouthCenterY) / eyeWidth;

  console.log("Current Ratio:", currentSmileRatio.toFixed(3), "Baseline:", baselineSmileRatio.toFixed(3), "Lift:", cornerLift.toFixed(3));

  // Senyum hanya dianggap VALID jika terjadi perubahan ekspresi senyum nyata dari wajah netral
  return isWidthStretched || (cornerLift > 0.20 && currentSmileRatio >= baselineSmileRatio * 1.08);
}

/**
 * Memproses Pengiriman Data Kehadiran (Online / Masuk Antrean Offline)
 * @param {string} attendanceType - "CLOCK_IN" | "START_BREAK" | "STOP_BREAK" | "CLOCK_OUT"
 * @param {string} selectedWorkingHour - Opsi Jam Kerja dari Outlet Schedule (contoh: "08:00 - 17:00")
 */
function submitAttendance(attendanceType = "CLOCK_IN", selectedWorkingHour = "") {
  const localNRP = localStorage.getItem('attendance_registered_nrp') || 'Karyawan';
  const challengeText = document.getElementById('challengeText');

  // Disable menu buttons in step 3 to prevent multiple clicks
  const menuButtons = document.querySelectorAll('#scanStep3 .menu-card');
  menuButtons.forEach(btn => {
    btn.setAttribute('disabled', 'true');
    btn.style.opacity = '0.6';
    btn.style.pointerEvents = 'none';
  });

  if (!scannedQRData || (!scannedQRData.outlet && !scannedQRData.outlet_id)) {
    console.error("Data QR Code tidak ditemukan!");
    showScanResult("Data QR Code tidak valid. Silakan scan ulang QR Code.", "error");
    setTimeout(() => {
      resetToScanStep1();
      startQRScanner();
    }, 3000);
    return;
  }

  // Pre-validasi aturan absensi secara lokal
  const todayDateStr = new Date().toISOString().split('T')[0];
  const localStatusKey = 'attendance_status_' + localNRP + '_' + todayDateStr;
  let localStatus = {};
  try {
    localStatus = JSON.parse(localStorage.getItem(localStatusKey) || '{}');
  } catch (e) { }

  const hasClockIn = localStatus.hasClockIn || false;
  const lastType = localStatus.lastType || null;

  let validationError = null;

  if (attendanceType === "CLOCK_IN") {
    if (hasClockIn) {
      validationError = "Anda sudah melakukan Clock In hari ini (tidak dapat melakukan Clock In berulang kali).";
    }
  } else if (attendanceType === "START_BREAK") {
    if (!hasClockIn) {
      validationError = "Anda harus melakukan Clock In (Masuk Kerja) terlebih dahulu sebelum Start Break.";
    } else if (lastType === "START_BREAK") {
      validationError = "Anda sedang dalam masa Istirahat (tidak dapat Start Break berulang kali).";
    } else if (lastType === "CLOCK_OUT") {
      validationError = "Anda sudah melakukan Clock Out (Pulang Kerja) untuk hari ini.";
    }
  } else if (attendanceType === "STOP_BREAK" || attendanceType === "END_BREAK") {
    if (lastType !== "START_BREAK") {
      validationError = "Stop Break hanya dapat dilakukan jika Anda telah melakukan Start Break sebelumnya.";
    } else if (lastType === "CLOCK_OUT") {
      validationError = "Anda sudah melakukan Clock Out (Pulang Kerja) untuk hari ini.";
    }
  } else if (attendanceType === "CLOCK_OUT") {
    if (!hasClockIn) {
      validationError = "Anda harus melakukan Clock In (Masuk Kerja) terlebih dahulu sebelum Clock Out.";
    } else if (lastType === "START_BREAK") {
      validationError = "Anda sedang dalam masa Istirahat. Silakan lakukan Stop Break terlebih dahulu sebelum Clock Out.";
    } else if (lastType === "CLOCK_OUT") {
      validationError = "Anda sudah melakukan Clock Out (Pulang Kerja) untuk hari ini.";
    }
  }

  if (validationError) {
    showScanResult("❌ Absensi Ditolak: " + validationError, "error");
    menuButtons.forEach(btn => {
      btn.removeAttribute('disabled');
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    });
    return;
  }

  showScanResult("⏳ Memproses lokasi GPS...", "info");

  function proceedWithPayload(lat, lng, accuracy) {
    if (lat === 0 && lng === 0) {
      showScanResult("❌ GPS HP Anda tidak aktif. Mohon aktifkan Lokasi/GPS presisi tinggi di HP Anda.", "error");
      setTimeout(() => {
        resetToScanStep1();
        startQRScanner();
      }, 4000);
      return;
    }

    if (accuracy > 150) {
      showScanResult("❌ Akurasi GPS tidak memadai (" + Math.round(accuracy) + " meter). Matikan Fake GPS / aktifkan Lokasi Presisi di HP Anda.", "error");
      setTimeout(() => {
        resetToScanStep1();
        startQRScanner();
      }, 4000);
      return;
    }

    let typeLabel = "Clock In";
    if (attendanceType === "START_BREAK") typeLabel = "Start Break";
    else if (attendanceType === "STOP_BREAK" || attendanceType === "END_BREAK") typeLabel = "Stop Break";
    else if (attendanceType === "CLOCK_OUT") typeLabel = "Clock Out";

    const payload = {
      nrp: localNRP,
      outlet: scannedQRData.outlet || scannedQRData.outlet_id,
      totp_token: scannedQRData.totp_token,
      timestamp: scannedQRData.timestamp,
      latitude: lat,
      longitude: lng,
      accuracy: Math.round(accuracy || 0),
      face_embedding: latestLiveDescriptor,
      face_verified: faceVerified,
      liveness_passed: livenessPassed,
      attendance_type: attendanceType,
      working_hour: selectedWorkingHour || "",
      device_id: getOrCreateDeviceId(),
      notes: "Absen " + typeLabel + (selectedWorkingHour ? (" (" + selectedWorkingHour + ")") : "") + " via PWA"
    };

    if (navigator.onLine) {
      sendToGAS(payload);
    } else {
      enqueueOfflineRecord(payload);
    }
  }

  // Ambil lokasi GPS HP dengan validasi presisi tinggi
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const accuracy = position.coords ? (position.coords.accuracy || 0) : 0;
        proceedWithPayload(position.coords.latitude, position.coords.longitude, accuracy);
      },
      (error) => {
        console.warn("High accuracy GPS error:", error);
        showScanResult("❌ Gagal mendapatkan lokasi GPS HP Anda. Pastikan izin lokasi aktif dan tidak menggunakan Fake GPS.", "error");
        setTimeout(() => {
          resetToScanStep1();
          startQRScanner();
        }, 4000);
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
  } else {
    showScanResult("❌ Fitur Geolocation/GPS tidak didukung pada browser ini.", "error");
  }
}

/**
 * Menyimpan status absensi lokal untuk NRP pengguna pada hari ini
 */
function saveLocalAttendanceStatus(nrp, attendanceType) {
  try {
    const todayDateStr = new Date().toISOString().split('T')[0];
    const key = 'attendance_status_' + nrp + '_' + todayDateStr;
    const current = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({
      hasClockIn: current.hasClockIn || (attendanceType === 'CLOCK_IN'),
      lastType: attendanceType
    }));
  } catch (e) { }
}

/**
 * Mengirim data langsung ke Google Apps Script Web App
 */
async function sendToGAS(payload) {
  const challengeText = document.getElementById('challengeText');
  try {
    if (challengeText) challengeText.innerText = "📤 Mengirim absensi ke server...";
    showScanResult("Mengirim data ke server Google Sheets...", "success");

    // Kirim POST tanpa no-cors untuk membaca balasan JSON resmi dari Google Apps Script
    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    let resData = null;
    try {
      resData = await response.json();
    } catch (e) {
      console.log("Membaca respon JSON standar dari GAS:", e);
    }

    if (resData && resData.status === "error") {
      console.warn("GAS menolak absensi:", resData.message);
      if (challengeText) challengeText.innerText = "❌ Gagal: " + resData.message;

      let extraTip = "";
      if (resData.message && (resData.message.toLowerCase().includes("perangkat") || resData.message.toLowerCase().includes("device"))) {
        extraTip = "<br><br><span style='font-size:0.8rem; color:#cbd5e1;'>💡 <strong>Solusi:</strong> Karena data browser pernah dihapus, silakan buka tab <strong>Registrasi</strong> dan lakukan <strong>Mulai Registrasi (Ambil Foto)</strong> untuk memperbarui Perangkat Resmi HP ini di server.</span>";
      }

      showScanResult("❌ Ditolak Server: " + resData.message + extraTip, "error");
      setTimeout(() => {
        resetToScanStep1();
        startQRScanner();
      }, 6000);
      return;
    }

    saveLocalAttendanceStatus(payload.nrp, payload.attendance_type);

    if (challengeText) challengeText.innerText = "✅ Absensi Berhasil! Menutup halaman dalam 3 detik...";
    const successMsg = resData && resData.message ? resData.message : ("Absensi sukses dikirim! Terima kasih, " + payload.nrp + ".");
    showScanResult("✅ " + successMsg, "success");

    // Berikan jeda 3 detik untuk memberikan konfirmasi ke pengguna, lalu tutup tab browser
    setTimeout(() => {
      closeBrowserTab();
    }, 3000);

  } catch (error) {
    console.error("Koneksi gagal/offline saat mengirim ke GAS:", error);
    enqueueOfflineRecord(payload);
  }
}

/**
 * Mencoba menutup tab/jendela browser setelah absensi selesai
 */
function closeBrowserTab() {
  console.log("Mencoba menutup tab browser...");
  try {
    window.opener = null;
    window.open('', '_self', '');
    window.close();
  } catch (e) {
    console.log("Window close error:", e);
  }

  // Fallback jika browser memblokir window.close() otomatis
  setTimeout(() => {
    document.body.innerHTML = `
      <div style="min-height: 100vh; background: #0b0f19; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: 'Outfit', sans-serif; text-align: center; padding: 24px;">
        <div style="width: 80px; height: 80px; background: rgba(16, 185, 129, 0.15); border: 2px solid #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; margin-bottom: 24px; box-shadow: 0 0 30px rgba(16, 185, 129, 0.3);">
          ✓
        </div>
        <h1 style="font-size: 1.8rem; font-weight: 700; color: #ffffff; margin-bottom: 8px;">Absensi Selesai!</h1>
        <p style="color: #9ca3af; font-size: 0.95rem; margin-bottom: 32px; max-width: 320px; line-height: 1.5;">
          Data kehadiran Anda telah berhasil diverifikasi dan tersimpan.
        </p>
        <button onclick="window.close();" style="background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 1rem; cursor: pointer; box-shadow: 0 10px 25px rgba(99, 102, 241, 0.4);">
          Tutup Halaman
        </button>
      </div>`;
  }, 300);
}

// =========================================================================
// OFFLINE QUEUE SYSTEM (Penanganan Sinyal Buruk)
// =========================================================================

/**
 * Memasukkan rekaman absensi ke antrean lokal HP
 */
function enqueueOfflineRecord(payload) {
  let queue = [];
  const existingQueue = localStorage.getItem('offline_attendance_queue');
  if (existingQueue) {
    queue = JSON.parse(existingQueue);
  }

  // Hindari duplikasi antrean yang sama persis (NRP + timestamp)
  const isDuplicate = queue.some(item => item.nrp === payload.nrp && item.timestamp === payload.timestamp);
  if (!isDuplicate) {
    queue.push(payload);
    localStorage.setItem('offline_attendance_queue', JSON.stringify(queue));
  }

  saveLocalAttendanceStatus(payload.nrp, payload.attendance_type);

  updateOfflineBadge();
  showScanResult("Koneksi internet lambat/mati. Absen Anda berhasil diverifikasi & disimpan lokal secara aman. Otomatis disinkronkan saat sinyal membaik.", "warning");

  setTimeout(() => {
    closeBrowserTab();
  }, 3500);
}

/**
 * Menyinkronkan semua data absensi offline di antrean lokal ke Google Sheets
 */
async function syncOfflineQueue() {
  const existingQueue = localStorage.getItem('offline_attendance_queue');
  if (!existingQueue) return;

  const queue = JSON.parse(existingQueue);
  if (queue.length === 0) return;

  console.log("Mencoba sinkronisasi " + queue.length + " rekaman absensi offline...");

  let successCount = 0;

  for (let i = 0; i < queue.length; i++) {
    try {
      await fetch(GAS_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queue[i])
      });
      successCount++;
    } catch (err) {
      console.error("Gagal menyinkronkan rekaman index " + i + ":", err);
      break; // Stop loop jika jaringan mati lagi
    }
  }

  if (successCount > 0) {
    console.log("Berhasil menyinkronkan " + successCount + " data absensi offline.");
    const remainingQueue = queue.slice(successCount);
    localStorage.setItem('offline_attendance_queue', JSON.stringify(remainingQueue));
    updateOfflineBadge();
  }
}

function updateOfflineBadge() {
  const existingQueue = localStorage.getItem('offline_attendance_queue');
  const badge = document.getElementById('offlineBadge');

  if (existingQueue) {
    const queue = JSON.parse(existingQueue);
    if (queue.length > 0) {
      badge.innerText = queue.length;
      badge.style.display = 'inline-block';
      return;
    }
  }
  badge.style.display = 'none';
}

function showScanResult(message, type) {
  const resultDiv = document.getElementById('scanResult');
  if (resultDiv) {
    resultDiv.innerHTML = message;
    resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : type === 'warning' ? 'feedback-success' : 'feedback-error');
    resultDiv.style.display = 'block';
  }

  if (type === 'warning') {
    resultDiv.style.borderColor = 'var(--warning)';
    resultDiv.style.color = 'var(--warning)';
  }
}

// =========================================================================
// REGISTRASI KARYAWAN FLOW
// =========================================================================

async function startRegistrationFlow() {
  const nrpInput = document.getElementById('regNRP');
  const nrp = nrpInput ? nrpInput.value.trim() : '';

  if (!nrp) {
    showRegResult("Harap isi NRP Anda sebelum memulai registrasi wajah.", "error");
    return;
  }

  showRegResult("Membuka kamera depan...", "success");

  try { await stopAllCameras(); } catch (e) { }

  document.getElementById('btnStartReg').style.display = 'none';
  document.getElementById('registerCameraArea').style.display = 'block';

  const btnCapture = document.getElementById('btnCapturePhoto');
  if (btnCapture) {
    btnCapture.disabled = false;
    btnCapture.style.display = 'block';
    btnCapture.innerHTML = 'Ambil Foto';
  }

  const video = document.getElementById('regFaceVideo');

  try {
    regStream = await openCameraStream("user");
    video.srcObject = regStream;
    await video.play().catch(e => console.warn("Video play warning:", e));
  } catch (error) {
    console.error("Gagal membuka kamera registrasi:", error);
    showRegResult("Gagal mengakses kamera depan: " + (error.message || error.toString()) + ". Pastikan izin kamera diizinkan di browser Anda.", "error");
    stopRegistrationCamera();
  }
}

function stopRegistrationCamera() {
  if (regStream) {
    try { regStream.getTracks().forEach(track => track.stop()); } catch (e) { }
    regStream = null;
  }
  const area = document.getElementById('registerCameraArea');
  const btn = document.getElementById('btnStartReg');
  const btnCapture = document.getElementById('btnCapturePhoto');
  if (btnCapture) {
    btnCapture.disabled = false;
    btnCapture.classList.remove('btn-loading', 'btn-secondary');
    btnCapture.className = 'btn';
    btnCapture.removeAttribute('style');
    btnCapture.style.display = 'block';
    btnCapture.innerHTML = 'Ambil Foto';
  }
  if (area) area.style.display = 'none';
  if (btn) btn.style.display = 'block';
}

/**
 * Mengambil Sampel Embedding Wajah untuk NRP Karyawan
 */
async function captureFaceEmbeddings(btnElement) {
  const btnCapture = btnElement || document.getElementById('btnCapturePhoto');

  function setButtonState(loading) {
    if (btnCapture) {
      btnCapture.disabled = loading;
      if (loading) {
        btnCapture.style.display = 'none';
      } else {
        btnCapture.classList.remove('btn-loading', 'btn-secondary');
        btnCapture.removeAttribute('style');
        btnCapture.className = 'btn';
        btnCapture.style.display = 'block';
        btnCapture.innerHTML = 'Ambil Foto';
      }
    }
  }

  // Langsung nonaktifkan tombol begitu diklik
  setButtonState(true);

  if (!isModelsLoaded) {
    showRegResult("Model AI Wajah belum selesai diunduh. Mohon tunggu sejenak...", "error");
    setTimeout(() => setButtonState(false), 1500);
    return;
  }

  const video = document.getElementById('regFaceVideo');
  const nrpInput = document.getElementById('regNRP');
  const nrp = nrpInput ? nrpInput.value.trim() : '';

  if (!nrp) {
    showRegResult("Harap masukkan NRP Anda sebelum mendaftar.", "error");
    setTimeout(() => setButtonState(false), 1500);
    return;
  }

  // Jika video belum siap, tunggu hingga 600ms
  if (!regStream || video.paused || video.ended || video.readyState < 2) {
    console.warn("Menunggu video kamera siap...");
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  if (!regStream) {
    showRegResult("Kamera belum aktif. Posisikan wajah Anda di dalam oval.", "error");
    setTimeout(() => setButtonState(false), 1500);
    return;
  }

  showRegResult("⏳ Memproses & memverifikasi registrasi di server cloud...", "success");

  try {
    // 1. Deteksi Wajah dengan opsi bertingkat
    let detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      // Fallback detektor dengan ambang batas lebih fleksibel
      detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    }

    if (detection) {
      const embeddingArray = Array.from(detection.descriptor);
      const deviceId = getOrCreateDeviceId();

      // 2. Kirim registrasi wajah & Device ID ke server cloud Google Sheets DULU untuk validasi
      const resData = await uploadFaceEmbeddingToCloud(nrp, embeddingArray, deviceId);

      // 3. Jika server menolak registrasi (misal: Device sudah dipakai oleh NRP lain)
      if (resData && resData.status === "error") {
        console.warn("Registrasi ditolak server:", resData.message);
        showRegResult("❌ Ditolak Server: " + resData.message, "error");
        setTimeout(() => setButtonState(false), 2000);
        return;
      }

      // 4. Jika server menyetujui, simpan NRP & Device ID ke LocalStorage HP
      localStorage.setItem('attendance_registered_nrp', nrp);
      localStorage.removeItem('attendance_registered_embeddings');
      localStorage.setItem('attendance_registered_device_id', deviceId);

      const serverMessage = resData && resData.message ? resData.message : ("Registrasi Wajah NRP " + nrp + " Berhasil!");
      showRegResult("✅ " + serverMessage, "success");

      setTimeout(() => {
        setButtonState(false);
        stopRegistrationCamera();
        switchView('scan');
      }, 3500);

    } else {
      showRegResult("Wajah tidak terdeteksi. Posisikan wajah Anda tegak lurus dan pencahayaan terang di dalam oval panduan.", "error");
      setTimeout(() => setButtonState(false), 2000);
    }
  } catch (err) {
    console.error("Gagal memproses gambar dari kamera:", err);
    showRegResult("Gagal memproses gambar dari kamera: " + (err.message || err.toString()), "error");
    setTimeout(() => setButtonState(false), 2000);
  }
}

function showRegResult(message, type) {
  const resultDiv = document.getElementById('regResult');
  resultDiv.innerText = message;
  resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : 'feedback-error');
  resultDiv.style.display = 'block';
}

/**
 * Mengunggah data template wajah & Device ID ke cloud (Google Sheets tab Face_Embedding) setelah registrasi sukses
 */
async function uploadFaceEmbeddingToCloud(nrp, embedding, deviceId) {
  const activeDeviceId = deviceId || getOrCreateDeviceId();
  if (!navigator.onLine) {
    console.log("Registrasi wajah cloud ditunda (offline).");
    return { status: "error", message: "Koneksi internet terputus. Mohon hubungkan ke internet untuk melakukan registrasi." };
  }
  try {
    const payload = {
      action: "register_face",
      nrp: nrp,
      face_embedding: embedding,
      device_id: activeDeviceId
    };

    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    let resData = null;
    try {
      resData = await response.json();
    } catch (e) {
      console.log("Membaca respon JSON dari GAS register_face:", e);
    }

    if (resData) {
      return resData;
    }
    return { status: "success", message: "Registrasi wajah berhasil disimpan." };
  } catch (err) {
    console.error("Gagal mengunggah data wajah ke cloud:", err);
    return { status: "error", message: "Gagal terhubung ke server cloud: " + err.toString() };
  }
}


/**
 * Menyinkronkan Profil Wajah Karyawan dari Cloud jika PWA dibuka di browser baru / setelah clear cache
 */
async function syncFaceProfile(btnElement) {
  const btnSync = btnElement || document.getElementById('btnSyncProfile');

  function setSyncBtnState(loading) {
    if (btnSync) {
      btnSync.disabled = loading;
      if (loading) {
        btnSync.style.display = 'none';
      } else {
        btnSync.disabled = false;
        btnSync.classList.remove('btn-secondary');
        btnSync.removeAttribute('style');
        btnSync.className = 'btn';
        btnSync.style.display = 'block';
        btnSync.style.marginBottom = '12px';
        btnSync.innerHTML = 'Sinkronkan Perangkat';
      }
    }
  }

  // Langsung sembunyikan & nonaktifkan tombol begitu diklik (karakteristik persis Ambil Foto)
  setSyncBtnState(true);

  const syncNrpInput = document.getElementById('syncNRP');
  const nrp = syncNrpInput ? syncNrpInput.value.trim() : '';

  if (!nrp) {
    showSyncResult("Harap masukkan NRP Anda.", "error");
    setTimeout(() => setSyncBtnState(false), 1500);
    return;
  }

  if (!navigator.onLine) {
    showSyncResult("Koneksi offline. Tidak dapat menyinkronkan profil wajah dari cloud.", "error");
    setTimeout(() => setSyncBtnState(false), 1500);
    return;
  }

  showSyncResult("⏳ Memeriksa profil wajah NRP " + nrp + " di cloud...", "success");

  try {
    const deviceId = getOrCreateDeviceId();
    let data = null;

    // 1. Coba GET dengan action=get_face_embedding & device_id
    try {
      const url = `${GAS_URL}?action=get_face_embedding&nrp=${encodeURIComponent(nrp)}&device_id=${encodeURIComponent(deviceId)}`;
      const response = await fetch(url, { redirect: "follow" });
      const text = await response.text();
      data = JSON.parse(text);
    } catch (e) { }

    // 2. Jika gagal, coba GET tanpa device_id (kasus clear cache / device_id baru)
    if (!data || (data.status !== "success" && data.status !== "ok")) {
      try {
        const urlNoDevice = `${GAS_URL}?action=get_face_embedding&nrp=${encodeURIComponent(nrp)}`;
        const resp2 = await fetch(urlNoDevice, { redirect: "follow" });
        const text2 = await resp2.text();
        const data2 = JSON.parse(text2);
        if (data2 && (data2.status === "success" || data2.status === "ok")) {
          data = data2;
        }
      } catch (e) { }
    }

    // 3. Fallback ketiga: coba POST request
    if (!data || (data.status !== "success" && data.status !== "ok")) {
      try {
        const postResp = await fetch(GAS_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "get_face_embedding", nrp: nrp, device_id: deviceId })
        });
        const postText = await postResp.text();
        const postData = JSON.parse(postText);
        if (postData && (postData.status === "success" || postData.status === "ok")) {
          data = postData;
        }
      } catch (e) { }
    }

    if (data && (data.status === "success" || data.status === "ok")) {
      const embeddingArray = data.message || data.face_embedding || data.embedding || data.data;
      const serverDeviceId = data.device_id || data.registered_device_id || (data.data && typeof data.data === 'object' ? data.data.device_id : null);

      // Simpan di localStorage browser ini
      localStorage.setItem('attendance_registered_nrp', nrp);
      if (embeddingArray) {
        localStorage.setItem('attendance_registered_embeddings', typeof embeddingArray === 'string' ? embeddingArray : JSON.stringify(embeddingArray));
        registeredEmbeddings = embeddingArray;
      }

      // Jika server mengembalikan Device ID resmi dari Google Sheets, perbarui local device_id
      if (serverDeviceId) {
        localStorage.setItem('attendance_device_id', serverDeviceId);
        localStorage.setItem('attendance_registered_device_id', serverDeviceId);
        console.log('[DBG] Device ID resmi disinkronkan dari server:', serverDeviceId);
      } else {
        localStorage.setItem('attendance_registered_device_id', deviceId);
        try {
          fetch(GAS_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "update_device_id", nrp: nrp, device_id: deviceId })
          }).catch(() => { });
        } catch (e) { }
      }

      showSyncResult("✅ Perangkat berhasil disinkronkan! Profil NRP " + nrp + " terverifikasi.", "success");

      setTimeout(() => {
        setSyncBtnState(false);
        closeSyncOverlay();
        // LANGKAH 2: Tetap di Layar Scan Absen (viewScan), TIDAK MASUK KE TAB REGISTRASI
        if (scannedQRData) {
          startLivenessCamera();
        } else {
          startQRScanner();
        }
      }, 1800);
    } else {
      const serverMsg = (data && data.message) ? data.message : ("NRP (" + nrp + ") belum terdaftar di database cloud.");
      showSyncResult("❌ " + serverMsg + "<br><br><span style='font-size:0.8rem; color:#cbd5e1;'>Pastikan NRP sudah pernah didaftarkan.</span>", "error");
      setTimeout(() => setSyncBtnState(false), 2000);
    }
  } catch (err) {
    console.error("Gagal sinkronisasi wajah:", err);
    showSyncResult("❌ Gagal terhubung ke server cloud: " + (err.message || err.toString()), "error");
    setTimeout(() => setSyncBtnState(false), 2000);
  }
}

function closeSyncOverlay() {
  const overlay = document.getElementById('syncNrpOverlay');
  const result = document.getElementById('syncResult');
  const input = document.getElementById('syncNRP');
  const btnSync = document.getElementById('btnSyncProfile');

  if (overlay) overlay.style.display = 'none';
  if (result) result.style.display = 'none';
  if (input) input.value = '';

  if (btnSync) {
    btnSync.disabled = false;
    btnSync.removeAttribute('style');
    btnSync.className = 'btn';
    btnSync.style.display = 'block';
    btnSync.style.marginBottom = '12px';
    btnSync.innerHTML = 'Sinkronkan Perangkat';
  }
}

function goToRegistrationFromOverlay() {
  const syncNRPInput = document.getElementById('syncNRP');
  const regNRPInput = document.getElementById('regNRP');
  const nrpVal = syncNRPInput ? syncNRPInput.value.trim() : '';

  closeSyncOverlay();
  switchView('register');

  if (regNRPInput && nrpVal) {
    regNRPInput.value = nrpVal;
  }
}

function openSyncOverlay() {
  const overlay = document.getElementById('syncNrpOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function showSyncResult(message, type) {
  const resultDiv = document.getElementById('syncResult');
  if (resultDiv) {
    resultDiv.innerHTML = message;
    resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : 'feedback-error');
    resultDiv.style.display = 'block';
  }
}