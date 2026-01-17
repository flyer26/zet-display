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
let stationLocations = {}; // NOVO: Pamtimo koordinate stanica
let routesMap = {};
let cachedLiveData = null;
let lastLiveFetch = 0;
let loadedDateStr = ""; 

// Pomoćne funkcije
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

function getCurrentDateStr() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

// Haversine formula za udaljenost (u metrima)
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // Radius zemlje u km
    var dLat = deg2rad(lat2-lat1);  
    var dLon = deg2rad(lon2-lon1); 
    var a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    var d = R * c; 
    return d;
}

function deg2rad(deg) { return deg * (Math.PI/180) }

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
    if (now.getHours() < 4) {
        now.setDate(now.getDate() - 1);
        console.log("🌙 [SYSTEM] Noćni režim: Učitavam raspored za 'jučer'.");
    }
    
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const effectiveDateStr = `${yyyy}${mm}${dd}`;
    
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = days[now.getDay()];

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
            if (row.exception_type === '1') activeServices.add(row.service_id);
            else if (row.exception_type === '2') activeServices.delete(row.service_id);
        }
    });
    return activeServices;
}

async function loadGtfsFilesToMemory() {
    console.log("🔄 [SYSTEM] Gradim bazu...");
    loadedDateStr = getCurrentDateStr();

    const readCsv = (f) => Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    const routes = readCsv('routes.txt');
    const stops = readCsv('stops.txt'); 
    const trips = readCsv('trips.txt');
    
    routesMap = {};
    let stopsIdToName = {};
    staticSchedule = {};
    stationList = [];
    stationLocations = {}; // Reset

    routes.forEach(r => routesMap[r.route_id] = r.route_short_name);

    // GRUPIRANJE STANICA
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
            if (clusters.length > 1) finalName = `${name} (${index + 1})`;

            // Spremi lokaciju (uzimamo koordinate prve stanice u grupi kao referencu)
            if (!stationLocations[finalName]) {
                stationLocations[finalName] = {
                    lat: parseFloat(cluster[0].stop_lat),
                    lon: parseFloat(cluster[0].stop_lon)
                };
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

    const activeServices = getActiveServiceIds();
    const activeTripsMap = new Map();
    trips.forEach(t => {
        if (activeServices.has(t.service_id)) {
            activeTripsMap.set(t.trip_id, { headsign: t.trip_headsign, route_id: t.route_id });
        }
    });

    const fileStream = fs.createReadStream('stop_times.txt');
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isFirst = true;
    let idxTrip=0, idxTime=2, idxStop=3;

    for await (const line of rl) {
        if (isFirst) {
            const headers = line.split(',').map(h => h.trim().replace(/"/g, ''));
            idxTrip = headers.indexOf('trip_id');
            idxTime = headers.indexOf('departure_time');
            idxStop = headers.indexOf('stop_id');
            isFirst = false; continue;
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
            }
        }
    }
    for (const station in staticSchedule) {
        staticSchedule[station].sort((a, b) => a.timeMin - b.timeMin);
    }
    console.log(`✅ [SYSTEM] Baza spremna!`);
    if (global.gc) global.gc(); 
}

function scheduleNextUpdate() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    let nextUpdate = new Date(now);
    nextUpdate.setHours(4, 0, 0, 0);
    if (now > nextUpdate) nextUpdate.setDate(nextUpdate.getDate() + 1);
    const delay = nextUpdate - now;
    setTimeout(async () => {
        if(await downloadAndUnzipGTFS()) await loadGtfsFilesToMemory();
        scheduleNextUpdate();
    }, delay);
}

async function initializeSystem() {
    await downloadAndUnzipGTFS();
    await loadGtfsFilesToMemory();
    scheduleNextUpdate(); 
}

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, timeout: 30000 });
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
            if (e.tripUpdate && e.tripUpdate.stopTimeUpdate && e.tripUpdate.stopTimeUpdate.length > 0) {
                const stu = e.tripUpdate.stopTimeUpdate[0];
                liveMap[e.tripUpdate.trip.tripId] = stu.departure?.delay || stu.arrival?.delay || 0;
            }
        });
        cachedLiveData = liveMap;
        lastLiveFetch = now;
        return liveMap;
    } catch (e) { return {}; }
}

app.get('/api/stations', (req, res) => res.json(stationList));

// NOVI ENDPOINT ZA GPS LOKACIJU
app.get('/api/nearest', (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: "No coordinates" });

    const userLat = parseFloat(lat);
    const userLon = parseFloat(lon);
    
    let closestStation = null;
    let minDist = Infinity;

    for (const [name, loc] of Object.entries(stationLocations)) {
        const dist = getDistanceFromLatLonInKm(userLat, userLon, loc.lat, loc.lon);
        if (dist < minDist) {
            minDist = dist;
            closestStation = name;
        }
    }
    
    // Vraćamo samo ako je bliže od 5km, inače nema smisla
    if (closestStation && minDist < 5) {
        res.json({ name: closestStation, distance: minDist });
    } else {
        res.json({ name: null });
    }
});

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
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Zagreb"}));
    if (now.getHours() >= 4 && loadedDateStr !== "" && loadedDateStr !== todayStr) {
        loadedDateStr = todayStr; 
        downloadAndUnzipGTFS().then(() => loadGtfsFilesToMemory());
    }

    const stationQuery = req.query.station;
    if (!stationQuery) return res.json([]);
    const cleanQuery = stationQuery.trim().toLowerCase();
    const realStationName = stationList.find(s => s.toLowerCase() === cleanQuery);
    if (!realStationName) return res.json([]);

    const schedule = staticSchedule[realStationName] || [];
    const liveDelays = await getLiveFeed();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let searchMinutes = currentMinutes;
    if (now.getHours() < 4) searchMinutes += 24 * 60;

    const board = [];
    for (const trip of schedule) {
        if (trip.timeMin >= searchMinutes - 10 && trip.timeMin <= searchMinutes + 90) {
            let finalTimeMin = trip.timeMin;
            let status = "SCHED"; 
            if (liveDelays[trip.trip_id] !== undefined) {
                finalTimeMin = trip.timeMin + Math.round(liveDelays[trip.trip_id] / 60);
                status = "LIVE"; 
            }
            const minutesUntil = finalTimeMin - searchMinutes;
            if (minutesUntil >= -2) {
                board.push({
                    linija: trip.linija, smjer: trip.smjer,
                    min: minutesUntil, time: minutesToTime(finalTimeMin), status: status
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