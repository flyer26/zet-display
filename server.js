const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
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
const TIMEZONE_OFFSET = 1; // ZG je UTC+1 (zimi), UTC+2 (ljeti) - ZET podaci su u lokalnom vremenu

// --- MEMORY CACHE ---
let cachedLiveData = null;
let lastLiveFetch = 0;
const LIVE_CACHE_SEC = 8;

// --- STATIČNA BAZA (RAM) ---
// Ovdje čuvamo optimizirani raspored
let staticSchedule = {}; // { "Stanica": [ { linija, smjer, vrijemeMin, tripId }, ... ] }
let stationList = [];
let routesMap = {};

// Pomoćno: Pretvori "14:30:00" u minute od ponoći
function timeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

// Pomoćno: Pretvori minute od ponoći u "14:30"
function minutesToTime(mins) {
    let h = Math.floor(mins / 60);
    let m = mins % 60;
    if (h >= 24) h -= 24; // ZET nekad ima 25:00 za noćne
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// --- 1. GTFS LOGIKA (TEŠKI DIO) ---

async function downloadAndUnzipGTFS() {
    console.log("📥 [SYSTEM] Preuzimam GTFS...");
    try {
        const response = await fetch(ZET_GTFS_ZIP);
        if (!response.ok) throw new Error(response.statusText);
        const buffer = Buffer.from(await response.arrayBuffer());
        const zip = new AdmZip(buffer);
        
        // Trebamo više fajlova ovaj put
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

function getTodayServiceIds(calendarData) {
    // Odredi koji je danas dan i vrati aktivne service_id-ove
    const now = new Date();
    // Pretvori u lokalni datum YYYYMMDD
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    const dayIndex = now.getDay(); // 0=Ned, 1=Pon...
    
    // Mapiranje dana za ZET calendar.txt
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = days[dayIndex];

    const activeServices = new Set();

    calendarData.forEach(row => {
        if (row[todayName] === '1' && todayStr >= row.start_date && todayStr <= row.end_date) {
            activeServices.add(row.service_id);
        }
    });
    
    return activeServices;
}

function loadGtfsFilesToMemory() {
    console.log("🔄 [SYSTEM] Gradim bazu rasporeda (ovo traje par sekundi)...");
    try {
        const readCsv = (file) => Papa.parse(fs.readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true }).data;

        // 1. Učitaj osnovno
        const routes = readCsv('routes.txt');
        const stops = readCsv('stops.txt');
        const trips = readCsv('trips.txt');
        const calendar = readCsv('calendar.txt');
        
        // 2. Mapiraj rute i stanice
        routesMap = {};
        let stopsIdToName = {};
        staticSchedule = {}; // Reset
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

        // 3. Nađi današnje aktivne Tripove
        const activeServices = getTodayServiceIds(calendar);
        const activeTripsMap = {}; // trip_id -> { headsign, route_id }
        
        trips.forEach(t => {
            if (activeServices.has(t.service_id)) {
                activeTripsMap[t.trip_id] = { 
                    headsign: t.trip_headsign, 
                    route_id: t.route_id 
                };
            }
        });
        
        console.log(`📅 [INFO] Aktivnih vožnji danas: ${Object.keys(activeTripsMap).length}`);

        // 4. Učitaj Stop Times (STREAMING - da ne ubijemo RAM)
        // PapaParse podržava stream, ali za jednostavnost ovdje koristimo filtered load
        // Ako pukne RAM, morat ćemo na Stream.
        const stopTimesRaw = fs.readFileSync('stop_times.txt', 'utf8');
        Papa.parse(stopTimesRaw, {
            header: true,
            skipEmptyLines: true,
            step: function(row) {
                const data = row.data;
                // Samo ako je trip aktivan danas
                const tripInfo = activeTripsMap[data.trip_id];
                if (tripInfo) {
                    const stopName = stopsIdToName[data.stop_id];
                    if (stopName) {
                        staticSchedule[stopName].push({
                            trip_id: data.trip_id,
                            linija: routesMap[tripInfo.route_id],
                            smjer: tripInfo.headsign,
                            timeMin: timeToMinutes(data.departure_time), // Spremi kao minute radi sortiranja
                            isStatic: true
                        });
                    }
                }
            },
            complete: function() {
                // Sortiraj rasporede po vremenu
                for (const station in staticSchedule) {
                    staticSchedule[station].sort((a, b) => a.timeMin - b.timeMin);
                }
                console.log("✅ [SYSTEM] Raspored učitan i spreman.");
                // Očisti RAM
                if (global.gc) global.gc(); 
            }
        });

    } catch (e) {
        console.error("❌ [ERROR] Buildanje baze:", e);
    }
}

async function initializeSystem() {
    if (!fs.existsSync('stop_times.txt')) await downloadAndUnzipGTFS();
    loadGtfsFilesToMemory();
    setInterval(async () => {
        if(await downloadAndUnzipGTFS()) loadGtfsFilesToMemory();
    }, UPDATE_INTERVAL);
}

// --- 2. LIVE PODACI ---

async function getLiveFeed() {
    const now = Date.now();
    if (cachedLiveData && (now - lastLiveFetch < LIVE_CACHE_SEC * 1000)) {
        return cachedLiveData;
    }

    try {
        const response = await fetch(ZET_RT_URL, { agent, headers: { 'User-Agent': 'node-fetch' } });
        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
        
        // Mapiramo u jednostavniji format: trip_id -> delay
        const liveMap = {};
        
        feed.entity.forEach(e => {
            if (e.tripUpdate) {
                const tripId = e.tripUpdate.trip.tripId;
                // Nađi kašnjenje za zadnju stanicu (ili prvu dostupnu)
                // Pojednostavljenje: uzimamo prvo dostupno kašnjenje u updateu
                if (e.tripUpdate.stopTimeUpdate.length > 0) {
                    const update = e.tripUpdate.stopTimeUpdate[0];
                    const delay = update.departure?.delay || update.arrival?.delay || 0;
                    liveMap[tripId] = delay; // Kašnjenje u sekundama
                }
            }
        });

        cachedLiveData = liveMap;
        lastLiveFetch = now;
        return liveMap;
    } catch (e) {
        console.error("Live fetch error", e);
        return {};
    }
}

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// --- 3. API - BOARD (HYBRID) ---

app.get('/api/stations', (req, res) => res.json(stationList));

// OVO JE GLAVNI ENDPOINT
app.get('/api/board', async (req, res) => {
    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);

    // 1. Nađi točno ime stanice (case insensitive)
    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    
    if (!realStationName) return res.json([]);

    // 2. Dohvati statični raspored za tu stanicu
    const schedule = staticSchedule[realStationName] || [];

    // 3. Dohvati Live podatke
    const liveDelays = await getLiveFeed();

    // 4. Izračunaj trenutno vrijeme (minute od ponoći)
    const now = new Date();
    // Prilagodba za ZET zonu ako je server u Cloudu (UTC)
    const localNow = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const currentMinutes = localNow.getHours() * 60 + localNow.getMinutes();

    // 5. Filtriraj i spoji
    const board = [];
    const TIME_WINDOW = 60; // Gledamo 60 min unaprijed

    // Iteriramo kroz raspored
    for (const trip of schedule) {
        // Prikazujemo samo one koji dolaze uskoro (ili su prošli prije 5 min)
        if (trip.timeMin >= currentMinutes - 5 && trip.timeMin <= currentMinutes + TIME_WINDOW) {
            
            let finalTimeMin = trip.timeMin;
            let isLive = false;
            let status = "SCHED"; // Scheduled

            // Provjeri imamo li LIVE podatke za ovaj trip
            if (liveDelays[trip.trip_id] !== undefined) {
                const delayMin = Math.round(liveDelays[trip.trip_id] / 60);
                finalTimeMin = trip.timeMin + delayMin;
                isLive = true;
                status = "LIVE";
            }

            // Izračunaj "za koliko minuta"
            const minutesUntil = finalTimeMin - currentMinutes;

            board.push({
                linija: trip.linija,
                smjer: trip.smjer,
                min: minutesUntil,
                time: minutesToTime(finalTimeMin),
                status: status // LIVE ili SCHED
            });
        }
    }

    // Sortiraj po stvarnom dolasku
    board.sort((a, b) => a.min - b.min);

    res.json(board);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSystem();
    console.log(`🚀 HYBRID SERVER ONLINE: ${PORT}`);
});