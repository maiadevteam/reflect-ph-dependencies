const express = require('express');
const http = require('http');
const cors = require('cors');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
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

async function main() {
  console.log('Starting main...');
  
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


app.post('/print', async (req, res) => {
  try {
    const { imageStr } = req.body;

    // Decode base64 image data and save it to a file with a unique filename
    const base64Data = imageStr.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const uniqueFileName = `${uuidv4()}.png`;
    const tempImagePath = path.join(process.cwd(), 'temp', uniqueFileName);
    await fs.mkdir(path.dirname(tempImagePath), { recursive: true });
    await fs.writeFile(tempImagePath, imageBuffer);

    // Convert image to 300 DPI using sharp
    const outputImagePath = path.join(process.cwd(), 'temp', `${uuidv4()}-300dpi.png`);
    await sharp(tempImagePath)
      .resize({ width: 1200, height: 1800, fit: 'contain' })
      .toFile(outputImagePath);

    // Read the converted image
    const updatedImageBuffer = await fs.readFile(outputImagePath);

    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([1200, 1800]);
    const { width, height } = page.getSize();

    // Embed the uploaded image into the PDF
    const embeddedImage = await pdfDoc.embedPng(updatedImageBuffer);
    const imageWidth = width;
    const imageHeight = (imageWidth / embeddedImage.width) * embeddedImage.height;
    const x = (width - imageWidth) / 2;
    const y = (height - imageHeight) / 2;
    page.drawImage(embeddedImage, {
      x,
      y,
      width: imageWidth,
      height: imageHeight,
    });

    // Save the PDF document to a file
    const pdfFilePath = path.join(__dirname, 'temp', `${uuidv4()}.pdf`);
    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(pdfFilePath, pdfBytes);

    // Determine the operating system
    const platform = process.platform;

    let printCommand;
    let printArgs;

    if (platform === 'win32') {
      // Windows
      printCommand = path.join(process.cwd(), 'public', 'SumatraPDF-3.5.2-64.exe');
      printArgs = ['-print-to-default', '-silent', pdfFilePath];
    } else if (platform === 'darwin' || platform === 'linux') {
      // macOS and Linux
      printCommand = 'lp';
      printArgs = ['-s', pdfFilePath];
    } else {
      throw new Error('Unsupported operating system');
    }

    // Use spawn to execute the print command
    const printProcess = spawn(printCommand, printArgs);

    printProcess.on('close', async (code) => {
      if (code !== 0) {
        console.error(`Print process exited with code ${code}`);
        return res.status(500).json({ error: 'Failed to print' });
      }
      console.log('Printed successfully');
      // Clean up temporary files
      await fs.unlink(tempImagePath);
      await fs.unlink(outputImagePath);
      await fs.unlink(pdfFilePath);
      res.json({ message: 'Printed successfully' });
    });

    // Return a response for the initial request
    res.json({ message: 'Printing request received' });
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
