const express = require('express');
const http = require('http');
const cors = require('cors');
const { PDFDocument, degrees } = require('pdf-lib');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

// Ensure temp directory exists
const ensureTempDir = async () => {
  const tempDir = path.join(process.cwd(), 'temp');
  try {
    await fsPromises.access(tempDir);
  } catch (err) {
    // Directory doesn't exist, create it
    await fsPromises.mkdir(tempDir, { recursive: true });
    console.log('Created temp directory');
  }
};

const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const {cameraBrowser, CameraProperty, Option, ImageQuality, Camera, watchCameras} = require('napi-canon-cameras')
const socketIo = require('socket.io');
const usb = require('usb');
const findProcess = require('find-process');
const { SerialPort } = require('serialport');


const app = express();
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('New client connected');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});



let camera = null
let liveViewInterval = null;

async function resetCameraPort() {
  try {
    console.log('Looking for Canon-related processes...');

    // Cari process yang related dengan Canon/EDSDK
    const processes = await findProcess('name', /(canon|edsdk|eos)/i);
    
    if (processes.length > 0) {
      console.log('Found processes:', processes);
      
      for (const proc of processes) {
        try {
          process.kill(proc.pid);
          console.log(`Killed process ${proc.name} (PID: ${proc.pid})`);
        } catch (e) {
          console.log(`Failed to kill process ${proc.name}:`, e);
        }
      }
    } else {
      console.log('No Canon-related processes found');
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  } catch (error) {
    console.error('Error killing processes:', error);
    return false;
  }
}

async function releaseCamera() {
  try {
    if (camera) {
      // Stop live view interval if exists
      if (liveViewInterval) {
        clearInterval(liveViewInterval);
        liveViewInterval = null;
      }

      
      // Stop live view if running
      try {
        if (camera.getProperty(CameraProperty.ID.Evf_Mode).available) {
          camera.stopLiveView();
        }
      } catch (e) {
        console.log('Live view may already be stopped');
      }

      // Disconnect camera
      try {
        resetCameraPort()
      } catch (e) {
        console.log('Camera may already be disconnected');
      }

      camera = null;
    }
    
    // Wait for resources to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return true;
  } catch (error) {
    console.error('Error releasing camera port:', error);
    throw error;
  }
}

async function handleCapturedImage(file) {
  try {
    const downloadPath = process.cwd() + '/images';
    file.downloadToPath(downloadPath);
    
    const filePath = downloadPath + '/' + file.name;
    console.log(`Downloaded ${file.name} to ${filePath}`);

    const data = await fs.promises.readFile(filePath);
    const base64Image = data.toString('base64');
    io.emit('capture', `data:image/jpeg;base64,${base64Image}`);
    console.log('Base64 image emitted.');
  } catch (error) {
    console.error('Error handling captured image:', error);
    throw error;
  }
}

function setupLiveView() {
  if (!camera.getProperty(CameraProperty.ID.Evf_Mode).available) {
    console.log('Live view mode is not available for this camera.');
    return false;
  }

  try {
    camera.startLiveView();
    
    liveViewInterval = setInterval(() => {
      try {
        const image = camera.getLiveViewImage();
        if (image) {
          const base64Image = image.getDataURL();
          io.emit('liveview', base64Image);
        }
      } catch (err) {
        console.error('Failed to get live view image:', err);
      }
    }, 50);

    return true;
  } catch (error) {
    console.error('Error setting up live view:', error);
    return false;
  }
}

async function runCameraService() {
  try {
    camera = cameraBrowser.getCamera();
    if (!camera) {
      console.log('No camera found.');
      return false;
    }
    console.log('Camera found, initializing...');
    // Setup event handler
    camera.setEventHandler((eventName, event) => {
      if (
        eventName === Camera.EventName.FileCreate ||
        eventName === Camera.EventName.DownloadRequest
      ) {
        handleCapturedImage(event.file).catch(error => {
          console.error('Error in capture handler:', error);
        });
      }
    });

    // Connect and configure camera
    await camera.connect();
    
    camera.setProperties({
      [CameraProperty.ID.SaveTo]: Option.SaveTo.Host,
      [CameraProperty.ID.ImageQuality]: ImageQuality.ID.LargeJPEGFine,
      [CameraProperty.ID.WhiteBalance]: Option.WhiteBalance.Fluorescent
    });

    // Setup live view
    setupLiveView();

    // Watch for camera changes
    watchCameras();

    return true;
  } catch (error) {
    console.error('Error in runCameraService:');
    console.log(error.EDS_ERROR.toJSON())
    return false;
  }
}

// ensureTempDir is already defined at the top of the file

async function main() {
  console.log('Starting main...');
  
  // Ensure temp directory exists
  await ensureTempDir();
  
  try {
    const success = await runCameraService();
    
    if (!success) {
      console.log('Failed to initialize camera service, attempting recovery...');
      
      try {
        await releaseCamera();
        console.log('Port released, attempting to restart camera service...');
        
        // Wait before trying again
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const retrySuccess = await runCameraService();
        if (!retrySuccess) {
          console.log('Failed to recover camera service');
        }
      } catch (retryError) {
        console.error('Failed to recover from error:', retryError);
      }
    }
  } catch (error) {
    console.error('Error in main:', error);
  }
}


app.post('/api/print', async (req, res) => {
  try {
    const { imageStr } = req.body;

    // Decode base64 image data
    const base64Data = imageStr.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Create temp directory if it doesn't exist
    const tempDir = path.join(process.cwd(), 'temp');
    await fsPromises.mkdir(tempDir, { recursive: true });
    
    // Create unique filenames for original and processed images
    const uniqueId = uuidv4();
    const originalImagePath = path.join(tempDir, `${uniqueId}_original.png`);
    const processedImagePath = path.join(tempDir, `${uniqueId}_processed.png`);
    
    // Save original image temporarily
    await fsPromises.writeFile(originalImagePath, imageBuffer);
    
    // Process the image with very high resolution approach
    // First, determine the original image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    
    // Calculate high-res dimensions (4x the print size for supersampling)
    const highResWidth = 432 * 4;  // 1728 pixels
    const highResHeight = 288 * 4; // 1152 pixels
    
    // Create a high-resolution version with high DPI
    await sharp(imageBuffer)
      .rotate(90) // Rotate 90 degrees clockwise
      // Resize to high resolution dimensions first
      .resize(highResWidth, highResHeight, {
        fit: 'fill',
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      // Apply image enhancement
      .sharpen({
        sigma: 2,
        m1: 0.5,
        m2: 0.5,
        x1: 2,
        y2: 10,
        y3: 20
      })
      // Set high DPI (300 DPI is print quality)
      .png({
        quality: 100,
        compressionLevel: 0,
        density: 300
      })
      .toFile(processedImagePath);
    
    // Create a high-resolution PDF for printing
    const pdfDoc = await PDFDocument.create();
    
    // Create a PDF page with the same physical dimensions but higher DPI
    // Convert to points (72 points = 1 inch, so 300 DPI = 4.17x scaling)
    const pdfWidth = 432; 
    const pdfHeight = 288;
    
    const page = pdfDoc.addPage([pdfWidth, pdfHeight]);
    // Configure PDF for high resolution printing
    page.setMediaBox(0, 0, pdfWidth, pdfHeight);
    const processedImageData = await fsPromises.readFile(processedImagePath);
    const embeddedImage = await pdfDoc.embedPng(processedImageData);
    
    // Draw the image on the PDF page (full size)
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: 432,
      height: 288,
    });
    
    // Save the PDF
    const pdfPath = path.join(tempDir, `${uniqueId}.pdf`);
    const pdfBytes = await pdfDoc.save();
    await fsPromises.writeFile(pdfPath, pdfBytes);
    
    console.log('PDF created successfully at:', pdfPath);

    // Use PDFtoPrinter.exe to print the PDF
    const printCommand = path.join(process.cwd(), 'public', 'PDFtoPrinter.exe');
    // Syntax for PDFtoPrinter.exe is: PDFtoPrinter.exe filename [printername]
    // If printername is omitted or set to empty string, it uses default printer
    const printArgs = [pdfPath]; // Just specify the PDF, will print to default printer
    const printProcess = spawn(printCommand, printArgs);

    printProcess.on('close', async (code) => {
      if (code !== 0) {
        console.error(`Print process exited with code ${code}`);
        return res.status(500).json({ error: 'Failed to print' });
      }
      console.log('Printed successfully');
      
      // Clean up temporary files (commented out as requested)
      await fsPromises.unlink(originalImagePath);
      await fsPromises.unlink(processedImagePath);
      await fsPromises.unlink(pdfPath);
      
      res.json({ message: 'Printed successfully' });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to print' });
  }
});

app.get('/is-dslr-active', (req, res) => {
  const cameras = cameraBrowser.getCameras();
  const isAnyCameraExist = cameras.length > 0;
  return res.json({ isActive: isAnyCameraExist });
});

app.post('/capture', (req, res) => {
  if(camera){
     camera.takePicture()
     return res.json({"message": "wait for taking picture..."})
  }
  return res.status(500).json({"message": "there is no camera here..."});
});
const port = 9000;
server.listen(port, '0.0.0.0', () => {
  main()
  console.log(`Server berjalan di http://localhost:${port}`);
});
