//OMXPlayer + Wrapper anlegen
var omxp = require('omxplayer-controll');

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
const timelite = require('timelite');

const fs = require('fs-extra');
const path = require('path');
const arrayMove = require('array-move');
const { execSync } = require('child_process');

//Aus Config auslesen wo die Video-Dateien liegen
const config = fs.readJsonSync(__dirname + '/config.json');
const videoFilesDir = config.videoDir + "/wvp/mp4";
const jsonDir = config.videoDir + "/wvp/json";

//Wo liegen die Symlinks auf die Videos
const symlinkDir = config.symlinkDir;

//Symlink Verzeichnis leeren
fs.emptyDirSync(symlinkDir);

//Zeit wie lange bis Shutdown durchgefuhert wird bei Inaktivitaet
const countdownTime = config.countdownTime;
var countdownID = null;

//Aktuelle Infos zu Volume, etc. merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
data = [];
data["volume"] = 50;
data["position"] = -1;
data["files"] = [];
data["fileTime"] = 0;
data["filesTotalTime"] = null;
data["paused"] = false;
data["countdownTime"] = -1;
data["time"] = 0;
data["mainJSON"] = {};

//JSON fuer Oberflaeche erstellen mit Infos zu aktiven Foldern, Filtern, etc.
getMainJSON();

//JSON nach x Sekunden nochmal laden, damit Aenderungen von Nextcloud Sync sichtbar werden (neue Playlists)
setTimeout(() => {
    console.log("reload main json");
    getMainJSON();
    sendClientInfo(["mainJSON"]);
}, 40000);

//Countdown starten
startCountdown();

//Anzahl der Sekunden des aktuellen Tracks
//TODO: check var vs. let
var trackTotalTime = 0;

//Summe der h, m, s der Dateien, die Playlist nach aktueller Position kommen
var followingTracksTimeString = "00:00:00";

//Liste der konkreten Dateinamen (als symlinks)
var symlinkFiles = [];

//Wenn ein Video laeuft, ermitteln wo wir gerade sind und ob Video noch laueft
var timeAndStatusIntervalID = null;

//Wenn sich ein WebSocket-Client mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn Client eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        const obj = JSON.parse(message);
        const type = obj.type;
        const value = obj.value;

        //Array von MessageObjekte erstellen, die an WS gesendet werden
        const messageArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //System herunterfahren
            case "shutdown":
                shutdown();
                break;

            //neue Playlist laden (ueber Browser-Aufruf) oder per RFID-Karte
            case "add-to-video-playlist": case "set-rfid-playlist":
                console.log(type + JSON.stringify(value));

                //Countdown wieder stoppen
                resetCountdown();

                //Wenn Video gestartet werden soll, bisherige Playlist zuruecksetzen
                if (value.startPlayback) {
                    resetPlaylist();
                }

                //Ermitteln an welcher Stelle / unter welchem Namen die neue Datei eingefuegt wird
                const nextIndex = data["files"].length;

                //Dateiobjekt sammeln ("Conni back Pizza", "00:13:05", "kinder/conni/conni-backt-pizza.mp4")
                data["files"].push({
                    "file": value.file,
                    "name": value.name,
                    "length": value.length
                });
                console.log("current files:\n" + JSON.stringify(data["files"]));

                //Laengen-Merkmal aus Playlist-Array extrahieren und addieren
                const playlist_length_array = timelite.time.add(data["files"].map(item => item.length));

                //Ergebnis als String: [0, 5, 12] -> "00:05:12" liefern
                data["filesTotalTime"] = timelite.time.str(playlist_length_array);
                console.log("playlist total length: " + data["filesTotalTime"]);

                //nummerierten Symlink erstellen
                const srcpath = videoFilesDir + "/" + value.file;
                const dstpath = symlinkDir + "/" + nextIndex + "-" + path.basename(value.file);
                fs.ensureSymlinkSync(srcpath, dstpath);

                //Symlink-Dateinamen merken
                symlinkFiles.push(dstpath);
                console.log("symlink files:\n" + symlinkFiles);

                //wenn flag gesetzt ist
                if (value.startPlayback) {

                    //beim 1. Video beginnen, Video starte und Pausierung zuruecksetzen
                    data["position"] = 0;
                    startVideo();
                    data["paused"] = false;
                }

                //Gesamtspielzeit der Playlist anpassen
                updatePlaylistTimes();

                //Zusaetzliche Nachricht an clients, dass nun nicht mehr pausiert ist, welches das active-item, file-list und resetteten countdown
                messageArr.push("paused", "position", "files", "filesTotalTime");
                break;

            //Titel aus Playlist entfernen
            case 'remove-from-playlist':
                console.log("remove-item " + value);
                data["files"].splice(value, 1);
                symlinkFiles.splice(value, 1);

                //Wenn keine Dateien mehr in Playlist sind, Countdown starten
                if (data["files"].length === 0) {
                    startCountdown();
                }

                //Gesamtspielzeit der Playlist anpassen und Clients informieren
                updatePlaylistTimes();
                messageArr.push("files", "filesTotalTime");
                break;

            //Playlist umsortieren und Clients informieren
            case 'sort-playlist':
                console.log("move item " + value.from + " to " + value.to);
                data["files"] = arrayMove(data["files"], value.from, value.to);
                symlinkFiles = arrayMove(symlinkFiles, value.from, value.to);

                //Wenn gerade Video laeuft, ggf. aktiven Index anpassen
                if (data["position"] > -1) {

                    //Wenn aktives Video verschoben wurde -> aktiver Index = Zielposition
                    if (value.from === data["position"]) {
                        data["position"] = value.to;
                    }

                    //Wenn Titel vor aktivem Video auf die Position des aktiven Videos oder dahinter geschoben wurde -> aktiven Video rueckt eins nach oben
                    else if (value.from < data["position"] && value.to >= data["position"]) {
                        data["position"] -= 1;
                    }

                    //Wenn Titel hinter aktivem Video auf die Position des aktiven Videos oder davor geschoben wurde -> aktiven Video rueckt eins nach unten
                    else if (value.from > data["position"] && value.to <= data["position"]) {
                        data["position"] += 1;
                    }
                }
                messageArr.push("files", "position");
                break;

            //Sprung zu einem bestimmten Video in Playlist
            case "jump-to":

                //Wie viele Schritte in welche Richtung springen?
                const jumpTo = value - data["position"];
                console.log("jump-to " + jumpTo);

                //wenn nicht auf das bereits laufende Video geklickt wurde
                if (jumpTo !== 0) {

                    //zu gewissem Titel springen
                    data["position"] = value;

                    //Zeit anpassen, die die nachfolgenden Videos der Playlist haben und wie lange das aktuelle Video geht
                    updatePlaylistTimes();

                    //Video starten
                    startVideo();
                }

                //es wurde auf den bereits laufenden Titel geklickt, Video von vorne starten
                else {
                    omxp.setPosition(0);
                }

                //Pausierung zuruecksetzen und Clients informieren
                data["paused"] = false;
                messageArr.push("paused", "position");
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll, max 100
                if (value) {
                    data["volume"] = Math.min(100, data["volume"] + 10);
                }

                //es soll leiser werden, min. 0
                else {
                    data["volume"] = Math.max(0, data["volume"] - 10);
                }

                //Lautstaerke anpassen und Clients informieren
                omxp.setVolume(data["volume"] / 100);
                messageArr.push("volume");
                break;

            //Pause-Status toggeln
            case 'toggle-play-pause':

                //Wenn gerade pausiert, Video wieder abspielen
                omxp.playPause();

                //Pausenstatus toggeln und Clients informieren
                data["paused"] = !data["paused"];
                messageArr.push("paused");
                break;

            //Video stoppen
            case "stop":

                //Player pausieren und Video ausblenden (stop Funktion geht derzeit nicht)
                omxp.hideVideo();
                omxp.playPause();

                //Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
                startCountdown();

                //Position zuruecksetzen
                data["position"] = -1;

                //Zeit und Status nicht mehr pruefen, da die Playlist vorbei ist
                clearInterval(timeAndStatusIntervalID)

                //Playlist zuruecksetzen
                resetPlaylist();

                //Zeit anpassen, die die nachfolgenden Videos der Playlist haben und wie lange das aktuelle Video geht
                updatePlaylistTimes();

                //Infos an Client schicken, damit Playlist dort zurueckgesetzt wird
                messageArr.push("position", "files");
                break;

            //Innerhalb des Titels spulen
            case "seek":

                //in welche Richtung wird gespielt
                const offset = value ? 10000000 : -10000000

                //Neue Position berechnen und spulen
                const newPosition = (data["time"] * 1000000) + offset;
                console.log("seek to new position " + newPosition / 1000000);
                omxp.setPosition(newPosition);

                //Neu (errechnete) Zeit setzen, damit mehrmaliges Spulen funktioniert
                data["time"] = newPosition / 1000000;
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageArr);
    });

    //WS einmalig bei der Verbindung ueber div. Wert informieren
    const WSConnectMessageArr = ["volume", "position", "paused", "files", "filesTotalTime", "mainJSON"];

    //Ueber Messages gehen, die an Clients geschickt werden
    WSConnectMessageArr.forEach(message => {
        const messageObj = {
            "type": message,
            "value": data[message]
        };
        ws.send(JSON.stringify(messageObj));
    });
});

//Infos ans WS-Clients schicken
function sendClientInfo(messageArr) {
    messageArr.forEach(message => {
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify({
                    "type": message,
                    "value": data[message]
                }));
            }
            catch (e) { }
        }
    });
}

//JSON fuer Oberflaeche berechnen mit aktiven Foldern, Filtern,...
function getMainJSON() {

    //In Videolist sind Infos ueber Modes und Filter
    const jsonObj = fs.readJSONSync(jsonDir + "/videolist.json");

    //Array, damit auslesen der einzelnen Unter-JSONs (bibi-tina.json, bobo.json) parallel erfolgen kann
    const modeDataFileArr = [];

    //Ueber Modes gehen (hsp, kindermusik, musikmh)
    for (let [mode, modeData] of Object.entries(jsonObj)) {

        //merken, welche Filter geloescht werden sollen
        const inactiveFilters = [];

        //Ueber Filter des Modus gehen (bibi-tina, bobo,...)
        modeData["filter"]["filters"].forEach((filterData, index) => {

            //filterID merken (bibi-tina, bobo)
            const filterID = filterData["id"];

            //All-Filter wird immer angezeigt -> "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
            if (filterID === "all") {
                delete jsonObj[mode]["filter"]["filters"][index]["active"];
                return;
            }

            //Wenn Modus aktiv ist
            if (filterData["active"]) {

                //Feld "active" loeschen (wird nicht fuer die Oberflaeche benoetigt)
                delete jsonObj[mode]["filter"]["filters"][index]["active"];

                //JSON dieses Filters holen (z.B. bibi-tina.json)
                const jsonLink = jsonDir + "/" + mode + "/" + filterID + ".json";
                modeData = {
                    data: fs.readJSONSync(jsonLink),
                    filterID: filterID,
                    mode: mode
                };

                //Titel merken eines Items
                modeDataFileArr.push(modeData);
            }

            //Filter (und die zugehoerigen Dateien) sollen nicht sichtbar sein -> Filter sammeln -> wird spaeter geloescht
            else {
                inactiveFilters.push(filterData);
            }
        });

        //Ueber inaktive Filter gehen und aus JSON-Obj loeschen
        inactiveFilters.forEach(filter => {
            const filterIndex = jsonObj[mode]["filter"]["filters"].indexOf(filter);
            jsonObj[mode]["filter"]["filters"].splice(filterIndex, 1);
        });
    }

    //Ueber die Treffer (JSON-files) gehen
    modeDataFileArr.forEach(result => {

        //Ueber Daten (z.B. einzelne Video items) gehen
        result["data"].forEach(modeItem => {

            //Wenn Video inaktiv ist, dieses nicht in Liste einfuegen
            if (modeItem["inactive"]) {
                return;
            }

            //Modus einfuegen (damit Filterung in Oberflaeche geht)
            modeItem["mode"] = result["filterID"];

            //Playlist-Objekt in Ausgabe Objekt einfuegen
            jsonObj[result["mode"]]["items"].push(modeItem);
        });
    });

    //Wert merken, damit er an Clients uebergeben werden kann
    data["mainJSON"] = jsonObj;
}

//Video starten
function startVideo() {

    //Wenn wir noch nicht beim letzten Video vorbei sind
    if (data["position"] < data["files"].length) {

        //Zeit anpassen, die die nachfolgenden Videos der Playlist haben und wie lange das aktuelle Video geht
        updatePlaylistTimes();

        //Zeit und Status kurzzeitig nicht mehr pruefen, damit Video nicht mehrfach weitergeschaltet wird
        clearInterval(timeAndStatusIntervalID);

        //Position-Infos an Clients schicken
        sendClientInfo(["position"]);

        //Symlink aus aktueller Position in Playlist ermitteln
        const video = symlinkFiles[data["position"]];
        console.log("play video " + video);

        //Optionen fuer neues Video setzen und Video starten
        const opts = {
            'audioOutput': 'hdmi',
            'blackBackground': true,
            'disableKeys': true,
            'disableOnScreenDisplay': false,
            'disableGhostbox': true,
            'startAt': 0,
            'startVolume': (data["volume"] / 100) //0.0 ... 1.0 default: 1.0
        };
        omxp.open(video, opts);

        //Aktion mit leichter Verzoegerung ausfuehren (damit Video von ggf. langsamen USB-Stick schnell genug gestartet werden kann)
        //Regelmaessig pruefen wo wir im Video sind und ob das Video noch laueft (=> automatisch weiter in der Playlist gehen, falls Video fertig)
        setTimeout(() => {
            timeAndStatusIntervalID = setInterval(getPos, 1000);
        }, 2000);
    }

    //Playlist ist vorbei
    else {
        console.log("playlist over");

        //Zeit und Status nicht mehr pruefen, da die Playlist vorbei ist
        clearInterval(timeAndStatusIntervalID);

        //Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
        startCountdown();

        //Position zuruecksetzen
        data["position"] = -1;

        //Playlist zuruecksetzen
        resetPlaylist();

        //Clients informieren, dass Playlist fertig ist (position 0)
        sendClientInfo(["position", "files"]);
    }
}

//Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
function startCountdown() {
    console.log("start countdown")
    data["countdownTime"] = countdownTime;
    countdownID = setInterval(countdown, 1000);
}

//Countdown wieder stoppen (z.B. weil Titel in Playlist eingefuegt wurde)
function resetCountdown() {
    console.log("reset countdown");
    clearInterval(countdownID);
    countdownID = null;
    data["countdownTime"] = -1;
    sendClientInfo(["countdownTime"]);
}

//Bei Inaktivitaet Countdown runterzaehlen und Shutdown ausfuehren
function countdown() {

    //Wenn der Countdown noch nicht abgelaufen ist
    if (data["countdownTime"] >= 0) {
        console.log("shutdown in " + data["countdownTime"] + " seconds");

        //Anzahl der Sekunden bis Countdown an Clients schicken
        sendClientInfo(["countdownTime"]);

        //Zeit runterzaehlen
        data["countdownTime"]--;
    }

    //Countdown ist abgelaufen, Shutdown durchfuehren
    else {
        shutdown();
    }
}

//Pi herunterfahren und TV ausschalten
function shutdown() {
    console.log("shutdown");

    //Shutdown-Info an Clients schicken
    sendClientInfo(["shutdown"]);

    //TV ausschalten
    execSync("echo standby 0 | cec-client -s -d 1");

    //Pi herunterfahren
    execSync("shutdown -h now");
}

//Position in Video ermitteln
function getPos() {

    //Playing, Paused, undefined
    omxp.getStatus(function (err, status) {
        //console.log(status);

        //Wenn gerade kein Video laueft, ist das aktuelle Video fertig. Zum naechsten Titel gehen und Video starten
        if (status === undefined) {
            console.log("video over, go to next video");
            data["position"] += 1;
            startVideo();
        }
    });

    //Position anfordern
    omxp.getPosition(function (err, trackSecondsFloat) {

        //Wenn Video laeuft
        if (trackSecondsFloat) {

            //Umrechnung zu Sek: 134368 => 13 Sek
            const trackSeconds = Math.trunc(trackSecondsFloat / 1000000);

            //data["time"] merken (fuer seek mit setPosition)
            data["time"] = trackSeconds;
            console.log('track progress is', trackSeconds);

            //Restzeit des aktuellen Tracks berechnen
            const trackSecondsRemaining = trackTotalTime - trackSeconds;

            //Timelite String errechnen fuer verbleibende Zeit des Tracks
            data["fileTime"] = generateTimeliteStringFromSeconds(trackSecondsRemaining);

            //jetzt berechnen wie lange die gesamte Playlist noch laeuft: Restzeit des aktuellen Tracks + Summe der Gesamtlaenge der folgenden Tracks
            data["filesTotalTime"] = timelite.time.str(timelite.time.add([data["fileTime"], followingTracksTimeString]));

            //Clients ueber aktuelle Zeiten informieren
            sendClientInfo(["fileTime", "filesTotalTime"]);
        }
    });
}

//Merken wie lange der aktuelle Track geht und ausrechnen wie lange die noch folgenden Tracks der Playlist dauern
function updatePlaylistTimes() {

    //Zeit zuruecksetzen
    trackTotalTime = 0;

    //Sofern die Playlist laueft
    if (data["position"] > -1) {

        //die Anzahl der Sekunden der aktuellen Datei berechnen und merken
        const file = data["files"][data["position"]]["length"];
        trackTotalTime = parseInt(file.substring(0, 2)) * 3600 + parseInt(file.substring(3, 5)) * 60 + parseInt(file.substring(6, 8));
    }

    //Laenge der Files aufsummieren, die nach aktueller Position kommen
    followingTracksTimeString = timelite.time.str(timelite.time.add(
        data["files"]
            .filter((file, pos) => pos > data["position"])
            .map(file => file["length"])));

    //Neue Gesamtlauftzeit der Playlist setzen
    data["filesTotalTime"] = followingTracksTimeString;
}

//Aus Sekundenzahl Timelite Array [h, m, s] bauen
function generateTimeliteStringFromSeconds(secondsTotal) {

    //Variablen setzen, falls noch kein sinnvoller Wert geliefert wird
    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    //Wenn OMX sinnvolle Werte liefern, Umrechung der Sekunden in [h, m, s] fuer formattierte Darstellung
    if (secondsTotal > 0) {
        hours = Math.floor(secondsTotal / 3600);
        secondsTotal %= 3600;
        minutes = Math.floor(secondsTotal / 60);
        seconds = secondsTotal % 60;
    }

    //h, m, s-Werte in Array packen
    return timelite.time.str([hours, minutes, seconds]);
}

//Playlist zuruecksetzen (z.B. bei Stop oder wenn Playlist zu Ende gelaufen ist)
function resetPlaylist() {

    //Files zuruecksetzen
    data["files"] = [];

    //Symlink files zuruecksetzen
    symlinkFiles = [];

    //Symlink Verzeichnis leeren
    fs.emptyDirSync(symlinkDir);
}