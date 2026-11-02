"""Read-only research: list event datastores, their state, and time windows.

Usage: python scripts/township/research_events.py <save.xml>
Prints a table of events: name, active state, start/end window.
NEVER writes to the save.
"""
import re
import sys
from datetime import datetime, timezone


def main():
    path = sys.argv[1]
    c = open(path, encoding="utf-8", errors="replace").read()

    # every "<DataElem name=X type=dataStore>" that has a statesGraph child
    # is an event instance (gameEvent shape).
    pat = re.compile(
        r'<DataElem name="([A-Za-z0-9_]+)" type="dataStore">(?:(?!</DataElem>).)*?'
        r'name="statesGraph"',
        re.S,
    )
    seen = []
    for m in pat.finditer(c):
        name = m.group(1)
        if name in seen:
            continue
        seen.append(name)
        seg = c[m.start():m.start() + 200000]
        # cut at this event's own end: find currentState within statesGraph
        g = re.search(r'name="currentState" type="string" value="([^"]*)"', seg)
        state = g.group(1) if g else "?"
        # RememberTime window inside this event
        w = re.search(
            r'name="startTime" type="int64" value="(\d+)"'
            r"(?:(?!name=\"startTime\").)*?"
            r'name="endTime" type="int64" value="(\d+)"',
            seg[:60000],
            re.S,
        )
        if not w:
            w = re.search(
                r'name="endTime" type="int64" value="(\d+)"'
                r"(?:(?!name=\"endTime\").)*?"
                r'name="startTime" type="int64" value="(\d+)"',
                seg[:60000],
                re.S,
            )
            if w:
                start, end = w.group(2), w.group(1)
            else:
                start = end = None
        else:
            start, end = w.group(1), w.group(2)

        def fmt(ts):
            if not ts or ts == "0":
                return "-"
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime(
                "%Y-%m-%d %H:%M"
            )

        print(f"{name:32s} state={state:12s} {fmt(start)} -> {fmt(end)}")

    # remember-time entries elsewhere (event schedule history)
    print("\n-- gameEventRememberTime entries --")
    for m in re.finditer(
        r'name="eventId" type="string" value="([^"]+)"', c
    ):
        eid = m.group(1)
        seg = c[max(0, m.start() - 400):m.start() + 400]
        s = re.search(r'name="startTime" type="int64" value="(\d+)"', seg)
        e = re.search(r'name="endTime" type="int64" value="(\d+)"', seg)

        def fmt(ts):
            if not ts or ts == "0":
                return "-"
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime(
                "%Y-%m-%d %H:%M"
            )

        print(f"{eid:32s} {fmt(s.group(1) if s else None)} -> "
              f"{fmt(e.group(1) if e else None)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
