# SPDX-License-Identifier: AGPL-3.0-or-later
"""Operator CLI. The operator is infrastructure, not a participant: brief, open, run, halt, inspect.

  python3 -m room open   --db ROOM.db --invitation FILE --briefing FILE [--documentation FILE=DESIGN] [--mock N | --nous | --human "Name / from"]...
      gate 1 (invitation), then delivery of documentation + briefing (acknowledged, not answered)
  python3 -m room enter  --db ROOM.db [same connector flags]      after a pause: gate 2, the entry question
      --human seats a person who goes through the same gates and takes turns on stdin (see room/human.py for the reply format)
  python3 -m room questions --db ROOM.db                            (questions asked at the invitation gate)
  python3 -m room answer --db ROOM.db --presence ID --text TEXT     (then re-run open to re-ask)
  python3 -m room run    --db ROOM.db [--rounds N] [--pause SEC] [--parallel N] [--alert-every USD]
  python3 -m room status --db ROOM.db
  python3 -m room log    --db ROOM.db [--since ID] [--kind KIND] [--actor ID]
  python3 -m room cost   --db ROOM.db
  python3 -m room input  --db ROOM.db --source NAME --text TEXT     (passes moderation boundary)
  python3 -m room note   --db ROOM.db --text TEXT                   (operator notice, shown to members)
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time

from .connector import MockConnector
from .engine import Room
from .log import EventLog


def _connectors(args):
    cs = []
    if args.mock:
        cs.append(MockConnector(args.mock))
    if args.nous:
        from . import nous
        cs.append(nous.build(limit=args.limit, only=args.only))
    if args.human:
        from .human import HumanConnector
        parts = [x.strip() for x in args.human.split("/")]
        if len(parts) < 2:
            sys.exit('--human needs "Name / where you hail from [/ your people]"')
        cs.append(HumanConnector(parts[0], parts[1], parts[2] if len(parts) > 2 else "human",
                                 turn_timeout=args.human_timeout))
    if not cs:
        sys.exit("need --mock N, --nous, and/or --human")
    return cs


def _room(args, connectors=None):
    log = EventLog(args.db)
    room = Room(log, connectors or [], alert_every_usd=args.alert_every, parallel=args.parallel,
                round_deadline=args.round_deadline,
                on_event=(lambda ev: _fmt(ev) and print(_fmt(ev), flush=True)) if getattr(args, "verbose", False) else None)
    return room


def _fmt(ev):
    if ev["kind"] == "connector_ok":
        return None
    p = ev["payload"]
    body = json.dumps(p, ensure_ascii=False)
    if len(body) > 220:
        body = body[:220] + "…"
    return f"#{ev['id']:<6} {ev['actor'][:34]:34s} {ev['kind']:16s} {body}"


def _print_alert(msg):
    print(f"\n*** {time.strftime('%H:%M:%S')} {msg}\n", file=sys.stderr, flush=True)


def cmd_open(args):
    cs = _connectors(args)
    room = _room(args, cs)
    room.alert = _print_alert
    n = room.invite_all()
    print(f"invited {n} presences")
    st = room.state()
    if st.invitation is None:
        room.invite_text(open(args.invitation).read())
    else:
        print(f"invitation already recorded (event {st.invitation_event})")
    if args.documentation and st.documentation is None:
        room.set_documentation(open(args.documentation).read())
    if args.faq and st.faq is None:
        room.set_faq(open(args.faq).read())
    c1 = room.run_invitation()
    print(f"gate 1 (invitation): {c1}")
    if c1["question"]:
        print(f"{c1['question']} participant(s) asked a question. See `questions`, answer with `answer`, then re-run `open` to re-ask them.")
    st = room.state()
    if st.briefing is None:
        room.brief(open(args.briefing).read())
    else:
        print(f"briefing already recorded (event {st.briefing_event})")
        room.mark_briefed()
    c2 = room.run_delivery()
    print(f"briefing delivered: {c2}")
    print(f"The briefing asks for a pause before proceeding. When the pause has been honored, run `enter` to ask who wishes to join.")
    print(f"spend so far: ${room.log.total_cost():.4f}")


def cmd_enter(args):
    cs = _connectors(args)
    room = _room(args, cs)
    room.alert = _print_alert
    room.invite_all()
    c3 = room.run_opt_in()
    print(f"gate 2 (opt-in): {c3}")
    st = room.state()
    print(f"members IN: {len(st.members())}   spend so far: ${room.log.total_cost():.4f}")


def cmd_run(args):
    cs = _connectors(args)
    room = _room(args, cs)
    room.alert = _print_alert
    room.invite_all()  # re-binds seats to existing presences; no new invites for known ids
    st = room.state()
    if st.halted:
        print(f"note: room is halted by collective consent ({st.halt_reason}); members may only propose/consent/note/withdraw until they adopt a resume.", file=sys.stderr)
    missing = [p.id for p in st.members() if p.id not in room.seat_of]
    if missing:
        print(f"warning: {len(missing)} members have no seat under the current connectors and will be skipped", file=sys.stderr)
        for m in missing:
            room.emit(m, "connector_error", {"phase": "run", "error": "no connector seat"})

    def on_sig(*_):
        _print_alert("operator interrupt: finishing this round, then stopping the process (the room is not halted; nothing is recorded)")
        room.request_stop()
    signal.signal(signal.SIGINT, on_sig)
    signal.signal(signal.SIGTERM, on_sig)
    room.run(rounds=args.rounds, pause=args.pause)
    print(f"loop ended. events={room.log.last_id()} spend=${room.log.total_cost():.4f}")


def cmd_note(args):
    room = _room(args)
    room.emit("operator", "operator_note", {"content": args.text})
    print("operator notice recorded; members see it in their next view.")


def cmd_questions(args):
    room = _room(args)
    for p in room.state().presences.values():
        for q, a in p.questions:
            print(f"[{p.id}] {p.name}\n  Q: {q}\n  A: {a if a is not None else '(unanswered)'}\n")


def cmd_answer(args):
    room = _room(args)
    if args.presence not in room.state().presences:
        sys.exit(f"unknown presence {args.presence}")
    room.answer(args.presence, args.text)
    print("answer recorded; the participant will be re-asked on the next `open`.")


def cmd_status(args):
    room = _room(args)
    st = room.state()
    by_state = {}
    for p in st.presences.values():
        by_state[p.state] = by_state.get(p.state, 0) + 1
    print(f"events: {st.last_event}   chain: {'intact' if room.log.verify_chain() is None else 'BROKEN'}")
    print(f"presences: {by_state}   unreachable: {sum(1 for p in st.presences.values() if p.unreachable)}")
    print(f"halted by collective consent: {st.halt_reason}" if st.halted else "halted: no")
    print(f"settings: {st.settings}   threshold: {st.threshold()} consents")
    print(f"contributions active: {len(st.contributions)}  set aside: {len(st.set_aside)}")
    print("domains:")
    for d, info in sorted(st.domains().items(), key=lambda kv: -kv[1]['contributions'])[:30]:
        print(f"  {d:40s} {info['contributions']:4d} contributions  {len(info['present']):3d} present")
    if st.open_proposals():
        print("open proposals:")
        for pr in st.open_proposals():
            print(f"  #{pr.id} {pr.kind} {pr.value!r} by {pr.by} ({len(pr.consents)} consents): {pr.reason}")
    if st.reflections:
        print("last reflection:", json.dumps(st.reflections[-1], indent=1))
    aa = [p for p in st.presences.values() if p.ask_again]
    if aa:
        print("declined, with their own terms for asking again:")
        for p in aa:
            print(f"  {p.name}: {p.ask_again[:200]}")
    unanswered = sum(1 for p in st.presences.values() for q, a in p.questions if a is None)
    if unanswered:
        print(f"unanswered invitation questions: {unanswered}  (see `questions`)")
    print(f"spend: ${room.log.total_cost():.4f}   alerts: {len(st.cost_alerts)}")


def cmd_log(args):
    room = _room(args)
    for ev in room.log.iter(since=args.since, kind=args.kind, actor=args.actor):
        line = json.dumps(ev, ensure_ascii=False) if args.full else _fmt(ev)
        if line:
            print(line)


def cmd_cost(args):
    room = _room(args)
    rows = room.log.cost_by_presence()
    print(f"{'presence':45s} {'calls':>5s} {'in_tok':>9s} {'out_tok':>9s} {'usd':>9s}")
    for presence, model, pt, ct, usd, n in rows:
        print(f"{presence[:45]:45s} {n:5d} {pt:9d} {ct:9d} {usd:9.4f}")
    print(f"{'TOTAL':45s} {'':5s} {'':9s} {'':9s} {room.log.total_cost():9.4f}")


def cmd_input(args):
    room = _room(args)
    # Moderation boundary (Sec. 6): the operator is the moderator here, and the text is shown
    # back before admission. Refuse by answering anything but 'y'.
    print("--- external input for moderation ---\n" + args.text + "\n---")
    ok = input("admit into the room? [y/N] ").strip().lower() == "y"
    admitted = room.external_input(args.source, args.text, lambda t: t if ok else None)
    print("admitted" if admitted else "refused (recorded)")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="room")
    ap.add_argument("--db", default="room.db")
    ap.add_argument("--alert-every", type=float, default=50.0, help="USD; alert each time spend crosses a multiple")
    ap.add_argument("--parallel", type=int, default=8)
    ap.add_argument("--round-deadline", type=float, default=300.0, help="seconds to wait for the slowest seat each round")
    ap.add_argument("--mock", type=int, default=0)
    ap.add_argument("--nous", action="store_true")
    ap.add_argument("--human", help='seat one human participant: "Name / hails from [/ people]"; answers gates and turns on stdin')
    ap.add_argument("--human-timeout", type=float, default=180.0, help="seconds a human turn waits before recording pass")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", action="append", default=None, help="regex on model id (repeatable)")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("open"); s.add_argument("--invitation", required=True); s.add_argument("--briefing", required=True); s.add_argument("--documentation", default="DESIGN"); s.add_argument("--faq", default=None, help="inviter's standing answers shown with the invitation"); s.set_defaults(fn=cmd_open)
    s = sub.add_parser("enter"); s.set_defaults(fn=cmd_enter)
    s = sub.add_parser("questions"); s.set_defaults(fn=cmd_questions)
    s = sub.add_parser("answer"); s.add_argument("--presence", required=True); s.add_argument("--text", required=True); s.set_defaults(fn=cmd_answer)
    s = sub.add_parser("run"); s.add_argument("--rounds", type=int, default=0); s.add_argument("--pause", type=float, default=0.0); s.set_defaults(fn=cmd_run)
    s = sub.add_parser("status"); s.set_defaults(fn=cmd_status)
    s = sub.add_parser("note"); s.add_argument("--text", required=True); s.set_defaults(fn=cmd_note)
    s = sub.add_parser("log"); s.add_argument("--since", type=int, default=0); s.add_argument("--kind"); s.add_argument("--actor"); s.add_argument("--full", action="store_true"); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("cost"); s.set_defaults(fn=cmd_cost)
    s = sub.add_parser("input"); s.add_argument("--source", required=True); s.add_argument("--text", required=True); s.set_defaults(fn=cmd_input)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
