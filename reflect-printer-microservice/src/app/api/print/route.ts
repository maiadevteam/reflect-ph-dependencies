import { PDFDocument } from 'pdf-lib';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

export async function POST(request: Request) {
  try {
    // Receive image data as base64 string in request body
    const { imageStr } = await request.json();

    // Decode base64 image data and save it to a file with a unique filename
    const base64Data = imageStr.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const uniqueFileName = `${uuidv4()}.png`;
    const tempImagePath = path.join(process.cwd(), 'temp', uniqueFileName);
    await fs.promises.mkdir(path.dirname(tempImagePath), { recursive: true });
    await fs.promises.writeFile(tempImagePath, imageBuffer);

    // Convert image to 300 DPI using sharp
    const outputImagePath = path.join(process.cwd(), 'temp', `${uuidv4()}-300dpi.png`);
    await sharp(tempImagePath)
      .resize({ width: 1200, height: 1800, fit: 'contain' })
      .toFile(outputImagePath);

    // Read the converted image
    const updatedImageBuffer = await fs.promises.readFile(outputImagePath);

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
    const pdfFilePath = path.join(process.cwd(), 'temp', `${uuidv4()}.pdf`);
    const pdfBytes = await pdfDoc.save();
    await fs.promises.writeFile(pdfFilePath, pdfBytes);

    // Determine the operating system
    const platform = process.platform;

    let printCommand: string;
    let printArgs: string[];

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

    printProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Print process exited with code ${code}`);
        return NextResponse.json({ error: 'Failed to print' }, { status: 500 });
      }
      console.log('Printed successfully');
      // Clean up temporary files
      fs.unlinkSync(tempImagePath);
      fs.unlinkSync(outputImagePath);
      fs.unlinkSync(pdfFilePath);
      return NextResponse.json({ message: 'Printed successfully' });
    });

    // Return a response for the initial request
    return NextResponse.json({ message: 'Printing request received' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to print' }, { status: 500 });
  }
}
