# Condizionatori Hisense AEH-W4A1

Runbook locale per diagnosticare, collegare alla LAN e comandare vecchi moduli
Wi-Fi Hisense `AEH-W4A1-*`.

## Stato attuale

I quattro moduli sono stati collegati alla rete domestica 2.4 GHz `<SSID-2.4GHz>`.
Gli SSID SoftAP `AEH-W4A1-*` non devono piu' risultare visibili durante il
funzionamento normale.

| IP LAN | MAC | Ex SoftAP | Porta | Stato verificato |
| --- | --- | --- | --- | --- |
| `192.168.1.101` | `b0:41:1d:00:00:01` | `AEH-W4A1-b0411d000001` | `8888` | `OFF` |
| `192.168.1.102` | `b0:41:1d:00:00:02` | `AEH-W4A1-b0411d000002` | `8888` | `OFF` |
| `192.168.1.103` | `b0:41:1d:00:00:03` | `AEH-W4A1-b0411d000003` | `8888` | `OFF` |
| `192.168.1.104` | `b0:41:1d:00:00:04` | `AEH-W4A1-b0411d000004` | `8888` | `OFF` |

La password Wi-Fi corretta e' la credenziale tenuta solo in locale.
Non pubblicare questo repository o report generati se contengono credenziali.

## Hardware e rete

- LAN domestica: `192.168.1.0/24`
- Gateway/router: `192.168.1.1`
- PC via Ethernet: `192.168.1.50`
- Wi-Fi 2.4 GHz usata dai moduli: `<SSID-2.4GHz>`
- Wi-Fi 5 GHz del PC: `<SSID-5GHz>`
- Protocollo locale moduli: TCP `8888`
- Firmware osservato: `+XMV:4.4.6`

I moduli vecchi usano la stessa subnet anche quando sono in SoftAP
(`192.168.1.10` sul modulo, PC spesso `192.168.1.60/101`). Per questo, quando
si lavora in SoftAP, i comandi devono essere vincolati all'interfaccia Wi-Fi
`wlan0`. Quando i moduli sono in LAN, usare gli IP sopra.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install pyaehw4a1==0.3.9
```

Nota: `pyaehw4a1==0.3.9` puo' richiedere `ifaddr` per alcune funzioni di
discovery. Gli script di questo repository usano socket diretti e non dipendono
sempre dal discovery della libreria.

## Discovery

Scansione LAN per trovare moduli con porta `8888`:

```bash
python3 ac_discovery.py --network 192.168.1.0/24 --ports 8888 --no-vendors --json report.json
```

Scansione piu' ampia, inclusa lista Wi-Fi:

```bash
python3 ac_discovery.py --network 192.168.1.0/24 --wifi --json report.json
```

Risultato atteso dopo provisioning riuscito:

- quattro host `possible-old-hisense-ayla`;
- porta `8888` aperta;
- MAC `b0:41:1d:*`;
- nessun SSID `AEH-W4A1-*` visibile.

## Protocollo locale

I moduli non sono HTTP sulla porta `8888`. Parlano protocollo XMV/AT grezzo.

Comandi AT di provisioning confermati dal reverse engineering dell'app vecchia:

```text
AT+XMAP=<ssid_router>,<password_router>\r\n
AT+XMRS=<ip_pc>,8899\r\n
AT+XMCR\r\n
```

Comandi di base:

```text
AT+XMV       -> versione firmware
AT+XMAP=?    -> verifica supporto XMAP
```

Comandi binari supportati da `pyaehw4a1`:

```bash
.venv/bin/python aeh_ap_control.py list-commands
```

Fra i piu' utili:

- `status_102_0`: stato completo, contiene `run_status`
- `on`
- `off`
- `mode_cool`
- `mode_heat`
- `mode_dry`
- `mode_fan`
- `temp_16_C` ... `temp_32_C`
- `speed_auto`, `speed_1` ... `speed_5`, `speed_mute`

## Modello ventola

La ventola e' definita in un'unica tabella `FAN_SPEEDS` in `aeh_lan_control.py`,
da cui derivano etichette, payload e valori attesi (frontend e `server.py`
riusano la stessa mappa). Sette stati: `auto`, 5 velocita' (`speed_1`..`speed_5`)
e `mute`.

| Comando | byte air-volume inviato | wind_status atteso (letto) | note |
| --- | --- | --- | --- |
| `speed_auto` | 1 | 0 | nativo libreria, `0` confermato in lettura |
| `speed_1` | 5 | 4 | = `speed_low` nativo |
| `speed_2` | 6 | 5 | sintetizzato, da confermare |
| `speed_3` | 7 | 6 | = `speed_med` nativo |
| `speed_4` | 8 | 7 | sintetizzato, da confermare |
| `speed_5` | 9 | 8 | = `speed_max` nativo |
| `speed_mute` | 3 | 2 | nativo; il protocollo ha anche un bit `mute` separato |

Stato di verifica: la relazione `wind_status = byte_inviato - 1` e' confermata
solo per `auto`. Da unita' SPENTA il modulo riporta sempre `wind_status 0`,
quindi la mappatura delle velocita' va calibrata con l'unita' ACCESA prima di
considerarla definitiva (in particolare `speed_2`/`speed_4` e il significato di
`mute` come bit separato).

## Verifica acceso/spento

Il campo da usare e' `run_status` dentro la risposta a `status_102_0`:

- `run_status = 0`: spento
- `run_status = 1`: acceso/in marcia

Script rapido per controllare tutti e quattro:

```bash
.venv/bin/python - <<'PY'
import socket, time
from pyaehw4a1.commands import ReadCommand
from pyaehw4a1.responses import ResponsePacket, DataPacket

IPS = ["192.168.1.101", "192.168.1.102", "192.168.1.103", "192.168.1.104"]

def send(ip, timeout=6):
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((ip, 8888))
        sock.sendall(ReadCommand.status_102_0.value)
        return sock.recv(512)
    finally:
        sock.close()

def run_status(data):
    packet_type = f"{data[13]}_{data[14]}"
    expected = next(rp.value for rp in ResponsePacket if packet_type in rp.name)
    bits = f"{int(data.hex(), 16):08b}"[len(expected) * 8:-24]
    for packet in DataPacket:
        if packet_type in packet.name:
            for field in packet.value:
                if field.name == "run_status":
                    raw = bits[field.offset - 1:field.offset + field.length - 1]
                    return int(raw, 2)
    raise RuntimeError(f"run_status non trovato in {packet_type}")

for ip in IPS:
    status = None
    error = None
    for attempt in range(1, 4):
        try:
            status = run_status(send(ip))
            break
        except Exception as exc:
            error = exc
            time.sleep(5)
    label = "OFF" if status == 0 else "ON" if status == 1 else f"UNKNOWN: {error}"
    print(ip, label)
    time.sleep(2)
PY
```

## Policy di polling

I moduli sono vecchi e il servizio TCP `8888` non regge polling aggressivo.
Questo e' stato osservato in particolare su `192.168.1.103`, ma puo' succedere
anche agli altri.

Regole consigliate:

- interrogare un dispositivo alla volta;
- non fare polling parallelo dei quattro split;
- timeout minimo `6s` per `status_102_0`;
- massimo 3 retry;
- pausa `5-8s` fra retry sullo stesso modulo;
- pausa `1-2s` fra moduli diversi;
- usare `AT+XMV` come health check leggero;
- se `status_102_0` fallisce ma `AT+XMV` risponde, aspettare cooldown e riprovare;
- cache dello stato nell'interfaccia, invece di leggere continuamente.

Diagnostica fatta su `192.168.1.103`:

- ping 20/20 senza perdita;
- route via Ethernet `eth0`;
- ARP corretto per MAC `b0:41:1d:00:00:03`;
- `AT+XMV` stabile;
- `status_102_0` intermittente dopo test ravvicinati;
- dopo cooldown di circa 20 secondi, `status_102_0` torna a rispondere.

Conclusione: `184` non sembra avere un problema di rete. Il limite e' il servizio
TCP del modulo quando viene stressato.

## Provisioning gia' riuscito

Il provisioning manuale e' stato confermato. Sequenza usata con successo:

1. Collegare il PC al SoftAP `AEH-W4A1-*` con password standard `12345678`.
2. Verificare IP Wi-Fi del PC sul SoftAP.
3. Inviare:

```text
AT+XMV
AT+XMAP=<ssid_2_4_ghz>,<password_2_4_ghz>
AT+XMRS=192.168.1.50,8899
AT+XMCR
```

4. Attendere circa 45 secondi.
5. Scansionare la LAN e verificare che il modulo compaia sulla porta `8888`.

Se `XMAP` risponde `SUCCEED` ma il modulo torna in SoftAP, la causa piu'
probabile e' password 2.4 GHz errata o router non compatibile con le impostazioni
del vecchio modulo.

Impostazioni router consigliate per questi moduli:

- rete 2.4 GHz separata o comunque visibile come SSID 2.4;
- WPA2-Personal;
- evitare WPA3/PMF obbligatorio;
- evitare password/SSID con caratteri strani se si riprovisiona da zero;
- prenotazioni DHCP per i quattro MAC `b0:41:1d:*`.

## Interfaccia LAN

Configurazione:

```bash
cp config.example.json config.json
nano config.json
```

Nel file puoi impostare password web, secret sessione e lista dei condizionatori:

```json
{
  "auth": {
    "password": "password-lunga",
    "session_secret": "stringa-casuale-lunga"
  },
  "devices": [
    {
      "name": "Clima soggiorno",
      "location": "Soggiorno",
      "ip": "192.168.1.101",
      "mac": "b0:41:1d:00:00:01",
      "softap": "AEH-W4A1-b0411d000001"
    }
  ]
}
```

`config.json` e' ignorato da Git perche' contiene credenziali e dati locali.
Le variabili `AC_WEB_PASSWORD` e `AC_SESSION_SECRET`, se presenti, hanno
precedenza rispetto al file.

Avvio server:

```bash
.venv/bin/python server.py --host 127.0.0.1 --port 8787 --secure-cookies
```

Aprire:

```text
http://127.0.0.1:8787
```

Per test locale senza autenticazione:

```bash
.venv/bin/python server.py --host 127.0.0.1 --port 8787 --dev-no-auth
```

Non usare `--dev-no-auth` se il servizio e' raggiungibile da altri dispositivi.

La versione attuale dell'interfaccia lavora direttamente sui quattro IP LAN
configurati in `aeh_lan_control.py`.

L'interfaccia e' mobile-first e ha due modalita', commutabili dall'interruttore
in alto a destra (la scelta e' ricordata nel browser):

- **Utente**: solo i controlli quotidiani (accensione, dial temperatura,
  modalita', ventola, funzioni rapide, timer). Nessuna diagnostica.
- **Avanzata**: aggiunge i comandi evoluti completi (tutti i gruppi di
  `pyaehw4a1`) e la sezione di diagnostica (invio ora ai moduli, scansione
  rete/SoftAP, stato backend, risposta grezza).

Funzioni disponibili:

- mostra stato `ON/OFF` leggendo `status_102_0`;
- invia `on` e `off`;
- cambia modo, temperatura e velocita' ventola;
- espone le altre funzioni gia' presenti in `pyaehw4a1`: turbo, eco,
  display, sleep, alette verticali/orizzontali, Celsius/Fahrenheit e letture
  diagnostiche (modalita' avanzata);
- interroga firmware con `AT+XMV`;
- mostra ora e timer letti da `status_102_0`, quando presenti;
- gestisce timer server-side per accensione/spegnimento;
- mantiene una sezione di diagnostica per scansione rete e SoftAP (avanzata).

I comandi operativi inviati dalla UI o da `/api/lan-command` sono sempre per
singolo host. Dopo un comando il server rilegge solo lo stesso condizionatore
per aggiornare la cache della sua scheda.

Il backend mantiene una cache dello stato:

- alla partenza invia il comando dedicato di sincronizzazione ora e poi fa un
  polling iniziale;
- ogni 5 minuti fa polling sequenziale dei quattro moduli;
- circa ogni ora, al posto del polling previsto, esegue il ciclo di sync ora;
- ogni 20 secondi controlla se ci sono timer server in scadenza;
- `GET /api/status` restituisce l'ultimo stato in cache;
- `GET /api/status?refresh=1&host=<ip>` forza la lettura del SOLO condizionatore
  indicato (e' il pulsante "aggiorna" della scheda selezionata);
- `GET /api/status?refresh=1` senza `host` valido ricade sulla lettura di tutti
  e quattro i moduli.

## Timer server-side

I timer della webapp simulano il timer del telecomando: il server controlla
l'orario e invia `on` o `off` al singolo condizionatore configurato.

Caratteristiche:

- i timer sono salvati in `timers.json`;
- ogni timer ha `host`, comando `on/off`, orario `HH:MM`, giorni e stato
  abilitato/disabilitato;
- un timer viene eseguito al massimo una volta al giorno;
- dopo l'esecuzione il server rilegge solo lo stato del condizionatore coinvolto.

Endpoint:

- `GET /api/timers`
- `POST /api/timers`
- `PUT /api/timers`
- `DELETE /api/timers?id=<id>`

Nota ora/timer: i campi `hour`, `minute`, timer accensione e timer spegnimento
sono visibili nella risposta `status_102_0`, quindi il protocollo li prevede.
La libreria `pyaehw4a1==0.3.9` pero' non espone il comando di scrittura ora o
timer. Nel codice e' presente `sync_time` come punto unico da completare appena
viene identificato il pacchetto corretto; il comando ASCII sperimentale
`AT+XMT=HH,MM,SS` viene tracciato, ma sui moduli testati l'ora letta resta
`00:00`.

Endpoint principali:

- `GET /api/devices`: elenco dei quattro moduli configurati;
- `GET /api/status`: ultimo stato in cache;
- `GET /api/status?refresh=1&host=<ip>`: lettura forzata del solo modulo indicato
  (senza `host` valido ricade su tutti e quattro);
- `POST /api/lan-command`: comando LAN a un modulo configurato;
- `POST /api/login`: autenticazione web;
- `POST /api/logout`: chiusura sessione.

Esempio:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/lan-command \
  -H 'Content-Type: application/json' \
  -d '{"host":"192.168.1.102","command":"on"}'
```

## CLI LAN

Elenco dispositivi configurati:

```bash
.venv/bin/python aeh_lan_control.py devices
```

Stato sequenziale dei quattro moduli:

```bash
.venv/bin/python aeh_lan_control.py status-all
```

Invio comando a un modulo:

```bash
.venv/bin/python aeh_lan_control.py cmd --host 192.168.1.102 off
```

La CLI usa timeout `6s`, massimo 3 retry e pause fra dispositivi per rispettare
il limite dei vecchi servizi TCP `8888`.

## Webapp/PWA e accesso remoto

La cartella `webapp/` contiene una PWA, cioe' una pagina web installabile dal
browser del telefono tramite "Aggiungi alla schermata Home" / "Installa app".
Serve HTTPS valido per l'installazione affidabile su cellulare; il tuo Apache
con certificato HTTPS puo' fare da reverse proxy verso il server Python locale.

Abilitare i moduli Apache:

```bash
sudo a2enmod proxy proxy_http headers ssl
sudo systemctl reload apache2
```

Esempio di VirtualHost HTTPS:

```apache
<VirtualHost *:443>
    ServerName clima.example.com

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/clima.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/clima.example.com/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass / http://127.0.0.1:8787/
    ProxyPassReverse / http://127.0.0.1:8787/

    Header always set X-Content-Type-Options "nosniff"
    Header always set Referrer-Policy "same-origin"
    Header always set X-Frame-Options "DENY"
</VirtualHost>
```

Il server Python deve restare in ascolto solo su `127.0.0.1`, cosi' da non
esporre direttamente la porta `8787` su Internet. L'accesso remoto passa solo da
Apache HTTPS e dalla password `AC_WEB_PASSWORD`.

Per avvio persistente conviene usare `systemd` con variabili d'ambiente:

```ini
[Service]
WorkingDirectory=/home/utente/condizionatore
Environment=AC_WEB_PASSWORD=metti-qui-una-password-lunga
Environment=AC_SESSION_SECRET=metti-qui-una-stringa-casuale-lunga
ExecStart=/home/utente/condizionatore/.venv/bin/python server.py --host 127.0.0.1 --port 8787 --secure-cookies
Restart=always
```

Non pubblicare mai il servizio senza autenticazione. Per accesso remoto ancora
piu' robusto, metti anche una protezione aggiuntiva a monte, per esempio VPN,
allowlist IP o autenticazione Apache.

## Altri dispositivi rilevati

Durante le scansioni sono apparsi altri dispositivi non Hisense:

- host `Mongoose/6.18`: dispositivi Shelly;
- `192.168.1.60` con titolo `ST SPWF01S`: modulo ST/Ariston, non uno degli
  `AEH-W4A1`.

Non usarli per il controllo Hisense.

## File principali

- `ac_discovery.py`: scan LAN, porte e Wi-Fi visibili.
- `aeh_ap_control.py`: comandi XMV/AT e binari verso SoftAP.
- `aeh_lan_control.py`: comandi LAN diretti verso gli IP configurati.
- `aeh_w4a1_tool.py`: probe minimale XMV/status.
- `app_config.py`: caricamento `config.json` e fallback di default.
- `config.example.json`: esempio configurazione dispositivi/password.
- `server.py`: backend HTTP con autenticazione, polling, timer e API.
- `webapp/`: PWA installabile su telefono.
- `timers.json`: timer server-side persistenti.
- `report.json`, `aeh_ap_probe.json`: report generati durante le prove.

## Note di reverse engineering

L'app vecchia decompilata usa comandi Hisense/XM su TCP `8888`, non un endpoint
HTTP classico. I comandi di provisioning trovati e verificati sono `XMAP`,
`XMRS`, `XMCR`.

Nel codice dell'app:

- `AT+XMAP=?` conferma il comando di configurazione router;
- `AT+XMAP=<ssid>,<password>` salva SSID e password;
- `AT+XMRS=<ip>,<port>` configura il callback locale;
- `AT+XMCR` avvia la connessione al router.

Per il controllo locale in LAN resta valido il protocollo binario della libreria
`pyaehw4a1`.
