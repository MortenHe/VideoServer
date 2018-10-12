//OMXPlayer + Wrapper anlegen
var omxp = require('omxplayer-controll');

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Zeit Formattierung laden: [5, 13, 22] => 05:13:22
const timelite = require('timelite');

//Filesystem und Path Abfragen fuer Playlist
const fs = require('fs-extra');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Verzeichnis wo die Videos liegen
const videoDir = "/media/pi/usb_red/video";

//Wo liegen die Symlinks auf die Videos
const symlinkDir = "/home/pi/mh_prog/symlinkDir";

//Symlink Verzeichnis leeren
fs.emptyDirSync(symlinkDir);

//Zeit wie lange bis Shutdown durchgefuhert wird bei Inaktivitaet
const countdownTime = 180;

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
currentVolume = 50;
currentPosition = 0;
currentFiles = [];
currentPaused = false;
currentRandom = false;
currentActiveItem = "";
currentCountdownTime = countdownTime;
currentTime = 0;

//Liste der konkreten Dateinamen (als symlinks)
symlinkFiles = [];

//wurde umschalten (und damit Video End Callback) vom Nutzer getriggert
userTriggeredChange = false;

//Countdown fuer Shutdown starten, weil gerade nichts passiert
var countdownID = setInterval(countdown, 1000);

//Jede Sekunde, die aktuelle Position des Videos ermitteln
setInterval(getPos, 1000);

//Beim Ende eines Videos
omxp.on('finish', function () {
    console.log("video ended");
    console.log("user trigger " + userTriggeredChange);

    //Wenn das Ende nicht vom Nutzer getriggert wurde (durch prev / next click)
    if (!userTriggeredChange) {
        console.log("end after playback");

        //Wenn wir noch nicht beim letzten Video waren
        if (currentPosition < (symlinkFiles.length - 1)) {
            console.log("play next video");

            //zum naechsten Item in der Playlist gehen
            currentPosition += 1;

            //Video starten
            startVideo();

            //Position-Infos an Clients schicken
            sendClientInfo([{
                type: "set-position",
                value: currentPosition
            }]);
        }

        //wir waren beim letzten Video
        else {
            console.log("playlist over");

            //Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
            countdownID = setInterval(countdown, 1000);

            //Position zuruecksetzen
            currentPosition = 0;

            //Aktives Item zuruecksetzen
            currentActiveItem = "";

            //Files zuruecksetzen
            currentFiles = [];

            //Symlink files zuruecksetzen
            symlinkFiles = [];

            //Symlink Verzeichnis leeren
            fs.emptyDirSync(symlinkDir);

            //Clients informieren, dass Playlist fertig ist (position 0, activeItem "")
            let messageObjArr = [{
                type: "set-position",
                value: currentPosition
            },
            {
                type: "active-item",
                value: currentActiveItem
            },
            {
                type: "set-files",
                value: currentFiles
            }];

            //Infos an Clients schicken
            sendClientInfo(messageObjArr);
        }
    }

    //Video beendet, weil Nutzer prev / next geklickt hat
    else {
        console.log("video ended: triggered by user");

        //Flag zuruecksetzen
        userTriggeredChange = false;
    }
});

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn WS eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        var obj = JSON.parse(message);

        //Werte auslesen
        let type = obj.type;
        let value = obj.value;

        //Array von MessageObjekte erstellen, die an WS gesendet werden
        let messageObjArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //System herunterfahren
            case "shutdown":
                shutdown();
                break;

            //neue Playlist laden (ueber Browser-Aufruf) oder per RFID-Karte
            case "add-to-video-playlist": case "set-rfid-playlist":
                console.log(type + JSON.stringify(value));

                //Countdown fuer Shutdown wieder stoppen, weil nun etwas passiert
                clearInterval(countdownID);

                //Countdown-Zeit wieder zuruecksetzen
                currentCountdownTime = countdownTime;

                //Ermitteln an welcher Stelle / unter welchem Namen die neue Datei eingefuegt
                let nextIndex = currentFiles.length;

                //Dateinamen sammeln ("Conni back Pizza")
                currentFiles.push(value.name);
                console.log("current files:\n" + currentFiles);

                //nummerertien Symlink erstellen
                const srcpath = videoDir + "/" + value.mode + "/" + value.path;
                const dstpath = symlinkDir + "/" + nextIndex + "-" + value.name + ".mp4";
                fs.ensureSymlinkSync(srcpath, dstpath);

                //Symlink-Dateinamen merken
                symlinkFiles.push(dstpath);
                console.log("symlink files:\n" + symlinkFiles);

                //aktives Item setzen, wenn es sich nur um ein einzelnes Video handelt (=1. Video)
                currentActiveItem = value.length === 1 ? value.path : "";

                //Video starten, wenn es das 1. in die Playlist eingefuegte Video ist
                if (currentFiles.length === 1) {
                    startVideo();
                }

                //Zusaetzliche Nachricht an clients, dass nun nicht mehr pausiert ist, welches das active-item, file-list und resetteten countdown
                messageObjArr.push(
                    {
                        type: "active-item",
                        value: currentActiveItem
                    },
                    {
                        type: "set-files",
                        value: currentFiles
                    },
                    {
                        type: "set-countdown-time",
                        value: currentCountdownTime
                    });
                break;

            //Video wurde vom Nutzer weitergeschaltet
            case 'change-item':
                console.log("change-item " + value);

                //wenn der naechste Song kommen soll
                if (value) {

                    //Wenn wir noch nicht beim letzten Titel sind
                    if (currentPosition < (currentFiles.length - 1)) {

                        //zum naechsten Titel springen
                        currentPosition += 1;

                        //User hat Ende des Videos getriggert => nicht automatisch einen Schritt weitergehen
                        userTriggeredChange = true;

                        //Video starten
                        startVideo();
                    }

                    //wir sind beim letzten Titel
                    else {
                        console.log("kein next beim letzten Titel");

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            omxp.playPause();
                        }
                    }
                }

                //der vorherige Titel soll kommen
                else {

                    //Wenn wir nicht beim 1. Titel sind
                    if (currentPosition > 0) {

                        //zum vorherigen Titel springen
                        currentPosition -= 1;

                        //User hat Ende des Videos getriggert => nicht automatisch einen Schritt weitergehen
                        userTriggeredChange = true;

                        //Video starten
                        startVideo();
                    }

                    //wir sind beim 1. Titel
                    else {
                        console.log("1. Titel von vorne");

                        //10 min zurueck springen
                        omxp.setPosition(0);

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            omxp.playPause();
                        }
                    }
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist und neue Position
                messageObjArr.push(
                    {
                        type: "toggle-paused",
                        value: currentPaused
                    }, {
                        type: "set-position",
                        value: currentPosition
                    });
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Wie viele Schritte in welche Richtung springen?
                let jumpTo = value - currentPosition;
                console.log("jump-to " + jumpTo);

                //wenn nicht auf den bereits laufenden geklickt wurde
                if (jumpTo !== 0) {

                    //zu gewissem Titel springen
                    currentPosition = value;

                    //Nutzer hat Track ausgewaehlt
                    userTriggeredChange = true;

                    //Video starten
                    startVideo();
                }

                //es wurde auf den bereits laufenden Titel geklickt
                else {

                    //10 min zurueck springen
                    omxp.setPosition(0);
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist und aktuelle Position in Playlist
                messageObjArr.push(
                    {
                        type: "toggle-paused",
                        value: currentPaused
                    }, {
                        type: "set-position",
                        value: currentPosition
                    });
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll
                if (value) {

                    //neue Lautstaerke merken (max. 100)
                    currentVolume = Math.min(100, currentVolume + 10);
                }

                //es soll leiser werden
                else {

                    //neue Lautstaerke merken (min. 0)
                    currentVolume = Math.max(0, currentVolume - 10);
                }

                //OMXPlayer lauter machen
                omxp.setVolume(currentVolume / 100);

                //Nachricht mit Volume an clients schicken 
                messageObjArr.push({
                    type: type,
                    value: currentVolume
                });
                break;

            //Pause-Status toggeln
            case 'toggle-paused-restart':

                //Wenn gerade pausiert, Video wieder abspielen
                omxp.playPause();

                //Pausenstatus toggeln
                currentPaused = !currentPaused;

                //Nachricht an clients ueber Paused-Status
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                });
                break;

            //Video stoppen
            case "stop":

                //Nutzer hat das Video beendet
                userTriggeredChange = true;

                //Player stoppen
                omxp.hideVideo();

                //Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
                countdownID = setInterval(countdown, 1000);

                //Position zuruecksetzen
                currentPosition = 0;

                //Aktives Item zuruecksetzen
                currentActiveItem = "";

                //Files zuruecksetzen
                currentFiles = [];

                //Symlink files zuruecksetzen
                symlinkFiles = [];

                //Symlink Verzeichnis leeren
                fs.emptyDirSync(symlinkDir);

                //Infos an Client schicken, damit Playlist dort zurueckgesetzt wird
                messageObjArr.push(
                    {
                        type: "set-position",
                        value: currentPosition
                    },
                    {
                        type: "active-item",
                        value: currentActiveItem
                    },
                    {
                        type: "set-files",
                        value: currentFiles
                    });
                break;

            //Innerhalb des Titels spulen
            case "seek":

                //in welche Richtung wird gespielt
                let offset = value ? 1000 : -1000

                //Neue Position berechnen
                let newPosition = (currentTime * 100) + offset;

                //spulen
                omxp.setPosition(newPosition);

                //Neu (errechnete) Zeit setzen, damit mehrmaliges Spulen funktioniert
                currentTime = newPosition / 100;
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageObjArr);
    });

    //WS einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectObjectArr = [{
        type: "change-volume",
        value: currentVolume
    }, {
        type: "set-position",
        value: currentPosition
    }, {
        type: "toggle-paused",
        value: currentPaused
    }, {
        type: "set-files",
        value: currentFiles
    }, {
        type: "active-item",
        value: currentActiveItem
    }];

    //Ueber Objekte gehen, die an WS geschickt werden
    WSConnectObjectArr.forEach(messageObj => {

        //Info an WS schicken
        ws.send(JSON.stringify(messageObj));
    });
});

//Infos ans WS-Clients schicken
function sendClientInfo(messageObjArr) {

    //Ueber Liste der MessageObjekte gehen
    messageObjArr.forEach(messageObj => {

        //Ueber Liste der WS gehen und Nachricht schicken
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}

//Video starten
function startVideo() {

    //Symlink aus aktueller Position in Playlist ermitteln
    let video = symlinkFiles[currentPosition];
    console.log("play video " + video);

    //OPtionen fuer neues Video
    let opts = {
        'audioOutput': 'hdmi',
        'blackBackground': true,
        'disableKeys': true,
        'disableOnScreenDisplay': false,
        'disableGhostbox': true,
        'startAt': 0,
        'startVolume': (currentVolume / 100) //0.0 ... 1.0 default: 1.0
    };

    //Video starten
    omxp.open(video, opts);
}

//Bei Inaktivitaet Countdown runterzaehlen und Shutdown ausfuehren
function countdown() {
    //console.log("inactive");

    //Wenn der Countdown noch nicht abgelaufen ist
    if (currentCountdownTime >= 0) {
        //console.log("shutdown in " + currentCountdownTime + " seconds");

        //Anzahl der Sekunden bis Countdown an Clients schicken
        sendClientInfo([{
            type: "set-countdown-time",
            value: currentCountdownTime
        }]);

        //Zeit runterzaehlen
        currentCountdownTime--;
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
    sendClientInfo([{
        type: "shutdown",
        value: ""
    }]);

    //TV ausschalten
    execSync("echo standby 0 | cec-client -s -d 1");

    //Pi herunterfahren
    execSync("shutdown -h now");
}

//Position in Video ermitteln
function getPos() {

    //Position anfordern
    omxp.getPosition(function (err, totalSecondsFloat) {

        //Float zu int: 13.4323 => 13
        let totalSeconds = Math.trunc(totalSecondsFloat / 100);
        currentTime = totalSeconds;
        //console.log('track progress is', totalSeconds);

        //Umrechung der Sekunden in [h, m, s] fuer formattierte Darstellung
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = totalSeconds % 60;

        //h, m, s-Werte in Array packen
        let output = [hours, minutes, seconds];

        //[2,44,1] => 02:44:01
        let outputString = timelite.time.str(output);

        //Clients ueber aktuelle Zeit informieren
        sendClientInfo([{
            type: "time",
            value: outputString
        }]);
    });
}