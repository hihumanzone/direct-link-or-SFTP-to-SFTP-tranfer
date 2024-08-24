const express = require('express');
const http = require('http');
const Client = require('ssh2-sftp-client');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const contentDisposition = require('content-disposition');

const app = express();
const server = http.createServer(app);

const clients = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/events', (req, res) => {
    const clientId = req.query.clientId;
    if (!clientId) {
        res.status(400).send('Client ID required');
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientRes = res;
    clients.set(clientId, clientRes);

    req.on('close', () => {
        clients.delete(clientId);
    });
});

const sendProgress = (clientId, message) => {
    const clientRes = clients.get(clientId);
    if (clientRes) {
        clientRes.write(`data: ${JSON.stringify({ message })}\n\n`);
    }
};

const getFilenameFromContentDisposition = (headers) => {
    const disposition = headers['content-disposition'];
    if (disposition) {
        const parsed = contentDisposition.parse(disposition);
        return parsed.parameters.filename;
    }
    return null;
};

const ensureDownloadsFolderExists = () => {
    const downloadsFolder = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsFolder)) {
        fs.mkdirSync(downloadsFolder);
    }
};

app.post('/transfer', async (req, res) => {
    ensureDownloadsFolderExists();

    const { sftpHost, sftpPort, sftpUsername, sftpPassword, fileUrl, remotePath } = req.body;
    const clientId = req.query.clientId;
    const sftp = new Client();

    const sftpConfig = {
        host: sftpHost,
        port: sftpPort,
        username: sftpUsername,
        password: sftpPassword
    };

    try {
        sendProgress(clientId, 'Starting file download from URL');

        const response = await axios({
            url: fileUrl,
            method: 'GET',
            responseType: 'stream'
        });

        let fileName = getFilenameFromContentDisposition(response.headers);
        if (!fileName) {
            fileName = path.basename(new URL(fileUrl).pathname);
        }
        const localPath = path.join(__dirname, 'downloads', fileName);
        const writer = fs.createWriteStream(localPath);

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let receivedBytes = 0;

        const downloadProgressInterval = setInterval(() => {
            const percentage = ((receivedBytes / totalBytes) * 100).toFixed(2);
            sendProgress(clientId, `Download progress: ${percentage}%`);
        }, 1000);

        response.data.on('data', (chunk) => {
            receivedBytes += chunk.length;
        });

        response.data.pipe(writer);

        writer.on('finish', async () => {
            clearInterval(downloadProgressInterval);
            sendProgress(clientId, 'File download completed');

            try {
                sendProgress(clientId, 'Starting SFTP upload');
                await sftp.connect(sftpConfig);

                const remoteFilePath = path.join(remotePath, fileName);
                const localStream = fs.createReadStream(localPath);

                let uploadedBytes = 0;
                const totalFileSize = fs.statSync(localPath).size;

                const uploadProgressInterval = setInterval(() => {
                    const percentage = ((uploadedBytes / totalFileSize) * 100).toFixed(2);
                    sendProgress(clientId, `Upload progress: ${percentage}%`);
                }, 1000);

                localStream.on('data', (chunk) => {
                    uploadedBytes += chunk.length;
                });

                localStream.on('end', async () => {
                    clearInterval(uploadProgressInterval);
                    sendProgress(clientId, 'File fully uploaded');

                    fs.unlinkSync(localPath);
                    res.json({ message: 'File uploaded successfully!' });
                });

                await sftp.put(localStream, remoteFilePath);
                await sftp.end();
            } catch (sftpErr) {
                res.status(500).json({ message: `SFTP upload failed - ${sftpErr.message}`, error: sftpErr.message });
                console.error(`SFTP error: ${sftpErr.message}`);
            }
        });

        writer.on('error', (err) => {
            clearInterval(downloadProgressInterval);
            res.status(500).json({ message: `File download failed - ${err.message}`, error: err.message });
            console.error(`Download error: ${err.message}`);
        });
    } catch (err) {
        res.status(500).json({ message: `File download failed - ${err.message}`, error: err.message });
        console.error(`Download error: ${err.message}`);
    }
});

app.post('/transfer-sftp-to-sftp', async (req, res) => {
    ensureDownloadsFolderExists();

    const {
        sourceSftpHost,
        sourceSftpPort,
        sourceSftpUsername,
        sourceSftpPassword,
        sourceFilePath,
        destinationSftpHost,
        destinationSftpPort,
        destinationSftpUsername,
        destinationSftpPassword,
        destinationPath,
    } = req.body;
    const clientId = req.query.clientId;

    const sourceSftpConfig = {
        host: sourceSftpHost,
        port: sourceSftpPort,
        username: sourceSftpUsername,
        password: sourceSftpPassword,
    };

    const destinationSftpConfig = {
        host: destinationSftpHost,
        port: destinationSftpPort,
        username: destinationSftpUsername,
        password: destinationSftpPassword,
    };

    const sourceSftp = new Client();
    const destinationSftp = new Client();

    try {
        sendProgress(clientId, 'Connecting to source SFTP server...');
        await sourceSftp.connect(sourceSftpConfig);

        sendProgress(clientId, 'Connecting to destination SFTP server...');
        await destinationSftp.connect(destinationSftpConfig);

        sendProgress(clientId, 'Starting file transfer from source to destination SFTP server...');

        const tempDir = path.join(__dirname, 'downloads');
        const tempFilePath = path.join(tempDir, path.basename(sourceFilePath));

        const sourceStats = await sourceSftp.stat(sourceFilePath);
        const downloadTotalBytes = sourceStats.size;
        let downloadReceivedBytes = 0;

        const downloadInterval = setInterval(() => {
            const downloadPercentage = ((downloadReceivedBytes / downloadTotalBytes) * 100).toFixed(2);
            sendProgress(clientId, `Download progress: ${downloadPercentage}%`);
        }, 1000);

        await sourceSftp.fastGet(sourceFilePath, tempFilePath, {
            step: (total_transferred, chunk, total) => {
                downloadReceivedBytes = total_transferred;
            }
        });

        clearInterval(downloadInterval);
        sendProgress(clientId, 'File downloaded, starting upload process...');

        const totalFileSize = fs.statSync(tempFilePath).size;
        const localStream = fs.createReadStream(tempFilePath);
        const remoteFilePath = path.join(destinationPath, path.basename(sourceFilePath));

        let uploadedBytes = 0;
        const uploadProgressInterval = setInterval(() => {
            const percentage = ((uploadedBytes / totalFileSize) * 100).toFixed(2);
            sendProgress(clientId, `Upload progress: ${percentage}%`);
        }, 1000);

        localStream.on('data', (chunk) => {
            uploadedBytes += chunk.length;
        });

        localStream.on('end', async () => {
            clearInterval(uploadProgressInterval);
            sendProgress(clientId, 'File fully uploaded');

            await sourceSftp.end();
            await destinationSftp.end();
            fs.unlinkSync(tempFilePath);
            res.json({ message: 'SFTP-to-SFTP transfer completed successfully!' });
        });

        await destinationSftp.put(localStream, remoteFilePath);

    } catch (err) {
        if (sourceSftp.sftp) await sourceSftp.end();
        if (destinationSftp.sftp) await destinationSftp.end();
        res.status(500).json({ message: `SFTP transfer failed - ${err.message}`, error: err.message });
        console.error(`SFTP error: ${err.message}`);
    }
});

const PORT = 4299;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});