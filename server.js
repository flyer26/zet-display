const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const readline = require('readline'); // NOVO: Za čitanje red po red
const Papa = require('papaparse');
const AdmZip = require('adm-zip');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// KONFIGURACIJA
const ZET_RT_URL = 'https://zet.hr/gtfs-rt-protobuf'; 
const ZET_GTFS_ZIP = 'https://www.zet.hr/gtfs-scheduled/latest';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; 

// MEMORIJA
let staticSchedule = {}; 
let stationList = [];
let routesMap = {};
let cachedLiveData = null;
let lastLiveFetch = 0;

// --- POMOĆNE FUNKCIJE ---
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function minutesToTime(mins) {
    let h = Math.floor(mins / 60);
    let m = mins % 60;
    if (h >= 24) h -= 24;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// --- GTFS LOGIKA ---

async function downloadAndUnzipGTFS() {
    console.log("📥 [SYSTEM] Preuzimam GTFS...");
    try {
        const response = await fetch(ZET_GTFS_ZIP);
        if (!response.ok) throw new Error(response.statusText);
        const buffer = Buffer.from(await response.arrayBuffer());
        const zip = new AdmZip(buffer);
        zip.extractEntryTo("routes.txt", "./", false, true);
        zip.extractEntryTo("stops.txt", "./", false, true);
        zip.extractEntryTo("trips.txt", "./", false, true);
        zip.extractEntryTo("calendar.txt", "./", false, true);
        zip.extractEntryTo("stop_times.txt", "./", false, true);
        console.log("📦 [SYSTEM] GTFS raspakiran.");
        return true;
    } catch (e) {
        console.error("❌ [ERROR] Download:", e.message);
        return false;
    }
}

function getTodayServiceIds(calendarFile) {
    const content = fs.readFileSync(calendarFile, 'utf8');
    const rows = Papa.parse(content, { header: true, skipEmptyLines: true }).data;
    
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = days[now.getDay()];

    const activeServices = new Set();
    rows.forEach(row => {
        if (row[todayName] === '1' && todayStr >= row.start_date && todayStr <= row.end_date) {
            activeServices.add(row.service_id);
        }
    });
    return activeServices;
}

// OVO JE KLJUČNA PROMJENA - STREAMING
async function loadGtfsFilesToMemory() {
    console.log("🔄 [SYSTEM] Gradim bazu (STREAMING MOD)...");
    
    // 1. Učitaj male fajlove normalno
    const readCsv = (f) => Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    const routes = readCsv('routes.txt');
    const stops = readCsv('stops.txt');
    const trips = readCsv('trips.txt');
    
    routesMap = {};
    let stopsIdToName = {};
    staticSchedule = {};
    stationList = [];

    routes.forEach(r => routesMap[r.route_id] = r.route_short_name);
    stops.forEach(s => {
        stopsIdToName[s.stop_id] = s.stop_name;
        if (!staticSchedule[s.stop_name]) {
            staticSchedule[s.stop_name] = [];
            stationList.push(s.stop_name);
        }
    });
    stationList.sort();

    // 2. Filtriraj Tripove za DANAS
    const activeServices = getTodayServiceIds('calendar.txt');
    const activeTripsMap = new Map(); // Koristimo Map za brži pristup
    
    trips.forEach(t => {
        if (activeServices.has(t.service_id)) {
            activeTripsMap.set(t.trip_id, { 
                headsign: t.trip_headsign, 
                route_id: t.route_id 
            });
        }
    });

    console.log(`📅 [INFO] Danas aktivno: ${activeTripsMap.size} vožnji.`);

    // 3. Čitaj STOP_TIMES red po red (Štedi RAM)
    const fileStream = fs.createReadStream('stop_times.txt');
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let counter = 0;
    // Pretpostavljamo strukturu CSV-a: trip_id,arrival_time,departure_time,stop_id...
    // ZET obično ima zaglavlje, pa preskačemo prvi red
    let isFirstLine = true;
    
    // Mapiranje indeksa stupaca (za svaki slučaj da ZET promijeni redoslijed)
    let idxTrip = 0;
    let idxTime = 2; // departure_time
    let idxStop = 3;

    for await (const line of rl) {
        if (isFirstLine) {
            // Detektiraj stupce iz headera
            const headers = line.split(',').map(h => h.trim().replace(/"/g, '')); // Makni navodnike
            idxTrip = headers.indexOf('trip_id');
            idxTime = headers.indexOf('departure_time');
            idxStop = headers.indexOf('stop_id');
            isFirstLine = false;
            continue;
        }

        // Ručno parsiranje linije (brže od CSV parsera)
        const cols = line.split(',');
        const tripId = cols[idxTrip]; // trip_id

        // Je li ovaj trip aktivan danas?
        if (activeTripsMap.has(tripId)) {
            const stopId = cols[idxStop];
            const stopName = stopsIdToName[stopId];
            
            if (stopName) {
                const tripInfo = activeTripsMap.get(tripId);
                const depTime = cols[idxTime]; // Vrijeme string

                staticSchedule[stopName].push({
                    trip_id: tripId,
                    linija: routesMap[tripInfo.route_id],
                    smjer: tripInfo.headsign,
                    timeMin: timeToMinutes(depTime),
                    status: "SCHED",
                    time: depTime.substring(0, 5) // Samo HH:MM
                });
                counter++;
            }
        }
    }

    // Sortiranje nakon učitavanja
    for (const station in staticSchedule) {
        staticSchedule[station].sort((a, b) => a.timeMin - b.timeMin);
    }

    console.log(`✅ [SYSTEM] Baza spremna! Učitano ${counter} dolazaka.`);
    if (global.gc) global.gc(); // Forsiraj čišćenje RAM-a ako je moguće
}

async function initializeSystem() {
    if (!fs.existsSync('stop_times.txt')) await downloadAndUnzipGTFS();
    await loadGtfsFilesToMemory();
    
    setInterval(async () => {
        if(await downloadAndUnzipGTFS()) await loadGtfsFilesToMemory();
    }, UPDATE_INTERVAL);
}

// --- LIVE & API ---

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

async function getLiveFeed() {
    const now = Date.now();
    if (cachedLiveData && (now - lastLiveFetch < 8000)) return cachedLiveData;

    try {
        const response = await fetch(ZET_RT_URL, { agent, headers: { 'User-Agent': 'node-fetch' } });
        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
        
        const liveMap = {};
        feed.entity.forEach(e => {
            if (e.tripUpdate && e.tripUpdate.stopTimeUpdate.length > 0) {
                const update = e.tripUpdate.stopTimeUpdate[0];
                const delay = update.departure?.delay || update.arrival?.delay || 0;
                liveMap[e.tripUpdate.trip.tripId] = delay;
            }
        });
        cachedLiveData = liveMap;
        lastLiveFetch = now;
        return liveMap;
    } catch (e) {
        console.error("Live fetch error", e.message);
        return {};
    }
}

app.get('/api/stations', (req, res) => res.json(stationList));

app.get('/api/board', async (req, res) => {
    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const liveDelays = await getLiveFeed();
    
    // Trenutno vrijeme (ZG zona)
    const now = new Date();
    const localNow = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const currentMinutes = localNow.getHours() * 60 + localNow.getMinutes();

    const board = [];
    const TIME_WINDOW = 60; 

    for (const trip of schedule) {
        // Filtriraj: samo oni koji dolaze u idućih 60 min
        if (trip.timeMin >= currentMinutes - 5 && trip.timeMin <= currentMinutes + TIME_WINDOW) {
            let finalData = { ...trip }; // Kopija objekta
            
            // Ako imamo live podatak
            if (liveDelays[trip.trip_id] !== undefined) {
                const delayMin = Math.round(liveDelays[trip.trip_id] / 60);
                finalData.timeMin = trip.timeMin + delayMin;
                finalData.min = finalData.timeMin - currentMinutes;
                finalData.status = "LIVE";
                finalData.time = minutesToTime(finalData.timeMin);
            } else {
                finalData.min = trip.timeMin - currentMinutes;
                finalData.status = "SCHED";
            }
            board.push(finalData);
        }
    }
    
    board.sort((a, b) => a.min - b.min);
    res.json(board);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSystem();
    console.log(`🚀 STREAMING SERVER ONLINE: ${PORT}`);
});