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
        
        zip.extractEntryTo("routes.txt", "./", false, true);
        zip.extractEntryTo("stops.txt", "./", false, true);
        zip.extractEntryTo("trips.txt", "./", false, true);
        zip.extractEntryTo("calendar.txt", "./", false, true);
        zip.extractEntryTo("calendar_dates.txt", "./", false, true);
        zip.extractEntryTo("stop_times.txt", "./", false, true);
        
        console.log("📦 [SYSTEM] GTFS raspakiran.");
        return true;
    } catch (e) {
        console.error("❌ [ERROR] Download:", e.message);
        return false;
    }
}

function getActiveServiceIds() {
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

    calendar.forEach(row => {
        if (row[todayName] === '1' && todayStr >= row.start_date && todayStr <= row.end_date) {
            activeServices.add(row.service_id);
        }
    });

    calendarDates.forEach(row => {
        if (row.date === todayStr) {
            if (row.exception_type === '1') {
                activeServices.add(row.service_id);
            } else if (row.exception_type === '2') {
                activeServices.delete(row.service_id);
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
    const stops = readCsv('stops.txt'); // Učitavamo sve stanice
    const trips = readCsv('trips.txt');
    
    routesMap = {};
    let stopsIdToName = {};
    staticSchedule = {};
    stationList = [];

    routes.forEach(r => routesMap[r.route_id] = r.route_short_name);

    // --- PAMETNO GRUPIRANJE STANICA (NOVI DIO) ---
    console.log("📍 [SYSTEM] Analiziram i spajam stanice...");
    
    // 1. Grupiraj sve stanice po imenu
    const stopsByName = {};
    stops.forEach(s => {
        const name = s.stop_name ? s.stop_name.trim() : "NEPOZNATA";
        if (!stopsByName[name]) stopsByName[name] = [];
        stopsByName[name].push(s);
    });

    // 2. Prođi kroz grupe i provjeri udaljenosti
    for (const name in stopsByName) {
        const stopsGroup = stopsByName[name];
        const clusters = [];

        stopsGroup.forEach(s => {
             const lat = parseFloat(s.stop_lat);
             const lon = parseFloat(s.stop_lon);
             
             let added = false;
             for(let cluster of clusters) {
                 const cLat = parseFloat(cluster[0].stop_lat);
                 const cLon = parseFloat(cluster[0].stop_lon);
                 
                 // Ako je unutar cca 2-3km (0.02 stupnja), to je ista lokacija
                 if (Math.abs(lat - cLat) < 0.02 && Math.abs(lon - cLon) < 0.02) { 
                     cluster.push(s);
                     added = true;
                     break;
                 }
             }
             if(!added) clusters.push([s]);
        });

        // 3. Dodijeli imena
        clusters.forEach((cluster, index) => {
            let finalName = name;
            // Ako ima više klastera (npr. ZG i VG), dodaj broj
            if (clusters.length > 1) {
                finalName = `${name} (${index + 1})`;
            }

            cluster.forEach(s => {
                 stopsIdToName[s.stop_id] = finalName;
                 if (!staticSchedule[finalName]) {
                     staticSchedule[finalName] = [];
                     stationList.push(finalName);
                 }
            });
        });
    }
    
    stationList = [...new Set(stationList)]; // Za svaki slučaj makni duplikate iz liste
    stationList.sort();
    // --- KRAJ PAMETNOG GRUPIRANJA ---


    // FILTRIRANJE TRIP-ova
    const activeServices = getActiveServiceIds();
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

    const fileStream = fs.createReadStream('stop_times.txt');
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let counter = 0;
    let isFirst = true;
    let idxTrip=0, idxTime=2, idxStop=3;

    for await (const line of rl) {
        if (isFirst) {
            const headers = line.split(',').map(h => h.trim().replace(/"/g, ''));
            idxTrip = headers.indexOf('trip_id');
            idxTime = headers.indexOf('departure_time');
            idxStop = headers.indexOf('stop_id');
            isFirst = false;
            continue;
        }

        const cols = line.split(','); 
        const tripId = cols[idxTrip].replace(/"/g, '');
        
        if (activeTripsMap.has(tripId)) {
            const stopId = cols[idxStop].replace(/"/g, '');
            const stopName = stopsIdToName[stopId]; // Ovdje sada dobivamo "PAMETNO" ime
            
            if (stopName) {
                const tripInfo = activeTripsMap.get(tripId);
                const depTime = cols[idxTime].replace(/"/g, '');
                const timeMin = timeToMinutes(depTime);

                staticSchedule[stopName].push({
                    trip_id: tripId,
                    linija: routesMap[tripInfo.route_id],
                    smjer: tripInfo.headsign,
                    timeMin: timeMin, 
                    timeStr: depTime.substring(0, 5) 
                });
                counter++;
            }
        }
    }

    for (const station in staticSchedule) {
        staticSchedule[station].sort((a, b) => a.timeMin - b.timeMin);
    }

    console.log(`✅ [SYSTEM] Baza spremna! Učitano ${counter} dolazaka.`);
    if (global.gc) global.gc(); 
}

async function initializeSystem() {
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

// NOVI ENDPOINT ZA ODREDIŠTA (za onaj izbornik na početku)
app.get('/api/destinations', (req, res) => {
    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    const cleanQuery = stationQuery.trim().toLowerCase();
    // I ovdje moramo paziti na naša nova "pametna" imena
    // Budući da korisnik šalje puno ime (npr. ZAGREBAČKA (1)), ovo će raditi
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const allDestinations = [...new Set(schedule.map(trip => trip.smjer))].sort();
    
    res.json(allDestinations);
});

app.get('/api/board', async (req, res) => {
    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const liveDelays = await getLiveFeed();
    
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const board = [];
    
    for (const trip of schedule) {
        if (trip.timeMin >= currentMinutes - 10 && trip.timeMin <= currentMinutes + 90) {
            
            let finalTimeMin = trip.timeMin;
            let status = "SCHED"; 
            
            if (liveDelays[trip.trip_id] !== undefined) {
                const delaySec = liveDelays[trip.trip_id];
                const delayMin = Math.round(delaySec / 60);
                
                finalTimeMin = trip.timeMin + delayMin;
                status = "LIVE"; 
            }

            const minutesUntil = finalTimeMin - currentMinutes;

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
    
    board.sort((a, b) => a.min - b.min);
    res.json(board.slice(0, 15)); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSystem();
    console.log(`🚀 FINAL SERVER ONLINE: ${PORT}`);
});