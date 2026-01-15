const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const readline = require('readline');
const Papa = require('papaparse');
const AdmZip = require('adm-zip');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- KONFIGURACIJA ---
const ZET_RT_URL = 'https://zet.hr/gtfs-rt-protobuf'; 
const ZET_GTFS_ZIP = 'https://www.zet.hr/gtfs-scheduled/latest';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; 

// --- MEMORIJA ---
let staticSchedule = {}; 
let stationList = [];
let routesMap = {};
let cachedLiveData = null;
let lastLiveFetch = 0;

// Pomoćne funkcije za vrijeme
function timeToMinutes(timeStr) {
    if (!timeStr) return 9999;
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
        
        // Izvlačimo i calendar_dates.txt (KLJUČNO ZA ZETKO LOGIKU)
        zip.extractEntryTo("routes.txt", "./", false, true);
        zip.extractEntryTo("stops.txt", "./", false, true);
        zip.extractEntryTo("trips.txt", "./", false, true);
        zip.extractEntryTo("calendar.txt", "./", false, true);
        zip.extractEntryTo("calendar_dates.txt", "./", false, true); // <--- OVO NAM JE FALILO
        zip.extractEntryTo("stop_times.txt", "./", false, true);
        
        console.log("📦 [SYSTEM] GTFS raspakiran.");
        return true;
    } catch (e) {
        console.error("❌ [ERROR] Download:", e.message);
        return false;
    }
}

// --- POPRAVLJENA LOGIKA DATUMA (ZETKO STIL) ---
function getActiveServiceIds() {
    // 1. Odredi današnji datum (ZG zona)
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = days[now.getDay()];

    console.log(`📅 [SYSTEM] Računam vozni red za: ${todayStr} (${todayName})`);

    const readCsv = (f) => Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    
    const calendar = readCsv('calendar.txt');
    const calendarDates = readCsv('calendar_dates.txt');

    const activeServices = new Set();

    // 1. Provjeri redovni raspored (calendar.txt)
    calendar.forEach(row => {
        if (row[todayName] === '1' && todayStr >= row.start_date && todayStr <= row.end_date) {
            activeServices.add(row.service_id);
        }
    });

    // 2. Provjeri iznimke (calendar_dates.txt) - OVO JE BITNO
    // exception_type: 1 = dodaj uslugu, 2 = ukloni uslugu
    calendarDates.forEach(row => {
        if (row.date === todayStr) {
            if (row.exception_type === '1') {
                activeServices.add(row.service_id); // Dodaj extra vožnje
            } else if (row.exception_type === '2') {
                activeServices.delete(row.service_id); // Makni otkazane
            }
        }
    });

    console.log(`✅ [SYSTEM] Pronađeno ${activeServices.size} aktivnih tipova usluge.`);
    return activeServices;
}

async function loadGtfsFilesToMemory() {
    console.log("🔄 [SYSTEM] Gradim bazu...");
    
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

    // FILTRIRANJE TRIP-ova
    const activeServices = getActiveServiceIds();
    if (activeServices.size === 0) {
        console.error("⚠️ [WARNING] Nema aktivnih servisa za danas! Provjeri datum servera.");
    }

    const activeTripsMap = new Map();
    
    trips.forEach(t => {
        if (activeServices.has(t.service_id)) {
            activeTripsMap.set(t.trip_id, { 
                headsign: t.trip_headsign, 
                route_id: t.route_id 
            });
        }
    });

    console.log(`🚌 [INFO] Ukupno aktivnih vožnji danas: ${activeTripsMap.size}`);

    // STREAMING STOP_TIMES
    const fileStream = fs.createReadStream('stop_times.txt');
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let counter = 0;
    let isFirst = true;
    let idxTrip=0, idxTime=2, idxStop=3; // Defaulti

    for await (const line of rl) {
        if (isFirst) {
            // Dinamičko mapiranje stupaca
            const headers = line.split(',').map(h => h.trim().replace(/"/g, ''));
            idxTrip = headers.indexOf('trip_id');
            idxTime = headers.indexOf('departure_time');
            idxStop = headers.indexOf('stop_id');
            isFirst = false;
            continue;
        }

        const cols = line.split(','); // Brzi split
        // Pazi na navodnike ako ih ima
        const tripId = cols[idxTrip].replace(/"/g, '');
        
        if (activeTripsMap.has(tripId)) {
            const stopId = cols[idxStop].replace(/"/g, '');
            const stopName = stopsIdToName[stopId];
            
            if (stopName) {
                const tripInfo = activeTripsMap.get(tripId);
                const depTime = cols[idxTime].replace(/"/g, '');
                
                // ZET ima vremena tipa "24:30:00", to moramo podržati
                const timeMin = timeToMinutes(depTime);

                staticSchedule[stopName].push({
                    trip_id: tripId,
                    linija: routesMap[tripInfo.route_id],
                    smjer: tripInfo.headsign,
                    timeMin: timeMin, 
                    timeStr: depTime.substring(0, 5) // HH:MM
                });
                counter++;
            }
        }
    }

    // Sortiraj svaku stanicu
    for (const station in staticSchedule) {
        staticSchedule[station].sort((a, b) => a.timeMin - b.timeMin);
    }

    console.log(`✅ [SYSTEM] Baza spremna! Učitano ${counter} dolazaka.`);
    if (global.gc) global.gc(); 
}

async function initializeSystem() {
    // Uvijek skini svježe jer Render briše disk
    await downloadAndUnzipGTFS();
    await loadGtfsFilesToMemory();
    
    setInterval(async () => {
        if(await downloadAndUnzipGTFS()) await loadGtfsFilesToMemory();
    }, UPDATE_INTERVAL);
}

// --- LIVE API ---
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
            if (e.tripUpdate) {
                const tripId = e.tripUpdate.trip.tripId;
                // Pokušaj naći delay
                if (e.tripUpdate.stopTimeUpdate && e.tripUpdate.stopTimeUpdate.length > 0) {
                    const stu = e.tripUpdate.stopTimeUpdate[0];
                    const delay = stu.departure?.delay || stu.arrival?.delay || 0;
                    liveMap[tripId] = delay;
                }
            }
        });
        cachedLiveData = liveMap;
        lastLiveFetch = now;
        return liveMap;
    } catch (e) {
        console.error("ZET API Error:", e.message);
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
    
    // ZG vrijeme
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const board = [];
    
    // Gledamo raspored
    for (const trip of schedule) {
        // Logika: Prikazujemo ako je po rasporedu u idućih 60 min
        // ILI ako je prošao prije max 5 min (da ne pobjegne s ekrana odmah)
        
        // Ali moramo paziti na ponoć (npr. sad je 23:50, bus je u 00:10)
        // Ovdje pojednostavljujemo: gledamo samo apsolutne minute
        
        if (trip.timeMin >= currentMinutes - 10 && trip.timeMin <= currentMinutes + 90) {
            
            let finalTimeMin = trip.timeMin;
            let status = "SCHED"; // Po rasporedu (sivo)
            
            // Ako imamo LIVE podatke za taj trip ID
            if (liveDelays[trip.trip_id] !== undefined) {
                const delaySec = liveDelays[trip.trip_id];
                const delayMin = Math.round(delaySec / 60);
                
                finalTimeMin = trip.timeMin + delayMin;
                status = "LIVE"; // Uživo (narančasto)
            }

            const minutesUntil = finalTimeMin - currentMinutes;

            // Filtriraj: ne prikazuj ako je bus već otišao (npr prije 2 min)
            // Ali ako kasni, onda ga prikazuj
            if (minutesUntil >= -2) {
                board.push({
                    linija: trip.linija,
                    smjer: trip.smjer,
                    min: minutesUntil,
                    time: minutesToTime(finalTimeMin),
                    status: status
                });
            }
        }
    }
    
    // Sortiraj po vremenu dolaska
    board.sort((a, b) => a.min - b.min);
    
    // Vrati max 10 rezultata
    res.json(board.slice(0, 15)); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSystem();
    console.log(`🚀 FINAL SERVER ONLINE: ${PORT}`);
});