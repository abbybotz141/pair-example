const express = require('express');
const fs = require('fs');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { upload } = require('./mega');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');

var app = express();
var port = 3000;
var session;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();
app.use(express.static(path.join(__dirname, 'static')));

const userCountFile = './userCount.json';

// Function to read user count from file
function getUserCount() {
    if (!fs.existsSync(userCountFile)) {
        fs.writeFileSync(userCountFile, JSON.stringify({ count: 0 }));
    }
    return JSON.parse(fs.readFileSync(userCountFile)).count;
}

// Function to update user count in file
function updateUserCount() {
    let count = getUserCount() + 1;
    fs.writeFileSync(userCountFile, JSON.stringify({ count }));
}

async function connector(Num, res) {
    var sessionDir = './session';
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }
    var { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        Num = Num.replace(/[^0-9]/g, '');
        var code = await session.requestPairingCode(Num);
        if (!res.headersSent) {
            res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
        }
    }

    session.ev.on('creds.update', async () => {
        await saveCreds();
    });

    session.ev.on('connection.update', async (update) => {
        var { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('Connected successfully');
            updateUserCount(); // Increment user count
            await delay(5000);
            var myr = await session.sendMessage(session.user.id, { text: `${config.MESSAGE}` });
            var pth = './session/creds.json';
            try {
                var url = await upload(pth);
                var sID;
                if (url.includes("https://mega.nz/file/")) {
                    sID = config.PREFIX + url.split("https://mega.nz/file/")[1];
                } else {
                    sID = 'Fekd up';
                }
                await session.sendMessage(session.user.id, { image: { url: `${config.IMAGE}` }, caption: `*Session ID*\n\n${sID}` }, { quoted: myr });
            
            } catch (error) {
                console.error('Error:', error);
            }
        } else if (connection === 'close') {
            var reason = lastDisconnect?.error?.output?.statusCode;
            reconn(reason);
        }
    });
}

function reconn(reason) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, reconnecting...');
        connector();
    } else {
        console.log(`Disconnected! reason: ${reason}`);
        session.end();
    }
}

app.get('/pair', async (req, res) => {
    var Num = req.query.code;
    if (!Num) {
        return res.status(418).json({ message: 'Phone number is required' });
    }

    var release = await mutex.acquire();
    try {
        await connector(Num, res);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "fekd up"});
    } finally {
        release();
    }
});

// New endpoint to get user count
app.get('/users', (req, res) => {
    res.json({ total_users: getUserCount() });
});

app.listen(port, () => {
    console.log(`Running on PORT:${port}`);
});
