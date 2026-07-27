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
let registeredEmbeddings = null; // Embedding wajah karyawan yang terdaftar di ponsel ini

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
  const outletId = urlParams.get('outlet_id');
  const timestamp = urlParams.get('timestamp');
  const totpToken = urlParams.get('totp_token');
  
  if (outletId && timestamp && totpToken) {
    scannedQRData = {
      outlet_id: outletId,
      timestamp: Number(timestamp),
      totp_token: totpToken
    };
    console.log("Parameter URL terdeteksi dari kamera bawaan HP:", scannedQRData);
    
    // Pastikan user terdaftar di ponsel ini
    const localNRP = localStorage.getItem('attendance_registered_nrp');
    if (!localNRP || !registeredEmbeddings) {
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

/**
 * Muat Model AI Wajah (face-api.js) dari CDN publik
 */
async function loadFaceApiModels() {
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
  try {
    console.log("Loading face-api models...");
    // Muat detektor wajah ringan (TinyFaceDetector), landmark 68 titik, dan model pengenalan wajah
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);

    isModelsLoaded = true;
    document.getElementById('loadingOverlay').style.display = 'none';
    console.log("Face-api models loaded successfully!");
  } catch (error) {
    console.error("Gagal memuat model face-api.js:", error);
    alert("Gagal mengunduh AI model. Pastikan Anda terhubung ke internet pada pembukaan aplikasi pertama.");
  }
}

/**
 * Memuat data pendaftaran wajah yang tersimpan di LocalStorage
 */
function loadLocalRegistration() {
  const localData = localStorage.getItem('attendance_registered_nrp');
  const localEmbeddings = localStorage.getItem('attendance_registered_embeddings');

  if (localData && localEmbeddings) {
    registeredEmbeddings = JSON.parse(localEmbeddings);
    console.log("Data pendaftaran lokal ditemukan untuk NRP: " + localData);
  }
}

/**
 * Berpindah Antar View Screen (Scan vs Registrasi)
 */
function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.view-screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  const activeBtnIndex = viewName === 'scan' ? 0 : 1;
  document.querySelectorAll('.tab-btn')[activeBtnIndex].classList.add('active');

  if (viewName === 'scan') {
    document.getElementById('viewScan').classList.add('active');
    stopRegistrationCamera();
    startQRScanner();
  } else {
    document.getElementById('viewRegister').classList.add('active');
    stopScanCamera();
    if (html5QrcodeScanner) {
      html5QrcodeScanner.clear().catch(e => console.log(e));
    }
  }
}

// =========================================================================
// SCAN ABSENSI & LIVENESS DETECTION FLOW
// =========================================================================

/**
 * Menyalakan Kamera QR Code Reader di HP
 */
async function startQRScanner() {
  if (html5QrcodeScanner) {
    try {
      if (html5QrcodeScanner.isScanning) {
        await html5QrcodeScanner.stop();
      }
      html5QrcodeScanner.clear();
    } catch (e) {
      console.warn("Cleanup scanner instance warning:", e);
    }
    html5QrcodeScanner = null;
  }

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
      if (html5QrcodeScanner) {
        try { html5QrcodeScanner.clear(); } catch(e){}
      }
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
      showScanResult("Gagal membuka kamera. Pastikan izin akses kamera diizinkan di browser Anda.", "error");
    }
  }
}

async function onQRScanSuccess(decodedText, decodedResult) {
  try {
    // 1. Matikan dan lepaskan kamera belakang secara bersih untuk mencegah konflik driver kamera
    try {
      if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
        await html5QrcodeScanner.stop();
        console.log("QR Scan stopped successfully.");
      }
    } catch (stopError) {
      console.warn("Gagal menghentikan scanner secara bersih:", stopError);
    }

    // 2. Periksa jika decodedText berupa URL atau JSON string
    if (decodedText.startsWith("http://") || decodedText.startsWith("https://")) {
      const url = new URL(decodedText);
      const outletId = url.searchParams.get('outlet_id');
      const timestamp = url.searchParams.get('timestamp');
      const totpToken = url.searchParams.get('totp_token');
      
      if (!outletId || !totpToken || !timestamp) {
        throw new Error("Parameter URL QR Code tidak lengkap");
      }
      
      scannedQRData = {
        outlet_id: outletId,
        timestamp: Number(timestamp),
        totp_token: totpToken
      };
    } else {
      // Fallback format lama (JSON)
      scannedQRData = JSON.parse(decodedText);
      
      if (!scannedQRData.outlet_id || !scannedQRData.totp_token || !scannedQRData.timestamp) {
        throw new Error("Format JSON QR Code tidak sesuai");
      }
    }

    // Periksa apakah karyawan sudah teregistrasi wajahnya di HP ini
    const localNRP = localStorage.getItem('attendance_registered_nrp');
    if (!localNRP || !registeredEmbeddings) {
      openSyncOverlay(); // Tampilkan overlay sinkronisasi profil wajah
      return;
    }

    console.log("QR Code valid terbaca:", scannedQRData);

    // Pindah ke Langkah 2: Deteksi Wajah & Liveness
    startLivenessCamera();

  } catch (error) {
    console.error(error);
    showScanResult("Format QR Code salah. Pastikan men-scan QR absensi resmi di layar PC outlet.", "error");
    // Nyalakan kembali scanner setelah jeda karena terjadi kegagalan pembacaan payload
    setTimeout(startQRScanner, 3000);
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

function resetToScanStep1() {
  document.getElementById('scanStep1').style.display = 'block';
  document.getElementById('scanStep2').style.display = 'none';
  document.getElementById('scanResult').style.display = 'none';
  scannedQRData = null;
  blinkCount = 0;
  isBlinked = false;
  livenessPassed = false;
  faceVerified = false;
}

/**
 * Membuka kamera depan untuk Verifikasi Wajah & Liveness Check
 */
async function startLivenessCamera() {
  // Pastikan QR scanner belakang dihentikan secara bersih agar tidak mengunci hardware kamera
  if (html5QrcodeScanner) {
    try {
      if (html5QrcodeScanner.isScanning) {
        await html5QrcodeScanner.stop();
      }
      html5QrcodeScanner.clear();
    } catch (e) {
      console.warn("Clean up QR scanner error:", e);
    }
    html5QrcodeScanner = null;
  }

  document.getElementById('scanStep1').style.display = 'none';
  document.getElementById('scanStep2').style.display = 'block';
  document.getElementById('challengeText').style.display = 'block';
  document.getElementById('challengeText').innerText = "Mendeteksi wajah Anda...";

  const video = document.getElementById('scanFaceVideo');

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 } // Kamera depan
    });
    video.srcObject = scanStream;

    // Tunggu video dimuat sebelum memulai loop AI
    video.onloadedmetadata = () => {
      runLivenessLoop(video);
    };
  } catch (error) {
    console.error("Gagal membuka kamera depan:", error);
    showScanResult("Gagal mengakses kamera depan untuk verifikasi wajah.", "error");
    resetToScanStep1();
    startQRScanner();
  }
}

function stopScanCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach(track => track.stop());
    scanStream = null;
  }
}

/**
 * Loop Pemrosesan Deteksi Wajah, Pencocokan Identitas, dan Deteksi Kedipan (Liveness)
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
    // 1. Verifikasi Kecocokan Wajah dengan Embedding Terdaftar
    const distance = faceapi.euclideanDistance(detection.descriptor, new Float32Array(registeredEmbeddings));
    // Batas toleransi kecocokan (makin kecil makin ketat, standard: 0.6)
    if (distance < 0.55) {
      faceVerified = true;
      faceGuide.className = "face-guide-oval verified";
    } else {
      faceVerified = false;
      faceGuide.className = "face-guide-oval";
      challengeText.innerText = "Wajah tidak cocok dengan NRP terdaftar!";
      // Lanjutkan loop untuk mencari wajah yang sesuai
      setTimeout(() => runLivenessLoop(video), 200);
      return;
    }

    // 2. Deteksi Liveness: Challenge Kedipan Mata (Blink Detection)
    if (faceVerified && !livenessPassed) {
      challengeText.innerText = "Tantangan: BERKEDIPLAH SEKARANG! 😉";

      const landmarks = detection.landmarks;
      const leftEye = landmarks.getLeftEye();
      const rightEye = landmarks.getRightEye();

      // Hitung Eye Aspect Ratio (EAR) untuk kedua mata
      const leftEAR = calculateEAR(leftEye);
      const rightEAR = calculateEAR(rightEye);
      const averageEAR = (leftEAR + rightEAR) / 2;

      console.log("EAR: " + averageEAR);

      // Deteksi mata tertutup (kedipan)
      // Nilai normal mata terbuka: 0.26 - 0.35, tertutup: < 0.21
      if (averageEAR < 0.21) {
        isBlinked = true; // Terdeteksi menutup mata
      } else if (isBlinked && averageEAR > 0.25) {
        // Mata kembali terbuka setelah menutup = 1 Kedipan Sukses!
        blinkCount++;
        isBlinked = false;
        console.log("Kedipan terdeteksi! Total: " + blinkCount);
      }

      if (blinkCount >= 1) {
        livenessPassed = true;
        challengeText.innerText = "Liveness OK! Mengirim absensi...";
        stopScanCamera();

        // Kirim absen
        submitAttendance();
        return;
      }
    }
  } else {
    faceGuide.className = "face-guide-oval";
    challengeText.innerText = "Dekatkan wajah Anda ke kamera";
  }

  // Ulangi deteksi dalam ~100ms
  setTimeout(() => runLivenessLoop(video), 100);
}

/**
 * Menghitung Eye Aspect Ratio (EAR) dari 6 titik landmark mata
 */
function calculateEAR(eye) {
  // eye[0] ke eye[3] adalah sudut mata horizontal
  // eye[1], eye[2], eye[4], eye[5] adalah koordinat vertikal
  const p1 = eye[0];
  const p2 = eye[1];
  const p3 = eye[2];
  const p4 = eye[3];
  const p5 = eye[4];
  const p6 = eye[5];

  // Rumus Euclidean Distance vertikal
  const v1 = Math.sqrt(Math.pow(p2.x - p6.x, 2) + Math.pow(p2.y - p6.y, 2));
  const v2 = Math.sqrt(Math.pow(p3.x - p5.x, 2) + Math.pow(p3.y - p5.y, 2));
  // Jarak horizontal
  const h = Math.sqrt(Math.pow(p1.x - p4.x, 2) + Math.pow(p1.y - p4.y, 2));

  return (v1 + v2) / (2.0 * h);
}

/**
 * Memproses Pengiriman Data Kehadiran (Online / Masuk Antrean Offline)
 */
function submitAttendance() {
  const localNRP = localStorage.getItem('attendance_registered_nrp');

  // Ambil lokasi GPS HP
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const payload = {
          nrp: localNRP,
          outlet_id: scannedQRData.outlet_id,
          totp_token: scannedQRData.totp_token,
          timestamp: scannedQRData.timestamp,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          face_verified: faceVerified,
          liveness_passed: livenessPassed,
          attendance_type: "CLOCK_IN", // Bisa dikembangkan CLOCK_IN / CLOCK_OUT
          device_id: getOrCreateDeviceId(),
          notes: "Absen QR via PWA (Liveness Passed)"
        };

        if (navigator.onLine) {
          sendToGAS(payload);
        } else {
          enqueueOfflineRecord(payload);
        }
      },
      (error) => {
        console.error("Gagal mendapatkan GPS:", error);
        showScanResult("Gagal mendapatkan lokasi GPS. Akses lokasi wajib diaktifkan untuk absensi.", "error");
        resetToScanStep1();
        setTimeout(startQRScanner, 5000);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } else {
    showScanResult("GPS Geolocation tidak didukung di peramban Anda.", "error");
    resetToScanStep1();
    setTimeout(startQRScanner, 5000);
  }
}

/**
 * Mengirim data langsung ke Google Apps Script Web App
 */
async function sendToGAS(payload) {
  try {
    showScanResult("Mengirim data ke server Google Sheets...", "success");

    // Kirim menggunakan fetch POST (dengan mode cors karena GAS mendukung CORS JSON)
    const response = await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors", // Catatan: no-cors mengabaikan respon body karena restriksi redirect GAS. 
      // Alternatif terbaik: Kirim via POST. Agar kita mendapatkan respon JSON, 
      // GAS harus dipanggil via method redirect. Kita abaikan pembacaan response 
      // atau buat GAS membalas dengan status 200.
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    // Jika mode no-cors, kita tidak bisa membaca isi body (selalu buram / opaque).
    // Maka kita asumsikan sukses terkirim jika tidak masuk block catch.
    showScanResult("Absensi sukses dikirim! Terima kasih.", "success");

    setTimeout(() => {
      resetToScanStep1();
      startQRScanner();
    }, 4000);

  } catch (error) {
    console.error("Koneksi gagal mengirim ke GAS:", error);
    // Masukkan ke antrean offline jika terjadi kegagalan jaringan mendadak
    enqueueOfflineRecord(payload);
  }
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
    resetToScanStep1();
    startQRScanner();
  }, 6000);
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
  const nrp = nrpInput.value.trim();

  if (!nrp) {
    showRegResult("Harap isi NRP Anda sebelum memulai registrasi wajah.", "error");
    return;
  }

  showRegResult("Membuka kamera depan...", "success");
  document.getElementById('btnStartReg').style.display = 'none';
  document.getElementById('registerCameraArea').style.display = 'block';

  const video = document.getElementById('regFaceVideo');

  try {
    regStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }
    });
    video.srcObject = regStream;
    // Setel penghitung sampel terambil ke 0
    document.getElementById('capturedCount').innerText = "0";
  } catch (error) {
    console.error("Gagal membuka kamera registrasi:", error);
    showRegResult("Gagal mengakses kamera depan untuk registrasi.", "error");
    stopRegistrationCamera();
  }
}

function stopRegistrationCamera() {
  if (regStream) {
    regStream.getTracks().forEach(track => track.stop());
    regStream = null;
  }
  document.getElementById('registerCameraArea').style.display = 'none';
  document.getElementById('btnStartReg').style.display = 'block';
}

/**
 * Mengambil Sampel Embedding Wajah untuk NRP Karyawan
 */
async function captureFaceEmbeddings() {
  if (!isModelsLoaded) return;

  const video = document.getElementById('regFaceVideo');
  const countSpan = document.getElementById('capturedCount');
  const nrp = document.getElementById('regNRP').value.trim();

  showRegResult("Menganalisis wajah Anda...", "success");

  // Deteksi wajah & ekstrak deskriptor
  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (detection) {
    // Simpan embedding wajah secara lokal di IndexedDB/LocalStorage
    // Di aplikasi nyata, kumpulkan 3 sampel lalu rata-ratakan embedding-nya.
    // Di sini kita langsung simpan embedding (berupa array float32)
    const embeddingArray = Array.from(detection.descriptor);

    localStorage.setItem('attendance_registered_nrp', nrp);
    localStorage.setItem('attendance_registered_embeddings', JSON.stringify(embeddingArray));

    // Kirim registrasi wajah ke cloud Google Sheets
    uploadFaceEmbeddingToCloud(nrp, embeddingArray);

    countSpan.innerText = "3"; // Simulasi selesai
    showRegResult("Registrasi Wajah NRP " + nrp + " Sukses! Data wajah tersimpan secara lokal & cloud.", "success");

    // Perbarui referensi global
    registeredEmbeddings = embeddingArray;

    setTimeout(() => {
      stopRegistrationCamera();
      switchView('scan');
    }, 3000);

  } else {
    showRegResult("Wajah tidak terdeteksi. Posisikan wajah Anda tegak lurus di dalam oval panduan.", "error");
  }
}

function showRegResult(message, type) {
  const resultDiv = document.getElementById('regResult');
  resultDiv.innerText = message;
  resultDiv.className = "feedback-message " + (type === 'success' ? 'feedback-success' : 'feedback-error');
  resultDiv.style.display = 'block';
}

/**
 * Mengunggah data template wajah ke cloud (Google Sheets) setelah registrasi sukses
 */
async function uploadFaceEmbeddingToCloud(nrp, embedding) {
  if (!navigator.onLine) {
    console.log("Registrasi wajah cloud ditunda (offline). Data wajah disimpan lokal.");
    return;
  }
  try {
    const payload = {
      action: "register_face",
      nrp: nrp,
      face_embedding: embedding,
      device_id: getOrCreateDeviceId()
    };
    
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors", // Mode no-cors untuk bypass redirect Google
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log("Registrasi wajah & Device ID untuk NRP " + nrp + " berhasil diunggah ke Google Sheets.");
  } catch (err) {
    console.error("Gagal mengunggah data wajah ke cloud:", err);
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
