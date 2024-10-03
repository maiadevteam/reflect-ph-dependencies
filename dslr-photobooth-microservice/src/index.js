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

function main() {
  console.log('run main')
  camera = cameraBrowser.getCamera()
  if (camera) {
    console.log('ada camera', camera)
  
   try {
    camera.setEventHandler(
      (eventName, event) => {
        console.log('anjing')
        console.log(eventName)
          if (
              eventName === Camera.EventName.FileCreate ||
              eventName === Camera.EventName.DownloadRequest
          ) {
              const file = event.file;
              console.log(
                  file,
                  file.format
              );
              console.log('kontollllllll')
              console.log(file.localFile)
              
              file.downloadToPath(process.cwd() + '/images');
              const filePath = process.cwd() + '/images/' + file.name
              console.log(`Downloaded ${file.name}.`);
              console.log(filePath)
              fs.readFile(filePath, (err, data) => {
                console.log('ini data', data)
                console.log('halo 2')
                if (err) {
                  console.log(err)
                  console.error('Error reading file:', err);
                  return;
                }

                const base64Image = data.toString('base64');
                io.emit('capture', `data:image/jpeg;base64,${base64Image}`);
                console.log('Base64 image emitted.');

              });
              console.log('KONTOl')
          }
      }
  );
    camera.connect();
    console.log(camera.portName)
    camera.setProperties(
        {
            [CameraProperty.ID.SaveTo]: Option.SaveTo.Host,
            [CameraProperty.ID.ImageQuality]: ImageQuality.ID.LargeJPEGFine,
            [CameraProperty.ID.WhiteBalance]: Option.WhiteBalance.Fluorescent
        }
    );
    let liveMode = false;
    if (camera.getProperty(CameraProperty.ID.Evf_Mode).available) {
      camera.startLiveView();
      liveMode = true;
      console.log('woy')

      setInterval(() => {
        try {
          // Get the live view image
          const image = camera.getLiveViewImage();
          if (image) {
            // Convert image data to base64 and emit through socket.io
            const base64Image = image.getDataURL();
            io.emit('liveview', base64Image); // Emit live view data
            console.log('Live view image emitted.');
          }
        } catch (err) {
          console.error('Failed to get live view image:', err);
        }
      }, 50); // Emit every 200 milliseconds
    } else {
      console.log('Live view mode is not available for this camera.');
    }

    watchCameras()

   } catch (error) {
     console.log(error)
   }
} else {
    console.log('No camera found.');
}
}
const port = 9000;
server.listen(port, '0.0.0.0', () => {
  main()
  console.log(`Server berjalan di http://localhost:${port}`);
});
