"""Health of this computer, read from /proc and /sys. Cheap enough for every few seconds."""
import glob
import resource
import time


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


class BoardStats:
    def __init__(self):
        self.zones = glob.glob("/sys/class/thermal/thermal_zone*/temp")
        self.last_cpu = None
        self.last_own = None

    def _cpu_percent(self):
        fields = _read("/proc/stat").split("\n", 1)[0].split()[1:]
        if len(fields) < 5:
            return None
        values = [int(v) for v in fields]
        total, idle = sum(values), values[3] + values[4]
        previous, self.last_cpu = self.last_cpu, (total, idle)
        if previous is None or total == previous[0]:
            return None
        return round(100 * (1 - (idle - previous[1]) / (total - previous[0])))

    def _own_percent(self):
        now = (time.monotonic(), time.process_time())
        previous, self.last_own = self.last_own, now
        if previous is None or now[0] == previous[0]:
            return None
        return round(100 * (now[1] - previous[1]) / (now[0] - previous[0]), 1)

    def read(self):
        temps = [int(t) for t in (_read(z).strip() for z in self.zones) if t.isdigit()]
        memory = {}
        for line in _read("/proc/meminfo").splitlines()[:3]:
            name, _, value = line.partition(":")
            memory[name] = int(value.split()[0])
        uptime = _read("/proc/uptime").split()
        total = memory.get("MemTotal")
        return {
            "cpu": self._cpu_percent(),
            "temp": round(max(temps) / 1000) if temps else None,
            "mem": round(100 * (1 - memory["MemAvailable"] / total)) if total and "MemAvailable" in memory else None,
            "up": int(float(uptime[0])) if uptime else None,
            "own": self._own_percent(),
            "ownMem": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
        }
