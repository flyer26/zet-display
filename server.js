const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const Papa = require('papaparse');
const AdmZip = require('adm-zip');
const path = require('path'); // Dodano za putanje
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());

// --- SERVIRAJ FRONTEND (HTML) ---
// Sve što je u mapi 'public' je dostupno javno
app.use(express.static(path.join(__dirname, 'public')));

// KONFIGURACIJA
const ZET_RT_URL = 'https://zet.hr/gtfs-rt-protobuf'; 
const ZET_GTFS_ZIP = 'https://www.zet.hr/gtfs-scheduled/latest';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; 

// CACHE & STATE
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 8000; 

let routesMap = {}, stopsMap = {}, tripsMap = {}, stationNames = [];

// --- GTFS LOGIKA ---
async function downloadAndUnzipGTFS() {
    console.log("📥 [SYSTEM] Preuzimam GTFS...");
    try {
        const response = await fetch(ZET_GTFS_ZIP);
        if (!response.ok) throw new Error(response.statusText);
        const buffer = Buffer.from(await response.arrayBuffer());
        const zip = new AdmZip(buffer);
        // Extractamo u trenutni direktorij
        zip.extractEntryTo("routes.txt", "./", false, true);
        zip.extractEntryTo("stops.txt", "./", false, true);
        zip.extractEntryTo("trips.txt", "./", false, true);
        console.log("📦 [SYSTEM] GTFS raspakiran.");
        return true;
    } catch (e) {
        console.error("❌ [ERROR] GTFS download:", e.message);
        return false;
    }
}

function loadGtfsFilesToMemory() {
    try {
        const readCsv = (file) => {
            if (!fs.existsSync(file)) return [];
            return Papa.parse(fs.readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true }).data;
        };

        const routes = readCsv('routes.txt');
        const stops = readCsv('stops.txt');
        const trips = readCsv('trips.txt');

        routesMap = {}; stopsMap = {}; tripsMap = {}; stationNames = [];

        routes.forEach(r => routesMap[r.route_id] = r.route_short_name);
        stops.forEach(s => {
            stopsMap[s.stop_id] = s.stop_name;
            if (!stationNames.includes(s.stop_name)) stationNames.push(s.stop_name);
        });
        stationNames.sort();
        trips.forEach(t => {
            tripsMap[t.trip_id] = { headsign: t.trip_headsign, route_id: t.route_id };
        });

        console.log(`✅ [SYSTEM] Baza spremna: ${stationNames.length} stanica.`);
    } catch (e) {
        console.error("❌ [ERROR] Učitavanje baze:", e);
    }
}

async function initializeSystem() {
    // Na Renderu diskovi su "ephemeral" (brišu se kod restarta), 
    // pa uvijek skidamo svježe podatke kod bootanja
    await downloadAndUnzipGTFS();
    loadGtfsFilesToMemory();
    
    setInterval(async () => {
        if(await downloadAndUnzipGTFS()) loadGtfsFilesToMemory();
    }, UPDATE_INTERVAL);
}

// --- LIVE PODACI ---
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

async function fetchFromZet() {
    try {
        const response = await fetch(ZET_RT_URL, { agent, headers: { 'User-Agent': 'node-fetch' } });
        if (!response.ok) throw new Error(response.status);
        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
        
        const enrichedData = feed.entity.map(e => {
            if (!e.tripUpdate) return null;
            const update = e.tripUpdate;
            const staticTrip = tripsMap[update.trip.tripId];
            if (!staticTrip) return null;

            const stopUpdates = update.stopTimeUpdate.map(stu => {
                const departure = stu.departure || stu.arrival;
                if (!departure || !departure.time) return null;
                return {
                    stopName: stopsMap[stu.stopId] || "Nepoznato",
                    time: departure.time.low ? departure.time.low : departure.time 
                };
            }).filter(Boolean);

            return {
                linija: routesMap[staticTrip.route_id],
                smjer: staticTrip.headsign,
                stanice: stopUpdates
            };
        }).filter(Boolean);

        return enrichedData;
    } catch (error) {
        console.error("❌ [API ERROR]:", error.message);
        return null;
    }
}

app.get('/api/stations', (req, res) => res.json(stationNames));

app.get('/api/live', async (req, res) => {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        return res.json(cachedData);
    }
    const newData = await fetchFromZet();
    if (newData) {
        cachedData = newData;
        lastFetchTime = now;
        res.json(newData);
    } else {
        cachedData ? res.json(cachedData) : res.status(500).json({ error: "ZET error" });
    }
});

// BITNO: Port mora biti dinamičan za Cloud (process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSystem();
    console.log(`🚀 SERVER ONLINE na portu ${PORT}`);
});