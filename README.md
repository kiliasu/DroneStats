# DroneStats

A live MAVLink dashboard for an ArduPilot multicopter, run on the companion computer and opened in any
browser. It shows the view from the aircraft or from behind it as a 3D scene drawn by the viewer's GPU,
a satellite map, the stored mission, fence and rally points, battery forecasts, link quality and the
flight controller's own checks. It is read-only until a viewer turns on execution, and then commands go
through the map: fly here, land here, return, a mission, each shown on the main page as the way it would
go before it is sent. Chinese and English.

一个运行在机载电脑上的 ArduPilot 多旋翼实时仪表盘，用浏览器打开。默认只读；开启执行后，可在地图上直接下达飞往、降落、返航、任务等指令，发送前先在主页面显示预测航线和终点。界面支持中文和英文。

## Install

On the companion computer (Linux with systemd, Python 3.11 or newer):

    git clone <this repository> DroneStats
    cd DroneStats
    ./install.sh

That makes a Python environment in `.venv`, installs `pymavlink`, and starts a service at boot that reads
MAVLink from `127.0.0.1:5678` and serves the page on `127.0.0.1:8080`. Change either with options:

| Option | Default | |
| --- | --- | --- |
| `--mavlink HOST:PORT` | `127.0.0.1:5678` | Any MAVLink TCP endpoint: mavlink-router, MAVProxy, SITL |
| `--listen ADDR:PORT` | `127.0.0.1:8080` | `0.0.0.0:8080` to open it from the local network |
| `--allow-host NAME` | | Another name the page may be opened by, such as `drone.example.com` |
| `--cells N` | 2 (3 with `--sitl`) | Battery cells in series |
| `--baud N` | 57600 | Speed of the serial link to the flight controller, for the link load reading |
| `--sitl DIR` | | Also run an ArduCopter SITL built in this ArduPilot checkout, and read that |
| `--sitl-home LAT,LON,ALT,HDG` | ArduPilot's default | Where the simulated aircraft starts |
| `--user` | | A per-user service, with no root |
| `--no-service` | | Only the environment, to start it by hand |
| `--uninstall` | | Remove the services; keep the code, `.venv` and marks |

Run it again with other options to change them. Then:

    systemctl status dronestats
    journalctl -u dronestats -f              # every command sent is in here
    sudo systemctl restart dronestats        # after editing files in web/

### Reaching the page

The default listens on this computer only. With Tailscale in userspace mode, tailnet connections arrive
over loopback, so the page is reachable from the tailnet and not from the local network. With
`--listen 0.0.0.0:8080` anything that can reach the computer can open it.

The page answers to addresses typed as numbers, to this computer's own name (with `.local` or its
tailnet domain), and to names given with `--allow-host`. Any other name is refused, which stops other
web pages from reaching it through DNS rebinding. Anyone who can open the page can turn on execution:
treat the network it is on as the security boundary.

### A simulated aircraft

    ./install.sh --sitl ~/ardupilot

runs ArduCopter SITL as a second service (a quad X, instance 2: TCP 5780, and 5782 free for a ground
station) and points the dashboard at it. The page and its browser tab say "Sim", so it cannot be taken
for a real aircraft. SITL's own ports listen on every interface; keep them behind a firewall. Build SITL
first with `./waf configure --board sitl && ./waf copter` in the ArduPilot checkout.

### mavlink-router

On a companion computer the flight controller's serial port usually goes through
[mavlink-router](https://github.com/mavlink-router/mavlink-router), which offers TCP 5678.
mavlink-router listens on every interface and cannot be told otherwise; `deploy/mavlink-lan-block.service`
is an optional unit that closes that port to everything but loopback and `tailscale0`.

## What it sends to the flight controller

Read-only by default. While someone is watching it sends only:

- `MAV_CMD_REQUEST_MESSAGE`, one copy of a message that is not already arriving, at most 10 per second
- `PARAM_REQUEST_READ`, for the settings it shows or predicts with, once per connection
- `MAV_CMD_RUN_PREARM_CHECKS`, to learn why it cannot arm, once a minute while it cannot
- `LOG_REQUEST_LIST`, when the flight controller page opens and it is disarmed. It never downloads or
  erases a log, and sends no `LOG_REQUEST_END`, which would cancel a download a ground station is running
- `MISSION_REQUEST_LIST`, `MISSION_REQUEST_INT` and `MISSION_ACK`, to read the stored mission, fence and
  rally points, one item at a time

It never changes stream rates and sends no heartbeat. With nobody watching it does not connect at all.

While someone is watching it also looks at how this computer is connected: `iw` for the Wi-Fi link, a
TCP handshake with the router to time the trip, and tailscaled's local socket to see whether devices in
use reach it directly or through a relay. All of it is optional and none of it touches the flight
controller.

## Commands

Commands need execution turned on, from the top of Details or from the Control menu. That is the one
button that has to be held: it turns execution on and opens the control panel. One connected page at a
time can hold execution. It closes when that page leaves, or after 3 minutes unused unless the aircraft
is armed. The server accepts only what is in the table in `commands.py`, sends each command once, and
refuses a command if the page has not seen live data in the last 3 seconds.

Every other button runs on a press. A command that would take the aircraft somewhere (`takeoff`, `goto`,
`land_at`, `altitude`, `mission_start`, and RTL, Smart RTL, Land or Auto once in the air) is not sent by
that press: it closes whatever it was pressed in and shows on the main page, in the 3D view and on the
map, the way it would go, where it would end and how long that would take, and Run there sends it.
`web/predict.js` works this out from the parameters the flight controller reports, following how
ArduCopter 4.7.1 flies, including the stopping distance at speed; flown against SITL it ended within a
few metres of where it said. It is an estimate, in still air. Commands that go nowhere, such as Brake,
pause, disarm and `kill`, are sent at once.

`commands.py` lists every action with its input as a JSON Schema, its risk, and the rules for when it
may run. `GET /api/commands` serves the table, and the control panel is built from it. It has no web
code, so an MCP server could offer the same actions as tools. The route preview is in the page, not the
server: `/api/exec/run` runs what it is given.

| Action | What it does | Runs only when |
| --- | --- | --- |
| `arm`, `disarm` | Motors on or off | Disarm: the flight controller says at that moment that it is on the ground |
| `mode` | Stabilize, Alt Hold, Loiter, PosHold, Guided, Auto, Circle, Brake, RTL, Smart RTL, Land | Position for the modes that fly on it, home for RTL, a mission for Auto. Away from the ground, a working transmitter with its throttle stick off the bottom for those whose height follows it: Stabilize, Alt Hold, Loiter, PosHold, Circle |
| `takeoff` | Climb to a height | Guided, armed, on the ground, with a position |
| `goto` | Fly to a point within 1 km, switching to Guided first if asked | Armed, in the air, with a position |
| `land_at`, `land_cancel` | Fly to a point and land on arrival, or call that off | As `goto` |
| `altitude` | Change height, keeping the destination | Guided, armed, in the air, with a position |
| `speed`, `yaw`, `pause`, `resume` | In flight | Guided or Auto, armed |
| `mission_start`, `mission_item` | Start the stored mission, or choose its next item | A mission is stored. Start: armed |
| `plan_upload`, `plan_clear` | Replace or erase the mission, fence or rally points | Disarmed |
| `fence_enable` | Turn the fence on or off | Always |
| `set_home`, `param_set` | Make the present position or a given place home, or write one of a few flight limits | Disarmed |
| `calibrate`, `motor_test` | Gyros, barometer, level; spin one motor at up to 30% for up to 5 s | Disarmed, on the ground |
| `reboot` | Restart the flight controller | Disarmed |
| `kill` | Stop the motors at once, even in the air | Armed |

Every reply says what the flight controller answered, whether the telemetry came to show the effect,
and anything it said meanwhile, which is how it explains a refusal. Every attempt goes in a record shown
in the panel, and in the service's journal.

An uploaded plan is checked first, read back afterwards and compared. ArduPilot overwrites a stored
mission as the items arrive, so an interrupted upload can leave part of it behind; the read-back puts
what is really there on the page. Heights in a plan must be above home.

Marks placed on the map are not commands: `POST /api/marks` changes them without execution, every viewer
sees them, and they are kept in the service's state directory.

## The page

- Everything on the map can be used directly. A waypoint, a rally point, a mark, home, the aircraft or
  the fence opens a card when hovered over or tapped, and anywhere else on the map opens one for that
  place. The next tap on bare map closes it. Cards hold what is near at hand: fly here, land here, face
  this way, make this home, go to this item, take off.
- Missions are edited as a draft in the browser until written: add waypoints, loiters, circles, landings,
  rally points and marks, drag them, pull out a point between two, and import or export `.waypoints`
  and `.plan` files.
- Each rotor, on the sight and from behind, is a gauge of its motor's output, amber from 75% and red
  from 90%. The flight path is a broad see-through band; lines that measure or plan stay thin.
- Settings: flight path, distance rings, imagery, stored plan, marks, the size of the aircraft symbol,
  language. Keys: V view, M map, L lock, R reset, F fit, P mission list, Delete the open waypoint, + and -.

## Files

- `server.py`: web server, live updates, command gate
- `telemetry.py`: MAVLink link, state, and up to 30 minutes of history while someone is watching
- `commands.py`: every action that can be asked of the flight controller, and the rules for each
- `plans.py`: reading and writing the stored mission, fence and rally points
- `marks.py`: places marked on the map
- `wire.py`: the MAVLink dialect and this service's IDs, the one place that names the library
- `board.py`, `network.py`: health of this computer and how it is connected
- `web/`: the page. `app.js` runs it, `scene.js` the 3D view, `map.js` the map, `mapui.js` the cards and
  the mission list, `control.js` the control panel, `predict.js` the way a command would go, `plan.js`
  the shapes of what is stored and ground station files, `pages.js` the expanded views, `shared.js` the
  battery forecast, pre-flight checks and flight path
- `deploy/`: unit templates for `install.sh`, and the optional mavlink-router firewall unit
- `tools/fake_fc.py`: a pretend flight controller for development and tests
- `tools/sitl_check.py`: flies ArduPilot SITL through every action, to check them against real firmware
- `tests/`: end-to-end tests against the pretend flight controller

## Development

    ./install.sh --no-service
    .venv/bin/python -m unittest discover -s tests

    .venv/bin/python tools/fake_fc.py --port 15678 --scenario flight
    .venv/bin/python server.py --listen 127.0.0.1:18080 --mavlink 127.0.0.1:15678

Scenarios are `bench`, `ready`, `armed`, `flight`, `low` and `rclost`. `--quiet` sends only heartbeats,
like a link with no ground station. Add `?at=2026-11-05T00:50:00Z` to the page address to preview the
sky at another time, and `?q=1` to keep full resolution on a slow GPU.

The pretend flight controller was written from the same understanding as the code, so it cannot catch a
misunderstanding of the firmware. For that, run the flight check against SITL:

    .venv/bin/python tools/sitl_check.py --mavlink <host>:5760

It flies the simulator, so use the same firmware version as the aircraft. Before sending anything it asks
for `SIM_SPEEDUP`, a setting only simulators have, and stops if there is no answer.

Parameter names follow ArduCopter 4.7, which moved several from centimetres to metres. The aircraft is
drawn at the size set by `ARM` and `ROTOR` in `web/scene.js` (a 7-inch quad); change them for another
airframe. Battery reference points per cell are in `web/shared.js`.

## Credits

Map imagery is Esri World Imagery, requested by the viewer's browser for the aircraft's position; check
Esri's terms before relying on it. The Archivo font is under the SIL Open Font License. Built on
[pymavlink](https://github.com/ArduPilot/pymavlink).

## License

MIT, see `LICENSE`.
