"""The MAVLink dialect and who this service is on the link: the one place that names the library."""
import os

os.environ["MAVLINK20"] = "1"
from pymavlink.dialects.v20 import ardupilotmega as L  # noqa: E402

SYSID, COMPID = 254, 191
