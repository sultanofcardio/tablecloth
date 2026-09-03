# Window-scoped screenshots for the README capture rig.
# Usage:
#   shoot.py list                      -> JSON array of current Code window ids
#   shoot.py <mode> <out.png> <baseline.json>
# Picks the largest on-screen VS Code window not present in the baseline;
# 'dialog' mode prefers the floating Data Source window by title.
import json
import subprocess
import sys

import Quartz


def windows():
    info = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    out = []
    for w in info:
        out.append(
            {
                "id": w.get("kCGWindowNumber"),
                "owner": w.get("kCGWindowOwnerName", "") or "",
                "name": w.get("kCGWindowName", "") or "",
                "bounds": dict(w.get("kCGWindowBounds", {})),
            }
        )
    return out


def code_windows():
    return [w for w in windows() if "Code" in w["owner"]]


if sys.argv[1] == "list":
    print(json.dumps([w["id"] for w in code_windows()]))
    sys.exit(0)

mode, out, baseline_path = sys.argv[1], sys.argv[2], sys.argv[3]
baseline = set(json.load(open(baseline_path)))
cands = [
    w
    for w in code_windows()
    if w["id"] not in baseline and w["bounds"].get("Height", 0) > 150 and w["bounds"].get("Width", 0) > 300
]
TITLE_PREFERENCE = {"dialog": "Data Source", "import": "Import Data"}
wanted = TITLE_PREFERENCE.get(mode, "Extension Development Host")
prefer = [w for w in cands if wanted in w["name"]]
pool = prefer or cands
if not pool:
    print("NOWIN")
    sys.exit(1)
w = sorted(pool, key=lambda x: -(x["bounds"]["Height"] * x["bounds"]["Width"]))[0]
subprocess.run(["screencapture", "-x", "-o", "-l", str(w["id"]), out], check=True)
print("shot", w["id"], repr(w["name"]))
