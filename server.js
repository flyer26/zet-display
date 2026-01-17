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

// --- MEMORIJA ---
let staticSchedule = {}; 
let stationList = [];
let routesMap = {};
let cachedLiveData = null;
let lastLiveFetch = 0;
// Pamtimo za koji datum smo učitali podatke
let loadedDateStr = ""; 

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

// Funkcija koja računa današnji datum string (npr "20231225")
function getCurrentDateStr() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
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
    
    // --- KLJUČNO ZA NOĆNE LINIJE ---
    // Ako je trenutno između 00:00 i 04:00, ponašaj se kao da je još uvijek JUČER
    // jer ZET tretira te vožnje kao dio prethodnog dana (npr. 25:30h)
    if (now.getHours() < 4) {
        now.setDate(now.getDate() - 1);
        console.log("🌙 [SYSTEM] Noćni režim: Učitavam raspored za 'jučer' jer je prije 4 ujutro.");
    }
    
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const effectiveDateStr = `${yyyy}${mm}${dd}`; // Datum za koji tražimo service_id
    
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = days[now.getDay()]; // Dan u tjednu (npr 'friday' ako je petak navečer/subota ujutro)

    console.log(`📅 [SYSTEM] Računam vozni red za efektivni datum: ${effectiveDateStr} (${todayName})`);

    const readCsv = (f) => Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    
    const calendar = readCsv('calendar.txt');
    const calendarDates = readCsv('calendar_dates.txt');

    const activeServices = new Set();

    calendar.forEach(row => {
        if (row[todayName] === '1' && effectiveDateStr >= row.start_date && effectiveDateStr <= row.end_date) {
            activeServices.add(row.service_id);
        }
    });

    calendarDates.forEach(row => {
        if (row.date === effectiveDateStr) {
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
    
    // Zabilježi stvarni datum kada smo ovo učitali (da znamo kad treba refresh)
    loadedDateStr = getCurrentDateStr();

    const readCsv = (f) => Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    const routes = readCsv('routes.txt');
    const stops = readCsv('stops.txt'); 
    const trips = readCsv('trips.txt');
    
    routesMap = {};
    let stopsIdToName = {};
    staticSchedule = {};
    stationList = [];

    routes.forEach(r => routesMap[r.route_id] = r.route_short_name);

    // --- PAMETNO GRUPIRANJE STANICA ---
    console.log("📍 [SYSTEM] Analiziram i spajam stanice...");
    
    const stopsByName = {};
    stops.forEach(s => {
        const name = s.stop_name ? s.stop_name.trim() : "NEPOZNATA";
        if (!stopsByName[name]) stopsByName[name] = [];
        stopsByName[name].push(s);
    });

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
                 
                 if (Math.abs(lat - cLat) < 0.02 && Math.abs(lon - cLon) < 0.02) { 
                     cluster.push(s);
                     added = true;
                     break;
                 }
             }
             if(!added) clusters.push([s]);
        });

        clusters.forEach((cluster, index) => {
            let finalName = name;
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
    
    stationList = [...new Set(stationList)]; 
    stationList.sort();

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

    console.log(`🚌 [INFO] Ukupno aktivnih vožnji: ${activeTripsMap.size}`);

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
            const stopName = stopsIdToName[stopId]; 
            
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

// --- AUTOMATSKO OSVJEŽAVANJE ---
function scheduleNextUpdate() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    let nextUpdate = new Date(now);
    
    // Postavi vrijeme na 04:00:00 ujutro
    nextUpdate.setHours(4, 0, 0, 0);

    // Ako je 4 ujutro već prošlo, prebaci na sutra
    if (now > nextUpdate) {
        nextUpdate.setDate(nextUpdate.getDate() + 1);
    }

    const delay = nextUpdate - now;
    console.log(`⏰ [SYSTEM] Iduće osvježavanje zakazano za: ${nextUpdate.toLocaleString()} (za ${Math.round(delay/1000/60)} min)`);

    setTimeout(async () => {
        console.log("♻️ [SYSTEM] Pokrećem dnevno osvježavanje podataka...");
        if(await downloadAndUnzipGTFS()) {
            await loadGtfsFilesToMemory();
        }
        scheduleNextUpdate();
    }, delay);
}

async function initializeSystem() {
    await downloadAndUnzipGTFS();
    await loadGtfsFilesToMemory();
    scheduleNextUpdate(); 
}

// --- LIVE API ---
const agent = new https.Agent({ 
    rejectUnauthorized: false, 
    keepAlive: true,
    timeout: 30000 
});

async function getLiveFeed() {
    const now = Date.now();
    if (cachedLiveData && (now - lastLiveFetch < 8000)) return cachedLiveData;

    try {
        const response = await fetch(ZET_RT_URL, { agent, headers: { 'User-Agent': 'node-fetch' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
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
        console.error("⚠️ [LIVE API ERROR]:", e.message);
        return {};
    }
}

app.get('/api/stations', (req, res) => res.json(stationList));

app.get('/api/destinations', (req, res) => {
    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const allDestinations = [...new Set(schedule.map(trip => trip.smjer))].sort();
    
    res.json(allDestinations);
});

app.get('/api/board', async (req, res) => {
    const todayStr = getCurrentDateStr();
    
    // --- PAMETNI SAFETY CHECK ---
    // Provjeravamo datum SAMO ako je prošlo 4 ujutro.
    // Ako je 01:00 iza ponoći, loadedDateStr je još "jučer" i to je TOČNO!
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    
    if (now.getHours() >= 4 && loadedDateStr !== "" && loadedDateStr !== todayStr) {
        console.log(`⚠️ [SYSTEM] Novi dan je svanuo (${todayStr}), a ja imam stare podatke. Refresh!`);
        loadedDateStr = todayStr; 
        downloadAndUnzipGTFS().then(() => loadGtfsFilesToMemory());
    }
    // ----------------------------

    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const liveDelays = await getLiveFeed();
    
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    // ADJUST ZA PONOĆ: Ako je sad 00:30, to je zapravo 24:30 u GTFS svijetu
    // Ovo nam treba da nađemo noćne linije u rasporedu
    let searchMinutes = currentMinutes;
    if (now.getHours() < 4) {
        searchMinutes += 24 * 60; // 00:30 postaje 1470 minuta
    }

    const board = [];
    
    for (const trip of schedule) {
        // Gledamo raspored koristeći prilagođene minute (npr 24:30)
        if (trip.timeMin >= searchMinutes - 10 && trip.timeMin <= searchMinutes + 90) {
            
            let finalTimeMin = trip.timeMin;
            let status = "SCHED"; 
            
            if (liveDelays[trip.trip_id] !== undefined) {
                const delaySec = liveDelays[trip.trip_id];
                const delayMin = Math.round(delaySec / 60);
                
                finalTimeMin = trip.timeMin + delayMin;
                status = "LIVE"; 
            }

            // Ovdje računamo koliko je do dolaska. 
            // searchMinutes je već "napuhan" za noćne sate (npr 24:30), 
            // a trip.timeMin je također u tom formatu (jer ZET tako šalje), pa matematika štima.
            const minutesUntil = finalTimeMin - searchMinutes;

            if (minutesUntil >= -2) {
                // Vrati vrijeme u normalan format (ako je 24:30, prikaži 00:30)
                let displayTime = minutesToTime(finalTimeMin);
                
                board.push({
                    linija: trip.linija,
                    smjer: trip.smjer,
                    min: minutesUntil,
                    time: displayTime,
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