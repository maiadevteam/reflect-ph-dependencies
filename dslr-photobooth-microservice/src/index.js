const express = require('express');
const http = require('http');
const gphoto2 = require('gphoto2');
const cors = require('cors');
const app = express();
const corsOptions = {
  origin: '*', // Mengizinkan semua origin
  methods: ['GET', 'POST'], // Metode HTTP yang diizinkan
  allowedHeaders: ['Content-Type', 'Authorization'], // Header yang diizinkan
};

app.use(cors(corsOptions)); 
app.use(express.json());

const server = http.createServer(app);

const GPhoto = new gphoto2.GPhoto2();

let camera = null;
let availableCameras = [];

// Inisialisasi kamera
GPhoto.list((cameras) => {
  availableCameras = cameras;
  if (cameras.length === 0) {
    console.log('Tidak ada kamera yang terdeteksi');
    return;
  }
  
  // Cari kamera Canon, Sony, atau Nikon terlebih dahulu
  camera = cameras.find(cam => 
    cam.model.toLowerCase().includes('canon') || 
    cam.model.toLowerCase().includes('sony') || 
    cam.model.toLowerCase().includes('nikon')
  );
  
  // Jika tidak ditemukan, gunakan kamera pertama yang tersedia
  if (!camera) {
    console.log('Tidak ada kamera Canon, Sony, atau Nikon yang terdeteksi. Menggunakan kamera yang tersedia.');
    camera = cameras[0];
  }
  
  console.log('Kamera terdeteksi:', camera.model);
});

app.get('/cameras', (req, res) => {
  res.json(availableCameras.map(cam => ({
    model: cam.model,
    port: cam.port
  })));
});

app.get('/current-camera', (req, res) => {
  if (!camera) {
    return res.status(404).json({ error: 'Tidak ada kamera yang aktif' });
  }
  res.json({ model: camera.model, port: camera.port });
});

app.post('/select-camera', (req, res) => {
  const { port } = req.body;
  const selectedCamera = availableCameras.find(cam => cam.port === port);
  if (selectedCamera) {
    camera = selectedCamera;
    res.json({ success: true, message: 'Kamera berhasil dipilih', model: camera.model });
  } else {
    res.status(404).json({ success: false, message: 'Kamera tidak ditemukan' });
  }
});

app.get('/is-dslr-active', (req, res) => {
  res.json({ active: camera !== null });
});

app.get('/capture', (req, res) => {
  if (!camera) {
    return res.status(500).send('Tidak ada kamera yang terdeteksi');
  }

  camera.takePicture({ download: true }, (err, data) => {
    if (err) {
      console.error('Error saat mengambil gambar:', err);
      return res.status(500).send('Error saat mengambil gambar');
    }
    
    res.contentType('image/jpeg');
    res.send(data);
  });
});
const port = 8080;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
