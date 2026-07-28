/**
 * Smart Attendance PWA - Client Logic
 * Menangani Scanner QR, Deteksi Wajah, Liveness Challenge (Kedipan), dan Antrean Offline
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

// Variabel Data dari Hasil Scan QR Code PC
let scannedQRData = null;

// Keadaan Liveness Check
let blinkCount = 0;
let isBlinked = false;
let livenessPassed = false;
let faceVerified = false;

/**
 * Mendapatkan atau Membuat UUID Unik Perangkat (Device ID Persistent)
 */
function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem('attendance_device_id');
  if (!deviceId) {
    deviceId = 'DEV-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substring(2)));
    localStorage.setItem('attendance_device_id', deviceId);
  }
  return deviceId;
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
    document.getElementById('viewScan').classList.add('active');
    startQRScanner();
  } else {
    document.getElementById('viewRegister').classList.add('active');
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
 * dan membebaskan hardware kamera secara bersih.
 */
async function stopAllCameras() {
  if (scanStream) {
    try {
      scanStream.getTracks().forEach(track => {
        try { track.stop(); } catch(e){}
      });
    } catch(e){}
    scanStream = null;
  }

  if (regStream) {
    try {
      regStream.getTracks().forEach(track => {
        try { track.stop(); } catch(e){}
      });
    } catch(e){}
    regStream = null;
  }

  if (html5QrcodeScanner) {
    try {
      const isScanning = html5QrcodeScanner.isScanning || (html5QrcodeScanner.getState && html5QrcodeScanner.getState() === 2);
      if (isScanning) {
        await html5QrcodeScanner.stop().catch(err => console.warn("Scanner stop warning:", err));
      }
      try { html5QrcodeScanner.clear(); } catch(err){}
    } catch (e) {
      console.warn("Cleanup scanner instance warning:", e);
    }
    html5QrcodeScanner = null;
  }
}

/**
 * Menyalakan Kamera QR Code Reader di HP
 */
async function startQRScanner() {
  try { await stopAllCameras(); } catch(e){}

  // Tampilkan Step 1, Sembunyikan Step 2
  resetToScanStep1();

  const config = { 
    fps: 15,
    aspectRatio: 1.333333 // 4:3 matching viewport (full frame scanning)
  };

  // 1. Coba kamera belakang (environment)
  try {
    html5QrcodeScanner = new Html5Qrcode("reader");
    await html5QrcodeScanner.start(
      { facingMode: "environment" },
      config,
      onQRScanSuccess,
      onQRScanFailure
    );
    console.log("Kamera QR scanner aktif (kamera belakang).");
  } catch (err1) {
    console.warn("Gagal membuka kamera belakang, mencoba kamera depan/webcam:", err1);
    // 2. Fallback: Re-instantiate Html5Qrcode baru & coba kamera user/webcam
    try {
      try { await stopAllCameras(); } catch(e){}
      html5QrcodeScanner = new Html5Qrcode("reader");
      await html5QrcodeScanner.start(
        { facingMode: "user" },
        config,
        onQRScanSuccess,
        onQRScanFailure
      );
      console.log("Kamera QR scanner aktif (kamera user/webcam).");
    } catch (err2) {
      console.error("Gagal total menyalakan kamera scanner:", err2);
      showScanResult("Gagal membuka kamera: " + (err2.message || err2.toString()) + ". Pastikan izin kamera diizinkan di browser Anda.", "error");
    }
  }
}

async function onQRScanSuccess(decodedText, decodedResult) {
  try {
    console.log("QR Code terdeteksi:", decodedText);

    // 1. Periksa jika decodedText berupa URL atau JSON string
    if (decodedText.startsWith("http://") || decodedText.startsWith("https://")) {
      const url = new URL(decodedText);
      const outlet = url.searchParams.get('outlet') || url.searchParams.get('outlet_id');
      const timestamp = url.searchParams.get('timestamp');
      const totpToken = url.searchParams.get('totp_token');
      
      if (!outlet || !totpToken || !timestamp) {
        throw new Error("Parameter URL QR Code tidak lengkap");
      }
      
      scannedQRData = {
        outlet: outlet,
        timestamp: Number(timestamp),
        totp_token: totpToken
      };

      // Redirect / update URL browser ke link QR Code yang baru di-scan
      try {
        window.history.replaceState({}, '', decodedText);
      } catch(e){}

    } else {
      // Fallback format JSON
      scannedQRData = JSON.parse(decodedText);
      const outletVal = scannedQRData.outlet || scannedQRData.outlet_id;
      
      if (!outletVal || !scannedQRData.totp_token || !scannedQRData.timestamp) {
        throw new Error("Format JSON QR Code tidak sesuai");
      }
      scannedQRData.outlet = outletVal;
    }

    console.log("QR Code baru berhasil diproses:", scannedQRData);

    const localNRP = localStorage.getItem('attendance_registered_nrp');
    if (!localNRP) {
      // Matikan scanner secara bersih agar tidak mentrigger callback berulang
      if (html5QrcodeScanner) {
        try {
          if (html5QrcodeScanner.isScanning) {
            html5QrcodeScanner.stop().catch(e => console.log(e));
          }
        } catch(e){}
      }
      openSyncOverlay(); // Tampilkan overlay registrasi profil Karyawan
      return;
    }

    // 3. Pindah langsung ke Langkah 2: Deteksi Wajah & Liveness dengan QR Code baru
    setTimeout(() => {
      startLivenessCamera();
    }, 50);

  } catch (error) {
    console.error("Format QR Code tidak valid:", error);
    showScanResult("Format QR Code salah. Pastikan men-scan QR absensi resmi di layar PC outlet.", "error");
  }
}

function onQRScanFailure(error) {
  // Silent failure (terus memindai)
}

function cancelScan() {
  stopScanCamera();
  resetToScanStep1();
  startQRScanner();
}

/**
 * Memulai ulang scanner QR Code pada Langkah 1 (Bersihkan data QR lama & baca ulang QR baru)
 */
async function restartQRScanner() {
  // Bersihkan parameter URL lama dari browser agar tidak terbaca ulang
  try {
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  } catch(e){}

  const resultDiv = document.getElementById('scanResult');
  if (resultDiv) resultDiv.style.display = 'none';
  showScanResult("⏳ Memulai ulang kamera QR Code scanner...", "success");
  await startQRScanner();
  setTimeout(() => {
    if (resultDiv) resultDiv.style.display = 'none';
  }, 1500);
}

let baselineSmileRatio = null;

function resetToScanStep1() {
  document.getElementById('scanStep1').style.display = 'block';
  document.getElementById('scanStep2').style.display = 'none';
  document.getElementById('scanResult').style.display = 'none';
  scannedQRData = null;
  livenessPassed = false;
  faceVerified = false;
  baselineSmileRatio = null;
}

/**
 * Membuka kamera depan untuk Verifikasi Wajah & Liveness Check
 */
async function startLivenessCamera() {
  baselineSmileRatio = null; // Reset baseline saat kamera terbuka

  try { await stopAllCameras(); } catch(e){}

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
    try { scanStream.getTracks().forEach(track => track.stop()); } catch(e){}
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
        challengeText.innerText = "Senyuman Terdeteksi! 😊 Mengirim sampel ke server...";
        stopScanCamera();

        // Kirim absen beserta live descriptor ke server cloud
        submitAttendance(latestLiveDescriptor);
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

  // Kriteria 1: Bibir melebar setidaknya 14% dari baseline netral pengguna (currentSmileRatio >= baselineSmileRatio * 1.14)
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
 */
function submitAttendance(liveFaceDescriptor) {
  const localNRP = localStorage.getItem('attendance_registered_nrp') || 'Karyawan';
  const challengeText = document.getElementById('challengeText');

  if (!scannedQRData || (!scannedQRData.outlet && !scannedQRData.outlet_id)) {
    console.error("Data QR Code tidak ditemukan!");
    showScanResult("Data QR Code tidak valid. Silakan scan ulang QR Code.", "error");
    setTimeout(() => {
      resetToScanStep1();
      startQRScanner();
    }, 3000);
    return;
  }

  if (challengeText) {
    challengeText.style.display = 'block';
    challengeText.innerText = "⏳ Memproses lokasi GPS...";
  }

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

    const payload = {
      nrp: localNRP,
      outlet: scannedQRData.outlet || scannedQRData.outlet_id,
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
      notes: "Absen QR via PWA (Akurasi GPS: " + Math.round(accuracy || 0) + "m)"
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
    } catch(e) {
      console.log("Membaca respon JSON standar dari GAS:", e);
    }

    if (resData && resData.status === "error") {
      console.warn("GAS menolak absensi:", resData.message);
      if (challengeText) challengeText.innerText = "❌ Gagal: " + resData.message;
      showScanResult("❌ Ditolak Server: " + resData.message, "error");
      setTimeout(() => {
        resetToScanStep1();
        startQRScanner();
      }, 5000);
      return;
    }

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
  resultDiv.innerText = message;
  resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : type === 'warning' ? 'feedback-success' : 'feedback-error');
  resultDiv.style.display = 'block';

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

  try { await stopAllCameras(); } catch(e){}

  document.getElementById('btnStartReg').style.display = 'none';
  document.getElementById('registerCameraArea').style.display = 'block';

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
    try { regStream.getTracks().forEach(track => track.stop()); } catch(e){}
    regStream = null;
  }
  const area = document.getElementById('registerCameraArea');
  const btn = document.getElementById('btnStartReg');
  const btnCapture = document.getElementById('btnCapturePhoto');
  if (btnCapture) {
    btnCapture.disabled = false;
    btnCapture.className = 'btn';
    btnCapture.innerHTML = 'Ambil Foto';
    btnCapture.style.background = '';
    btnCapture.style.pointerEvents = 'auto';
    btnCapture.style.opacity = '1';
  }
  if (area) area.style.display = 'none';
  if (btn) btn.style.display = 'block';
}

/**
 * Mengambil Sampel Embedding Wajah untuk NRP Karyawan
 */
async function captureFaceEmbeddings() {
  const btnCapture = document.getElementById('btnCapturePhoto');

  function setButtonState(loading) {
    if (btnCapture) {
      btnCapture.disabled = loading;
      btnCapture.className = loading ? 'btn btn-secondary' : 'btn';
      btnCapture.innerHTML = loading ? '⏳ Memproses...' : 'Ambil Foto';
      btnCapture.style.background = loading ? 'transparent' : '';
      btnCapture.style.pointerEvents = loading ? 'none' : 'auto';
      btnCapture.style.opacity = loading ? '0.6' : '1';
    }
  }

  // Langsung nonaktifkan tombol begitu diklik
  setButtonState(true);

  if (!isModelsLoaded) {
    showRegResult("Model AI Wajah belum selesai diunduh. Mohon tunggu sejenak.", "error");
    setButtonState(false);
    return;
  }

  const video = document.getElementById('regFaceVideo');
  const nrpInput = document.getElementById('regNRP');
  const nrp = nrpInput ? nrpInput.value.trim() : '';

  if (!nrp) {
    showRegResult("Harap masukkan NRP Anda sebelum mendaftar.", "error");
    setButtonState(false);
    return;
  }

  if (!regStream || video.paused || video.ended || video.readyState < 2) {
    showRegResult("Kamera belum siap. Posisikan wajah Anda di dalam oval dan pastikan kamera depan aktif.", "error");
    setButtonState(false);
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
        setButtonState(false);
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
      setButtonState(false);
    }
  } catch (err) {
    console.error("Gagal memproses gambar dari kamera:", err);
    showRegResult("Gagal memproses gambar dari kamera: " + (err.message || err.toString()), "error");
    setButtonState(false);
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
 * Menyinkronkan Profil Wajah Karyawan dari Cloud jika PWA dibuka di browser baru
 */
async function syncFaceProfile() {
  const syncResult = document.getElementById('syncResult');
  const syncNrpInput = document.getElementById('syncNRP');
  const nrp = syncNrpInput.value.trim();
  
  if (!nrp) {
    showSyncResult("Harap masukkan NRP Anda.", "error");
    return;
  }
  
  if (!navigator.onLine) {
    showSyncResult("Koneksi offline. Tidak dapat menyinkronkan profil wajah dari cloud.", "error");
    return;
  }
  
  showSyncResult("Mendownload profil wajah dari cloud...", "success");
  
  try {
    const deviceId = getOrCreateDeviceId();
    const url = `${GAS_URL}?action=get_face_embedding&nrp=${nrp}&device_id=${deviceId}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status === "success") {
      const embeddingArray = data.message;
      
      // Simpan di localStorage browser baru ini
      localStorage.setItem('attendance_registered_nrp', nrp);
      localStorage.setItem('attendance_registered_embeddings', JSON.stringify(embeddingArray));
      
      // Update variabel global
      registeredEmbeddings = embeddingArray;
      
      showSyncResult("Perangkat berhasil disinkronkan! Profil wajah " + nrp + " diunduh.", "success");
      
      setTimeout(() => {
        closeSyncOverlay();
        // Jalankan kamera verifikasi wajah langsung jika data QR sudah siap
        if (scannedQRData) {
          startLivenessCamera();
        } else {
          startQRScanner();
        }
      }, 2000);
    } else {
      showSyncResult("Gagal: " + data.message, "error");
    }
  } catch (err) {
    console.error("Gagal sinkronisasi wajah:", err);
    showSyncResult("NRP tidak ditemukan atau belum terdaftar wajahnya di cloud.", "error");
  }
}

function closeSyncOverlay() {
  document.getElementById('syncNrpOverlay').style.display = 'none';
  document.getElementById('syncResult').style.display = 'none';
  document.getElementById('syncNRP').value = '';
}

function openSyncOverlay() {
  document.getElementById('syncNrpOverlay').style.display = 'flex';
}

function showSyncResult(message, type) {
  const resultDiv = document.getElementById('syncResult');
  resultDiv.innerText = message;
  resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : 'feedback-error');
  resultDiv.style.display = 'block';
}
